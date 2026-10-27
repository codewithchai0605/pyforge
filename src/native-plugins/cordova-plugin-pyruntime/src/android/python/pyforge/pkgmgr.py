"""One-click package install/uninstall for PyForge (a tiny, mobile-friendly pip).

Why not just run pip? Chaquopy ships no pip at runtime (packages are normally
baked into the APK at build time), and pip's resolver/build machinery is far
too heavy for a phone. This module does the useful 95 %:

  1. look a project up on PyPI (PEP 691 JSON "simple" API), and, if PyPI has
     nothing loadable on Android, on Chaquopy's wheel index;
  2. pick the newest *wheel* this device can load (see tags.py);
  3. download it (sha256-verified), read its METADATA for dependencies,
     recurse;
  4. unzip into <app files>/pyforge/site-packages, which both the editor's
     runner and the package manager put on sys.path.

Limits worth knowing: wheels only (no building sdists on a phone); no full
backtracking resolver (conflicting pins are reported, not solved); native
wheels at runtime depend on Chaquopy-compatible builds being available.
"""

from __future__ import annotations

import difflib
import email.parser
import gzip
import hashlib
import json
import math
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Callable, Optional
from urllib.parse import urljoin, urldefrag

from packaging.markers import default_environment
from packaging.requirements import InvalidRequirement, Requirement
from packaging.specifiers import SpecifierSet
from packaging.utils import (
    InvalidWheelFilename,
    canonicalize_name,
    parse_wheel_filename,
)
from packaging.version import InvalidVersion, Version

from . import tags

Progress = Callable[[dict], None]

PYPI_URL = os.environ.get("PYFORGE_PYPI_URL", "https://pypi.org/simple/")
# Chaquopy's curated index of Android builds (numpy, pandas, pillow, ...).
CHAQUO_URL = os.environ.get("PYFORGE_CHAQUO_URL", "https://chaquo.com/pypi-13.1/")
# The JSON API (project metadata), the release feed (a ~1 KB way to learn the
# newest versions: the full JSON of a project like boto3 is 700 KB) and the
# monthly "most downloaded projects" list that powers search. PyPI's own search
# page sits behind a bot challenge, and its search API was switched off years
# ago, so searching is done here, against a local copy of that list.
PYPI_JSON_URL = os.environ.get("PYFORGE_PYPI_JSON_URL", "https://pypi.org/pypi/")
PYPI_RSS_URL = os.environ.get("PYFORGE_PYPI_RSS_URL", "https://pypi.org/rss/project/")
TOP_URL = os.environ.get(
    "PYFORGE_TOP_URL",
    "https://raw.githubusercontent.com/hugovk/top-pypi-packages/main/top-pypi-packages.min.json",
)
INDEX_MAX_AGE_S = 7 * 24 * 3600  # re-download the name list weekly
META_MAX_AGE_S = 3 * 24 * 3600  # keep a package's summary for three days
USER_AGENT = "PyForge/0.1 (+package-manager)"
TIMEOUT = 15  # per socket operation; also bounds how long a Cancel can wait on a stalled connection


class PkgError(Exception):
    """A problem worth showing to the user verbatim."""


class Cancelled(PkgError):
    """The user cancelled the operation. Nothing was installed or changed."""


# One package operation runs at a time (the Kotlin side serialises them), so a
# single process-wide flag is enough. It is set from another thread (the
# Cancel button) and polled at every network step.
_cancel = threading.Event()


def request_cancel() -> None:
    _cancel.set()


def _check_cancel() -> None:
    if _cancel.is_set():
        raise Cancelled("Cancelled")


# ---------------------------------------------------------------- helpers


def _site() -> str:
    site = os.environ.get("PYFORGE_SITE")
    if not site:
        raise PkgError("PYFORGE_SITE is not configured")
    os.makedirs(site, exist_ok=True)
    return site


def _cache_dir() -> str:
    d = os.path.join(os.environ.get("PYFORGE_CACHE") or tempfile.gettempdir(), "wheels")
    os.makedirs(d, exist_ok=True)
    return d


def _open(url: str, accept: Optional[str] = None, compress: bool = False):
    headers = {"User-Agent": USER_AGENT}
    if accept:
        headers["Accept"] = accept
    if compress:
        headers["Accept-Encoding"] = "gzip"
    req = urllib.request.Request(url, headers=headers)
    last: Optional[Exception] = None
    for attempt in range(3):
        _check_cancel()
        try:
            return urllib.request.urlopen(req, timeout=TIMEOUT)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise
            last = e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = e
        time.sleep(0.4 * (attempt + 1))
    assert last is not None
    raise last


@dataclass
class WheelFile:
    filename: str
    url: str
    sha256: Optional[str]
    requires_python: Optional[str]
    yanked: bool
    version: Version
    rank: int
    source: str  # "pypi" | "chaquopy"
    size: Optional[int] = None


# -------------------------------------------------------- index clients


