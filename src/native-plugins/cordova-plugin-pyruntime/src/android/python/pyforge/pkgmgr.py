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

import email.parser
import hashlib
import json
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
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Callable, Optional
from urllib.parse import urljoin, urldefrag

from packaging.markers import default_environment
from packaging.requirements import InvalidRequirement, Requirement
from packaging.specifiers import SpecifierSet
from packaging.utils import InvalidWheelFilename, canonicalize_name, parse_wheel_filename
from packaging.version import InvalidVersion, Version

from . import tags

Progress = Callable[[dict], None]

PYPI_URL = os.environ.get("PYFORGE_PYPI_URL", "https://pypi.org/simple/")
# Chaquopy's curated index of Android builds (numpy, pandas, pillow, ...).
CHAQUO_URL = os.environ.get("PYFORGE_CHAQUO_URL", "https://chaquo.com/pypi-13.1/")
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


def _open(url: str, accept: Optional[str] = None):
    headers = {"User-Agent": USER_AGENT}
    if accept:
        headers["Accept"] = accept
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
                "sha256": frag[len("sha256=") :] if frag.startswith("sha256=") else None,
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
                f["filename"], f["url"], f.get("sha256"), rp, False, version, rank, source, f.get("size")
            )
        )
    return result


def _candidates(name: str, log: Progress) -> tuple[list[WheelFile], bool, Optional[Version]]:
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


def _staleness_note(name: str, pick: "WheelFile", newest: Optional[Version]) -> Optional[str]:
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
            {"name": name, "version": version, "removable": True, "summary": summary, "requires": requires}
        )
    seen = {i["name"] for i in items}
    for name, version in sorted(_builtin_dists().items()):
        if name not in seen and name not in ("pip", "setuptools", "wheel"):
            items.append({"name": name, "version": version, "removable": False, "summary": "", "requires": []})
    return items


def _read_metadata_dir(info_dir: str) -> tuple[str, list[str]]:
    try:
        with open(os.path.join(info_dir, "METADATA"), encoding="utf-8", errors="replace") as f:
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
        return {"name": req.name, "status": "not_found", "message": f"“{req.name}” was not found on PyPI."}
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
        raise PkgError(f"“{spec}” isn't a valid package requirement (try e.g. requests or numpy>=1.26).") from None


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
                    progress({"t": "dl", "file": wheel.filename, "done": done, "total": total})
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
        raise PkgError(f"Checksum mismatch for {wheel.filename}; the download was corrupted. Try again.")
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
        meta_name = next((n for n in z.namelist() if n.endswith(".dist-info/METADATA") and n.count("/") == 1), None)
        if not meta_name:
            return []
        msg = email.parser.Parser().parsestr(z.read(meta_name).decode("utf-8", "replace"), headersonly=True)
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
                shutil.copytree(os.path.join(staging, entry), target, dirs_exist_ok=True)
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
                "If it needs compiled code, add it to python/requirements.txt and rebuild the app."
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