def _fetch_pypi_files(name: str) -> list[dict]:
    url = urljoin(PYPI_URL, canonicalize_name(name) + "/")
    try:
        with _open(url, "application/vnd.pypi.simple.v1+json") as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []
        raise
    out = []
    for f in data.get("files", []):
        out.append(
            {
                "filename": f["filename"],
                "url": urljoin(url, f["url"]),
                "sha256": (f.get("hashes") or {}).get("sha256"),
                "requires_python": f.get("requires-python"),
                "yanked": bool(f.get("yanked")),
                "size": f.get("size"),
            }
        )
    return out


class _LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[tuple[str, str, dict]] = []
        self._href: Optional[str] = None
        self._attrs: dict = {}
        self._text = ""

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self._attrs = dict(attrs)
            self._href = self._attrs.get("href")
            self._text = ""

    def handle_data(self, data):
        if self._href is not None:
            self._text += data

    def handle_endtag(self, tag):
        if tag == "a" and self._href is not None:
            self.links.append((self._href, self._text.strip(), self._attrs))
            self._href = None


def _fetch_chaquo_files(name: str) -> list[dict]:
    url = urljoin(CHAQUO_URL, canonicalize_name(name) + "/")
    try:
        with _open(url) as resp:
            html = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []
        raise
    except (urllib.error.URLError, OSError):
        # The Chaquopy index is a bonus source; an outage must not break
        # installing pure-Python packages from PyPI.
        return []
    parser = _LinkParser()
    parser.feed(html)
    out = []
    for href, text, attrs in parser.links:
        full, frag = urldefrag(urljoin(url, href))
        filename = text or full.rsplit("/", 1)[-1]
        if not filename.endswith(".whl"):
            continue
        out.append(
            {
                "filename": filename,
                "url": full,
                "sha256": (
                    frag[len("sha256=") :] if frag.startswith("sha256=") else None
                ),
                "requires_python": attrs.get("data-requires-python"),
                "yanked": "data-yanked" in attrs,
                "size": None,
            }
        )
    return out


def _newest_release(files: list[dict]) -> Optional[Version]:
    """Newest non-yanked, non-pre-release version that has *any* wheel.

    Used only to warn when what this device can load is much older than what
    exists (e.g. every recent release is native-only).
    """
    newest: Optional[Version] = None
    for f in files:
        if f["yanked"] or not f["filename"].endswith(".whl"):
            continue
        try:
            version = parse_wheel_filename(f["filename"])[1]
        except (InvalidWheelFilename, InvalidVersion):
            continue
        if version.is_prerelease:
            continue
        if newest is None or version > newest:
            newest = version
    return newest


def _usable(files: list[dict], source: str) -> list[WheelFile]:
    py = Version(".".join(map(str, sys.version_info[:3])))
    result = []
    for f in files:
        if not f["filename"].endswith(".whl") or f["yanked"]:
            continue
        try:
            _, version, _, wtags = parse_wheel_filename(f["filename"])
        except (InvalidWheelFilename, InvalidVersion):
            continue
        rp = f.get("requires_python")
        if rp:
            try:
                if not SpecifierSet(rp).contains(py, prereleases=True):
                    continue
            except Exception:  # unparsable specifier: don't exclude on a guess
                pass
        rank = tags.wheel_rank(wtags)
        if rank is None:
            continue
        result.append(
            WheelFile(
                f["filename"],
                f["url"],
                f.get("sha256"),
                rp,
                False,
                version,
                rank,
                source,
                f.get("size"),
            )
        )
    return result


def _candidates(
    name: str, log: Progress
) -> tuple[list[WheelFile], bool, Optional[Version]]:
    """Loadable wheels for `name`, whether the project exists, newest release."""
    raw = _fetch_pypi_files(name)
    exists = bool(raw)
    newest = _newest_release(raw)
    found = _usable(raw, "pypi")
    # Look in Chaquopy's index when PyPI has no loadable wheel (the numpy /
    # pillow / pandas case) — on Android only; a desktop host has no use for
    # Android wheels.
    if not found and tags.is_android():
        extra = _fetch_chaquo_files(name)
        exists = exists or bool(extra)
        found = _usable(extra, "chaquopy")
        chaquo_newest = _newest_release(extra)
        if chaquo_newest and (newest is None or chaquo_newest > newest):
            newest = chaquo_newest
    return found, exists, newest


def _staleness_note(
    name: str, pick: "WheelFile", newest: Optional[Version]
) -> Optional[str]:
    """Warn when the loadable release is a major version (or more) behind."""
    if newest is None or pick.version.major >= newest.major:
        return None
    return (
        f"The newest {name} ({newest}) can't run on this device; the newest that can is "
        f"{pick.version}, which is much older and may not be what you want."
    )


def _choose(cands: list[WheelFile], spec: SpecifierSet) -> Optional[WheelFile]:
    pool = [c for c in cands if spec.contains(c.version, prereleases=False)]
    if not pool:  # allow a pre-release only if nothing stable satisfies
        pool = [c for c in cands if spec.contains(c.version, prereleases=True)]
    if not pool:
        return None
    # Newest version first; within a version the best-ranked (pure beats
    # native, exact ABI beats abi3).
    return max(pool, key=lambda c: (c.version, -c.rank))


# ------------------------------------------------------ installed state


def _site_dists() -> dict[str, tuple[str, str]]:
    """canonical name -> (version, dist-info dir) for what *we* installed."""
    site = _site()
    out: dict[str, tuple[str, str]] = {}
    for entry in os.listdir(site):
        if not entry.endswith(".dist-info"):
            continue
        stem = entry[: -len(".dist-info")]
        if "-" not in stem:
            continue
        name, version = stem.rsplit("-", 1)
        out[canonicalize_name(name)] = (version, os.path.join(site, entry))
    return out


def _builtin_dists() -> dict[str, str]:
    """Packages baked into the APK (best effort: importlib.metadata)."""
    out: dict[str, str] = {}
    try:
        from importlib import metadata

        site = os.path.realpath(_site())
        for dist in metadata.distributions():
            name = dist.metadata["Name"] if dist.metadata else None
            if not name:
                continue
            loc = os.path.realpath(str(getattr(dist, "_path", "") or ""))
            if loc.startswith(site):
                continue
            out[canonicalize_name(name)] = dist.version
    except Exception:  # noqa: BLE001
        pass
    return out


def _installed_version(name: str) -> Optional[str]:
    n = canonicalize_name(name)
    site = _site_dists()
    if n in site:
        return site[n][0]
    return _builtin_dists().get(n)


def list_installed() -> list[dict]:
    items = []
    for name, (version, info_dir) in sorted(_site_dists().items()):
        summary, requires = _read_metadata_dir(info_dir)
        items.append(
            {
                "name": name,
                "version": version,
                "removable": True,
                "summary": summary,
                "requires": requires,
            }
        )
    seen = {i["name"] for i in items}
    for name, version in sorted(_builtin_dists().items()):
        if name not in seen and name not in ("pip", "setuptools", "wheel"):
            items.append(
                {
                    "name": name,
                    "version": version,
                    "removable": False,
                    "summary": "",
                    "requires": [],
                }
            )
    return items


def _read_metadata_dir(info_dir: str) -> tuple[str, list[str]]:
    try:
        with open(
            os.path.join(info_dir, "METADATA"), encoding="utf-8", errors="replace"
        ) as f:
            msg = email.parser.Parser().parse(f, headersonly=True)
        reqs = []
        for r in msg.get_all("Requires-Dist") or []:
            try:
                reqs.append(canonicalize_name(Requirement(r).name))
            except InvalidRequirement:
                pass
        return msg.get("Summary", "") or "", sorted(set(reqs))
    except OSError:
        return "", []


# ------------------------------------------------------------- lookup


def lookup(spec: str, progress: Progress = lambda e: None) -> dict:
    """Is this installable on this device, and what would we get?"""
    req = _parse_req(spec)
    cands, exists, newest = _candidates(req.name, progress)
    if not exists:
        return {
            "name": req.name,
            "status": "not_found",
            "message": f"“{req.name}” was not found on PyPI.",
        }
    pick = _choose(cands, req.specifier)
    if pick is None:
        return {
            "name": req.name,
            "status": "no_android_wheel" if tags.is_android() else "no_wheel",
            "message": (
                f"{req.name} has no wheel that can run on this device. It probably needs compiled code "
                "that isn't available for Android yet. You can bake it into the app at build time "
                "(python/requirements.txt) if Chaquopy supports it."
            ),
        }
    return {
        "name": canonicalize_name(req.name),
        "version": str(pick.version),
        "status": "ok",
        "kind": "pure" if pick.rank == 0 else "native",
        "source": pick.source,
        "size": pick.size,
        "installed": _installed_version(req.name),
        "filename": pick.filename,
        "note": _staleness_note(req.name, pick, newest),
    }


# ------------------------------------------------------------ install


def _parse_req(spec: str) -> Requirement:
    spec = spec.strip()
    if not spec:
        raise PkgError("Enter a package name.")
    try:
        return Requirement(spec)
    except InvalidRequirement:
        raise PkgError(
            f"“{spec}” isn't a valid package requirement (try e.g. requests or numpy>=1.26)."
        ) from None


def _download(wheel: WheelFile, progress: Progress) -> str:
    dest = os.path.join(_cache_dir(), wheel.filename)
    if os.path.exists(dest) and _sha_ok(dest, wheel.sha256):
        return dest
    tmp = dest + ".part"
    sha = hashlib.sha256()
    done = 0
    last = 0.0
    try:
        with _open(wheel.url) as resp, open(tmp, "wb") as out:
            total = int(resp.headers.get("Content-Length") or wheel.size or 0)
            while True:
                _check_cancel()
                # read1(), not read(): read(n) waits for all n bytes, which on a
                # slow link would make the progress bar and Cancel respond only
                # every few seconds. read1() returns as soon as *some* data arrived.
                chunk = resp.read1(64 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                sha.update(chunk)
                done += len(chunk)
                now = time.time()
                if now - last > 0.1:
                    last = now
                    progress(
                        {
                            "t": "dl",
                            "file": wheel.filename,
                            "done": done,
                            "total": total,
                        }
                    )
    except BaseException:
        # Cancelled, offline, or anything else: never leave a truncated file
        # behind that a later run might mistake for a download in progress.
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    progress({"t": "dl", "file": wheel.filename, "done": done, "total": done})
    if wheel.sha256 and sha.hexdigest() != wheel.sha256.lower():
        os.remove(tmp)
        raise PkgError(
            f"Checksum mismatch for {wheel.filename}; the download was corrupted. Try again."
        )
    os.replace(tmp, dest)
    return dest


def _sha_ok(path: str, expected: Optional[str]) -> bool:
    if not expected:
        return False  # can't vouch for a cached file we have no hash for
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest() == expected.lower()


def _wheel_requirements(path: str, extras: set[str]) -> list[Requirement]:
    with zipfile.ZipFile(path) as z:
        meta_name = next(
            (
                n
                for n in z.namelist()
                if n.endswith(".dist-info/METADATA") and n.count("/") == 1
            ),
            None,
        )
        if not meta_name:
            return []
        msg = email.parser.Parser().parsestr(
            z.read(meta_name).decode("utf-8", "replace"), headersonly=True
        )
    env = default_environment()
    out = []
    for line in msg.get_all("Requires-Dist") or []:
        try:
            r = Requirement(line)
        except InvalidRequirement:
            continue
        if r.marker is None:
            out.append(r)
            continue
        for extra in extras | {""}:
            if r.marker.evaluate({**env, "extra": extra}):
                out.append(r)
                break
    return out


def _safe_join(root: str, member: str) -> str:
    target = os.path.normpath(os.path.join(root, member))
    if not (target == root or target.startswith(root + os.sep)):
        raise PkgError(f"Refusing to unpack unsafe path from wheel: {member}")
    return target


def _unpack(wheel_path: str, site: str) -> tuple[str, str]:
    """Extract a wheel into `site`. Returns (name, version)."""
    root = os.path.realpath(site)
    staging = tempfile.mkdtemp(prefix="unpack-", dir=_cache_dir())
    try:
        with zipfile.ZipFile(wheel_path) as z:
            z.testzip()
            for info in z.infolist():
                if info.is_dir():
                    continue
                dest = _safe_join(staging, info.filename)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with z.open(info) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)
                # keep exec bit for shared libraries / scripts
                mode = (info.external_attr >> 16) & 0o777
                if mode:
                    os.chmod(dest, mode | 0o600)
        dist_infos = [d for d in os.listdir(staging) if d.endswith(".dist-info")]
        if len(dist_infos) != 1:
            raise PkgError("Wheel is malformed (no single .dist-info directory).")
        name, version = dist_infos[0][: -len(".dist-info")].rsplit("-", 1)

        # `<pkg>-<ver>.data/{purelib,platlib}` hold files that belong in
        # site-packages itself; scripts/headers/data are irrelevant here.
        data_dir = os.path.join(staging, f"{dist_infos[0][:-len('.dist-info')]}.data")
        if os.path.isdir(data_dir):
            for scheme in ("purelib", "platlib"):
                src = os.path.join(data_dir, scheme)
                if os.path.isdir(src):
                    shutil.copytree(src, staging, dirs_exist_ok=True)
            shutil.rmtree(data_dir)

        # Replace any previous version first so no stale files linger.
        _remove_dist(canonicalize_name(name))
        for entry in os.listdir(staging):
            target = os.path.join(root, entry)
            if os.path.isdir(target) and os.path.isdir(os.path.join(staging, entry)):
                shutil.copytree(
                    os.path.join(staging, entry), target, dirs_exist_ok=True
                )
            else:
                shutil.move(os.path.join(staging, entry), target)
        with open(os.path.join(root, dist_infos[0], "INSTALLER"), "w") as f:
            f.write("pyforge\n")
        _record_native_libs(root, dist_infos[0])
        return name, version
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _record_native_libs(site: str, dist_info: str) -> None:
    """Remember shared libraries that other wheels' extensions link against.

    Chaquopy ships non-Python libraries (libopenblas, libc++ ...) as ordinary
    wheels whose .so files sit under `chaquopy/lib/`. Android's dynamic linker
    won't search there, so the runner pre-loads them (see runner/preload).
    """
    libdir = os.path.join(site, "chaquopy", "lib")
    if not os.path.isdir(libdir):
        return
    libs = sorted(f for f in os.listdir(libdir) if ".so" in f)
    path = os.path.join(site, "pyforge_preload.json")
    try:
        with open(path) as f:
            known = json.load(f)
    except (OSError, ValueError):
        known = []
    merged = sorted(set(known) | {os.path.join("chaquopy", "lib", l) for l in libs})
    with open(path, "w") as f:
        json.dump(merged, f)


def install(specs: list[str], progress: Progress = lambda e: None) -> dict:
    site = _site()
    _cancel.clear()
    log = lambda s: progress({"t": "log", "s": s})  # noqa: E731
    requested = [_parse_req(s) for s in specs]

    # name -> merged specifier / extras; name -> chosen wheel (+ local path)
    wanted: dict[str, SpecifierSet] = {}
    extras: dict[str, set[str]] = {}
    chosen: dict[str, tuple[WheelFile, str]] = {}
    queue: list[Requirement] = list(requested)
    installed: list[dict] = []
    skipped: list[str] = []

    while queue:
        _check_cancel()
        req = queue.pop(0)
        key = canonicalize_name(req.name)
        wanted[key] = wanted.get(key, SpecifierSet()) & req.specifier
        extras.setdefault(key, set()).update(req.extras)

        if key in chosen:
            if wanted[key].contains(chosen[key][0].version, prereleases=True):
                continue
            log(f"Re-selecting {key} to satisfy {wanted[key]}")
            del chosen[key]

        have = _installed_version(key)
        if have and wanted[key].contains(Version(have), prereleases=True):
            log(f"Requirement already satisfied: {key} ({have})")
            skipped.append(key)
            continue

        log(f"Collecting {req.name}{req.specifier if str(req.specifier) else ''}")
        cands, exists, newest = _candidates(key, progress)
        if not exists:
            raise PkgError(f"“{req.name}” was not found on PyPI.")
        pick = _choose(cands, wanted[key])
        if pick is None:
            raise PkgError(
                f"No version of {req.name} satisfying “{wanted[key] or 'any'}” can run on this device "
                "(only wheels built for Android or pure-Python wheels can be installed). "
                "Adding it to python/requirements.txt will only help if a compatible Android wheel exists "
                "for this app's Python version."
            )
        kind = "pure-Python" if pick.rank == 0 else "native"
        log(f"  Using {pick.filename} ({kind}, from {pick.source})")
        note = _staleness_note(key, pick, newest)
        if note:
            log(f"  Warning: {note}")
        local = _download(pick, progress)
        chosen[key] = (pick, local)
        queue.extend(_wheel_requirements(local, extras[key]))

    # Last chance to back out: everything is downloaded and verified, nothing
    # has touched site-packages yet. Past this point the (fast, local) unpack
    # runs to completion so we never leave a half-installed package.
    _check_cancel()
    for key, (wheel, local) in chosen.items():
        log(f"Installing {key} {wheel.version}")
        name, version = _unpack(local, site)
        installed.append({"name": canonicalize_name(name), "version": version})

    if sys.modules.get("importlib"):
        import importlib

        importlib.invalidate_caches()
    log("Done." if installed else "Nothing to install.")
    return {"installed": installed, "skipped": skipped}


# ---------------------------------------------------------- uninstall


def _dependents(name: str) -> list[str]:
    n = canonicalize_name(name)
    out = []
    for other, (_, info_dir) in _site_dists().items():
        if other != n and n in _read_metadata_dir(info_dir)[1]:
            out.append(other)
    return sorted(out)


def _remove_dist(canon: str) -> int:
    dists = _site_dists()
    if canon not in dists:
        return 0
    _, info_dir = dists[canon]
    site = os.path.realpath(_site())
    removed = 0
    record = os.path.join(info_dir, "RECORD")
    dirs: set[str] = set()
    if os.path.exists(record):
        with open(record, encoding="utf-8", errors="replace") as f:
            for line in f:
                rel = line.split(",", 1)[0].strip().strip('"')
                if not rel:
                    continue
                try:
                    path = _safe_join(site, rel)
                except PkgError:
                    continue
                if os.path.isfile(path) or os.path.islink(path):
                    os.remove(path)
                    removed += 1
                    dirs.add(os.path.dirname(path))
    shutil.rmtree(info_dir, ignore_errors=True)
    # Tidy now-empty package directories, deepest first. Python writes
    # __pycache__/*.pyc next to the sources at import time; those were never
    # in the wheel's RECORD, so they'd otherwise keep every directory alive.
    for d in sorted(dirs, key=len, reverse=True):
        cur = d
        while cur.startswith(site + os.sep):
            shutil.rmtree(os.path.join(cur, "__pycache__"), ignore_errors=True)
            try:
                os.rmdir(cur)
            except OSError:
                break
            cur = os.path.dirname(cur)
    return removed


def uninstall(name: str, progress: Progress = lambda e: None) -> dict:
    canon = canonicalize_name(name)
    if canon not in _site_dists():
        if canon in _builtin_dists():
            raise PkgError(
                f"{canon} is built into the app and can't be removed here. "
                "Remove it from python/requirements.txt and rebuild."
            )
        raise PkgError(f"{canon} isn't installed.")
    deps = _dependents(canon)
    progress({"t": "log", "s": f"Uninstalling {canon}"})
    files = _remove_dist(canon)
    if deps:
        progress({"t": "log", "s": f"Note: still required by {', '.join(deps)}"})
    progress({"t": "log", "s": f"Removed {files} files."})
    return {"removed": canon, "files": files, "dependents": deps}


# ================================================== search & package details
#
# Searching never touches PyPI's search page (it is behind a bot challenge) and
# never downloads whole project pages for a result list. Instead:
#
#   * a ~170 KB gzip list of the 15,000 most downloaded projects is fetched
#     once, kept on disk, and searched locally (instant, works offline);
#   * a result's one-line summary comes from PyPI's *per-version* JSON, which is
#     about 4 KB, found through the project's release feed (~1 KB);
#   * any project name you type exactly can still be looked up, even if it is
#     not in the top 15,000.


def _cache_root() -> str:
    d = os.environ.get("PYFORGE_CACHE") or tempfile.gettempdir()
    os.makedirs(d, exist_ok=True)
    return d


def _index_dir() -> str:
    d = os.path.join(_cache_root(), "index")
    os.makedirs(d, exist_ok=True)
    return d


def _read_body(resp) -> bytes:
    data = resp.read()
    if resp.headers.get("Content-Encoding") == "gzip":
        data = gzip.decompress(data)
    return data


def _get_json(url: str) -> dict:
    with _open(url, "application/json", compress=True) as resp:
        return json.loads(_read_body(resp).decode("utf-8"))


def _write_json_atomic(path: str, obj: object) -> None:
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)


# ------------------------------------------------------------ name index

_index_mem: dict = {}  # {"stamp": (mtime, size), "data": {...}}


def _index_path() -> str:
    return os.path.join(_index_dir(), "top.json")


def _read_index_file() -> Optional[dict]:
    path = _index_path()
    try:
        st = os.stat(path)
    except OSError:
        return None
    stamp = (st.st_mtime_ns, st.st_size)
    if _index_mem.get("stamp") == stamp and _index_mem.get("path") == path:
        return _index_mem["data"]
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if data.get("v") != 1 or len(data["names"]) != len(data["dl"]):
            return None
    except (OSError, ValueError, KeyError):
        return None
    data["keys"] = [canonicalize_name(n) for n in data["names"]]
    _index_mem.update(stamp=stamp, path=path, data=data)
    return data


def index_status() -> dict:
    """What the local name list looks like, without touching the network."""
    data = _read_index_file()
    if not data:
        return {
            "available": False,
            "count": 0,
            "fetched": None,
            "ageDays": None,
            "lastUpdate": None,
        }
    age = max(0.0, time.time() - data["fetched"])
    return {
        "available": True,
        "count": len(data["names"]),
        "fetched": data["fetched"],
        "ageDays": round(age / 86400, 2),
        "lastUpdate": data.get("last_update"),
    }


def _download_index(progress: Progress) -> dict:
    progress({"t": "log", "s": "Downloading the package list…"})
    with _open(TOP_URL, "application/json", compress=True) as resp:
        total = int(resp.headers.get("Content-Length") or 0) or None
        chunks, done = [], 0
        while True:
            _check_cancel()
            chunk = resp.read(32 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
            done += len(chunk)
            progress({"t": "dl", "file": "package list", "done": done, "total": total})
        raw = b"".join(chunks)
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
    try:
        payload = json.loads(raw.decode("utf-8"))
        rows = payload["rows"]
        names = [str(r["project"]) for r in rows]
        dl = [int(r.get("download_count") or 0) for r in rows]
    except (ValueError, KeyError, TypeError) as e:
        raise PkgError("The package list had an unexpected format.") from e
    if not names:
        raise PkgError("The package list was empty.")
    data = {
        "v": 1,
        "fetched": time.time(),
        "last_update": payload.get("last_update"),
        "names": names,
        "dl": dl,
    }
    _write_json_atomic(_index_path(), data)
    return data


def _load_index(progress: Progress, refresh: bool = False) -> dict:
    data = _read_index_file()
    fresh = bool(data) and (time.time() - data["fetched"]) < INDEX_MAX_AGE_S
    if data and fresh and not refresh:
        return data
    try:
        _download_index(progress)
    except Cancelled:
        raise
    except (
        urllib.error.URLError,
        TimeoutError,
        ConnectionError,
        OSError,
        PkgError,
    ) as e:
        if data:  # offline, or the host is down: a stale list is still a good list
            progress(
                {
                    "t": "log",
                    "s": f"Using the saved package list (couldn't refresh it: {e})",
                }
            )
            return data
        raise PkgError(
            "Couldn't download the package list to search in (are you offline?). "
            "You can still install a package by typing its exact name."
        ) from e
    loaded = _read_index_file()
    assert loaded is not None
    return loaded


def refresh_index(progress: Progress = lambda e: None) -> dict:
    _cancel.clear()
    _load_index(progress, refresh=True)
    return index_status()


# ------------------------------------------------------------- metadata

_BADGE = re.compile(
    r"^\s*(\[!\[|!\[|<img|<a |</a>|<p |</p>|<div|</div>|<br|\.\. |:[a-z-]+:)", re.I
)  # badges, html, and reStructuredText directives with their options (".. image::", ":target:")
_RULE = re.compile(r"^[\s=\-~`*#_^+.]+$")


def _excerpt(text: str, limit: int = 700) -> str:
    """The first readable paragraphs of a project's README, without badges and rulers."""
    keep: list[str] = []
    for line in (text or "").splitlines():
        if _BADGE.match(line) or (_RULE.match(line) and line.strip()):
            continue
        line = re.sub(r"^#+\s*", "", line.rstrip())
        line = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", line)
        line = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", line)
        keep.append(line)
    out = re.sub(r"\n{3,}", "\n\n", "\n".join(keep)).strip()
    if len(out) <= limit:
        return out
    cut = out[:limit].rsplit(" ", 1)[0].rstrip(".,;:")
    return cut + "…"


def _release_versions(name: str) -> Optional[list[str]]:
    """Recent release versions from the project's feed (newest first), or None if there is no usable feed."""
    url = urljoin(PYPI_RSS_URL, canonicalize_name(name) + "/releases.xml")
    try:
        with _open(url, compress=True) as resp:
            body = _read_body(resp).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    titles = re.findall(r"<item>.*?<title>([^<]+)</title>", body, re.S)
    out = []
    for t in titles:
        t = t.strip()
        try:
            Version(t)
        except InvalidVersion:
            continue
        out.append(t)
    return out or None


def _latest(versions: list[str]) -> str:
    parsed = sorted(
        ((Version(v), v) for v in versions), key=lambda p: p[0], reverse=True
    )
    for v, raw in parsed:
        if not v.is_prerelease:
            return raw
    return parsed[0][1]


class _NotFound(Exception):
    pass


def _license(info: dict) -> Optional[str]:
    lic = (info.get("license_expression") or "").strip()
    if not lic:
        raw = (info.get("license") or "").strip()
        lic = raw.splitlines()[0].strip() if raw else ""
        if len(lic) > 60:  # the whole licence text pasted into the field
            lic = ""
    return lic or None


def _fetch_meta(name: str, version: Optional[str] = None) -> dict:
    """Summary + details of one release, in as few bytes as PyPI allows."""
    canon = canonicalize_name(name)
    versions = _release_versions(canon)
    info: Optional[dict] = None
    try:
        if versions is None:
            # No feed (a mirror, or a project the feed doesn't know): the full JSON is the fallback.
            full = _get_json(urljoin(PYPI_JSON_URL, canon + "/json"))
            all_versions = [v for v, files in full.get("releases", {}).items() if files]
            versions = (
                sorted(all_versions, key=Version, reverse=True)[:40]
                if all_versions
                else [full["info"]["version"]]
            )
            if version in (None, full["info"]["version"]):
                info = full["info"]
                version = full["info"]["version"]
        target = version or _latest(versions)
        if info is None:
            info = _get_json(urljoin(PYPI_JSON_URL, f"{canon}/{target}/json"))["info"]
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise _NotFound() from e
        raise

    requires: list[str] = []
    for r in info.get("requires_dist") or []:
        try:
            req = Requirement(r)
        except InvalidRequirement:
            continue
        if req.marker is not None:
            try:
                if not req.marker.evaluate({"extra": ""}):
                    continue
            except (
                Exception
            ):  # noqa: BLE001 - a marker we can't evaluate: keep the dependency
                pass
        requires.append(canonicalize_name(req.name))

    links, seen = [], set()
    candidates = list((info.get("project_urls") or {}).items()) + [
        ("Homepage", info.get("home_page") or "")
    ]
    for label, url in candidates:
        if url and url.startswith(("http://", "https://")) and url not in seen:
            seen.add(url)
            links.append({"label": label, "url": url})

    stable = [v for v in versions if not Version(v).is_prerelease]
    return {
        "name": info.get("name") or name,
        "version": info.get("version") or version,
        "versions": (stable or versions)[:15],
        "summary": (info.get("summary") or "").strip(),
        "description": _excerpt(info.get("description") or ""),
        "requiresPython": info.get("requires_python") or None,
        "license": _license(info),
        "author": (info.get("author") or "").strip() or None,
        "links": links,
        "requires": sorted(set(requires)),
        "yanked": bool(info.get("yanked")),
    }


# ----------------------------------------------------- summaries (cached)


def _meta_path() -> str:
    return os.path.join(_index_dir(), "meta.json")


def _meta_load() -> dict:
    try:
        with open(_meta_path(), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _meta_save(cache: dict) -> None:
    if len(cache) > 3000:  # keep the newest entries
        keep = sorted(cache.items(), key=lambda kv: kv[1].get("t", 0), reverse=True)[
            :2000
        ]
        cache = dict(keep)
    try:
        _write_json_atomic(_meta_path(), cache)
    except OSError:
        pass  # a read-only cache is a missed optimisation, not an error


def summaries(names: list[str], progress: Progress = lambda e: None) -> dict:
    """{name: {"summary", "version"}} for up to 40 names; names that could not be fetched are null."""
    _cancel.clear()
    cache = _meta_load()
    now = time.time()
    out: dict[str, Optional[dict]] = {}
    todo: list[str] = []
    for n in names[:40]:
        entry = cache.get(canonicalize_name(n))
        if entry and now - entry.get("t", 0) < META_MAX_AGE_S:
            out[n] = {
                "summary": entry.get("summary", ""),
                "version": entry.get("version"),
            }
        else:
            todo.append(n)

    def one(n: str) -> tuple[str, Optional[dict]]:
        try:
            meta = _fetch_meta(n)
        except Cancelled:
            raise
        except (
            Exception
        ):  # noqa: BLE001 - offline / not found: this row just has no summary
            return n, None
        return n, {"summary": meta["summary"], "version": meta["version"]}

    if todo:
        with ThreadPoolExecutor(max_workers=4) as pool:
            for n, res in pool.map(one, todo):
                out[n] = res
                if res is not None:
                    cache[canonicalize_name(n)] = {"t": now, **res}
        _meta_save(cache)
    return out


# ------------------------------------------------------------- search


def _installed_map() -> dict[str, str]:
    have = {k: v for k, v in _builtin_dists().items()}
    have.update({k: v[0] for k, v in _site_dists().items()})
    return have


def _score(key: str, tokens: list[str]) -> Optional[tuple[int, str]]:
    total, worst = 0, "exact"
    order = ["exact", "prefix", "word", "substring"]
    parts = key.split("-")
    for t in tokens:
        if key == t:
            s, kind = 1000, "exact"
        elif key.startswith(t):
            s, kind = 700, "prefix"
        elif any(p.startswith(t) for p in parts):
            s, kind = 500, "word"
        elif t in key:
            s, kind = 300, "substring"
        else:
            return None
        total += s
        if order.index(kind) > order.index(worst):
            worst = kind
    return total // len(tokens), worst


def search(
    query: str, limit: int = 30, offset: int = 0, progress: Progress = lambda e: None
) -> dict:
    """Find projects by name. An empty query lists the most downloaded ones."""
    _cancel.clear()
    q = (query or "").strip()
    idx = _load_index(progress)
    names, downloads, keys = idx["names"], idx["dl"], idx["keys"]
    have = _installed_map()
    cache = _meta_load()

    scored: list[tuple[float, int, str]] = []  # (score, index, kind)
    if not q:
        scored = [
            (0.0, i, "popular") for i in range(len(names))
        ]  # the file is already ordered by downloads
    else:
        tokens = [canonicalize_name(t) for t in re.split(r"[\s,]+", q) if t]
        for i, key in enumerate(keys):
            hit = _score(key, tokens)
            if hit:
                scored.append((hit[0] + math.log10(downloads[i] + 1), i, hit[1]))
        scored.sort(key=lambda t: t[0], reverse=True)
        if len(scored) < 5 and len(tokens) == 1 and len(tokens[0]) >= 4:
            want = tokens[0]
            have_idx = {i for _, i, _ in scored}
            pool = [k for k in keys if abs(len(k) - len(want)) <= 3]
            for k in difflib.get_close_matches(want, pool, n=8, cutoff=0.75):
                i = keys.index(k)
                if i not in have_idx:
                    scored.append((100 + math.log10(downloads[i] + 1), i, "fuzzy"))

    window = scored[offset : offset + limit]
    hits = []
    for _, i, kind in window:
        key = keys[i]
        meta = cache.get(key) or {}
        hits.append(
            {
                "name": names[i],
                "key": key,
                "downloads": downloads[i],
                "installed": have.get(key),
                "summary": meta.get("summary") or None,
                "version": meta.get("version") or None,
                "match": kind,
            }
        )
    return {
        "query": q,
        "total": len(scored),
        "offset": offset,
        "hits": hits,
        "index": index_status(),
    }


# ------------------------------------------------------------- details


def info(
    name: str, version: Optional[str] = None, progress: Progress = lambda e: None
) -> dict:
    """Everything the details sheet shows about one project (optionally one specific release)."""
    _cancel.clear()
    canon = canonicalize_name(name)
    if not canon:
        raise PkgError("Enter a package name.")
    try:
        meta = _fetch_meta(canon, version)
    except _NotFound:
        if version:
            return {
                "status": "not_found",
                "name": canon,
                "message": f"{canon} {version} was not found on PyPI.",
            }
        return {
            "status": "not_found",
            "name": canon,
            "message": f"“{name}” was not found on PyPI.",
        }
    meta["status"] = "ok"
    meta["installed"] = _installed_version(canon)
    cache = _meta_load()
    cache[canon] = {
        "t": time.time(),
        "summary": meta["summary"],
        "version": meta["version"],
    }
    _meta_save(cache)
    return meta


def dependents(name: str) -> dict:
    canon = canonicalize_name(name)
    return {
        "name": canon,
        "dependents": _dependents(canon),
        "installed": _installed_version(canon),
        "removable": canon in _site_dists(),
    }


# ------------------------------------------------------------- updates


def outdated(
    names: Optional[list[str]] = None, progress: Progress = lambda e: None
) -> list[dict]:
    """For each installed (removable) package: is there a newer version this device can load?"""
    _cancel.clear()
    pool_names = [p for p in list_installed() if p["removable"]]
    if names is not None:
        wanted = {canonicalize_name(n) for n in names}
        pool_names = [p for p in pool_names if p["name"] in wanted]
    total = len(pool_names)
    lock = threading.Lock()
    state = {"done": 0}

    def check(p: dict) -> dict:
        row = {
            "name": p["name"],
            "installed": p["version"],
            "latest": None,
            "update": False,
            "note": None,
            "error": None,
        }
        try:
            res = lookup(p["name"])
            if res["status"] == "ok":
                row["latest"] = res["version"]
                row["note"] = res.get("note")
                try:
                    row["update"] = Version(res["version"]) > Version(p["version"])
                except InvalidVersion:
                    row["update"] = res["version"] != p["version"]
            else:
                row["error"] = res["message"]
        except Cancelled:
            raise
        except (
            Exception
        ) as e:  # noqa: BLE001 - one package failing must not hide the others
            row["error"] = f"{type(e).__name__}: {e}"
        with lock:
            state["done"] += 1
            progress(
                {"t": "check", "done": state["done"], "total": total, "file": p["name"]}
            )
        return row

    with ThreadPoolExecutor(max_workers=3) as pool:
        return sorted(pool.map(check, pool_names), key=lambda r: r["name"])
