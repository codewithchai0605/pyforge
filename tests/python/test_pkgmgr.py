"""Package manager against a local fake PyPI + fake Chaquopy index."""

import hashlib
import http.server
import io
import json
import os
import sys
import threading
import zipfile

import pytest

sys.path.insert(0, str(__import__("conftest").PY_SRC))
from pyforge import pkgmgr  # noqa: E402


def make_wheel(name, version, files=None, requires=(), tag="py3-none-any", build=""):
    dist = f"{name}-{version}"
    files = dict(files or {f"{name}/__init__.py": f"VERSION = '{version}'\n"})
    meta = f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\nSummary: test pkg {name}\n"
    meta += "".join(f"Requires-Dist: {r}\n" for r in requires)
    files[f"{dist}.dist-info/METADATA"] = meta
    files[f"{dist}.dist-info/WHEEL"] = "Wheel-Version: 1.0\nRoot-Is-Purelib: true\n"
    files[f"{dist}.dist-info/RECORD"] = "".join(f"{p},,\n" for p in files) + f"{dist}.dist-info/RECORD,,\n"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for p, c in files.items():
            z.writestr(p, c)
    fname = f"{name}-{version}{'-' + build if build else ''}-{tag}.whl"
    return fname, buf.getvalue()


class FakeIndex:
    def __init__(self):
        self.pypi: dict[str, list[tuple[str, bytes]]] = {}
        self.chaquo: dict[str, list[tuple[str, bytes]]] = {}
        self.corrupt: set[str] = set()
        self.hits: list[str] = []

    def add(self, store, name, fname, data):
        getattr(self, store).setdefault(name, []).append((fname, data))

    def start(self):
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                outer.hits.append(self.path)
                parts = self.path.strip("/").split("/")
                base = f"http://127.0.0.1:{self.server.server_port}"
                if parts[0] == "simple":
                    files = outer.pypi.get(parts[1])
                    if files is None:
                        return self._send(404, b"")
                    body = {"files": [{"filename": f, "url": f"{base}/files/{f}",
                                       "hashes": {"sha256": hashlib.sha256(d).hexdigest()},
                                       "requires-python": None, "yanked": False, "size": len(d)} for f, d in files]}
                    return self._send(200, json.dumps(body).encode(), "application/vnd.pypi.simple.v1+json")
                if parts[0] == "chaquo":
                    files = outer.chaquo.get(parts[1])
                    if files is None:
                        return self._send(404, b"")
                    links = "".join(f'<a href="{base}/files/{f}#sha256={hashlib.sha256(d).hexdigest()}">{f}</a><br>' for f, d in files)
                    return self._send(200, f"<html>{links}</html>".encode(), "text/html")
                if parts[0] == "files":
                    for store in (outer.pypi, outer.chaquo):
                        for files in store.values():
                            for f, d in files:
                                if f == parts[1]:
                                    return self._send(200, (b"garbage" if f in outer.corrupt else d))
                self._send(404, b"")

            def _send(self, code, body, ctype="application/octet-stream"):
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        return self


@pytest.fixture
def env(tmp_path, monkeypatch):
    idx = FakeIndex().start()
    monkeypatch.setattr(pkgmgr, "PYPI_URL", idx.url + "/simple/")
    monkeypatch.setattr(pkgmgr, "CHAQUO_URL", idx.url + "/chaquo/")
    monkeypatch.setenv("PYFORGE_SITE", str(tmp_path / "site"))
    monkeypatch.setenv("PYFORGE_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PYFORGE_PLATFORM", raising=False)
    monkeypatch.delenv("PYFORGE_ABI", raising=False)
    # Make the "builtin" scan see nothing so tests are independent of the dev machine.
    monkeypatch.setattr(pkgmgr, "_builtin_dists", lambda: {})
    yield idx
    idx.server.shutdown()


def android(monkeypatch, plat="android_24_arm64_v8a"):
    monkeypatch.setenv("PYFORGE_PLATFORM", plat)


def test_install_resolves_dependencies_and_picks_newest(env, tmp_path):
    env.add("pypi", "app", *make_wheel("app", "1.0", requires=["lib>=1"]))
    env.add("pypi", "app", *make_wheel("app", "2.0", requires=["lib>=1", "extra-thing; extra == 'x'", "winonly; sys_platform == 'win32'"]))
    env.add("pypi", "lib", *make_wheel("lib", "1.5"))
    env.add("pypi", "lib", *make_wheel("lib", "2.0b1"))  # pre-release must not win
    res = pkgmgr.install(["app"])
    assert {(i["name"], i["version"]) for i in res["installed"]} == {("app", "2.0"), ("lib", "1.5")}
    assert (tmp_path / "site/app/__init__.py").read_text() == "VERSION = '2.0'\n"
    assert "winonly" not in env.pypi and not any("winonly" in h for h in env.hits)
    assert not any("extra-thing" in h for h in env.hits)


def test_version_pin_and_conflict_message(env):
    env.add("pypi", "lib", *make_wheel("lib", "1.0"))
    env.add("pypi", "lib", *make_wheel("lib", "2.0"))
    assert pkgmgr.install(["lib==1.0"])["installed"][0]["version"] == "1.0"
    with pytest.raises(pkgmgr.PkgError, match="satisfying"):
        pkgmgr.install(["lib>=3"])


def test_uninstall_removes_files_and_pycache(env, tmp_path):
    env.add("pypi", "lib", *make_wheel("lib", "1.0"))
    pkgmgr.install(["lib"])
    pyc = tmp_path / "site/lib/__pycache__"
    pyc.mkdir()
    (pyc / "x.pyc").write_bytes(b"x")
    out = pkgmgr.uninstall("lib")
    assert out["files"] >= 2
    assert os.listdir(tmp_path / "site") == []


def test_uninstall_reports_dependents(env):
    env.add("pypi", "app", *make_wheel("app", "1.0", requires=["lib"]))
    env.add("pypi", "lib", *make_wheel("lib", "1.0"))
    pkgmgr.install(["app"])
    assert pkgmgr.uninstall("lib")["dependents"] == ["app"]


def test_list_installed(env):
    env.add("pypi", "lib", *make_wheel("lib", "1.0"))
    pkgmgr.install(["lib"])
    items = pkgmgr.list_installed()
    assert items == [{"name": "lib", "version": "1.0", "removable": True, "summary": "test pkg lib", "requires": []}]


def test_android_rejects_manylinux_but_accepts_android_wheel_and_records_libs(env, monkeypatch, tmp_path):
    android(monkeypatch)
    env.add("pypi", "nat", *make_wheel("nat", "2.0", tag="cp312-cp312-manylinux_2_17_x86_64"))
    # Chaquopy-style build tag in the filename, plus a bundled native lib wheel.
    env.add("chaquo", "nat", *make_wheel("nat", "1.0", build="0", tag="cp312-cp312-android_24_arm64_v8a",
                                         requires=["chaquopy-libfoo"]))
    env.add("chaquo", "chaquopy-libfoo", *make_wheel(
        "chaquopy_libfoo", "1.0", build="0", tag="py3-none-android_24_arm64_v8a",
        files={"chaquopy/lib/libfoo.so": "ELF"}))
    # The dependency lives on the Chaquopy index under its own name:
    env.chaquo["chaquopy-libfoo"] = env.chaquo.pop("chaquopy-libfoo")
    info = pkgmgr.lookup("nat")
    assert info["status"] == "ok" and info["version"] == "1.0" and info["kind"] == "native" and info["source"] == "chaquopy"
    res = pkgmgr.install(["nat"])
    assert {i["version"] for i in res["installed"]} == {"1.0"}
    manifest = json.loads((tmp_path / "site/pyforge_preload.json").read_text())
    assert manifest == [os.path.join("chaquopy", "lib", "libfoo.so")]


@pytest.mark.parametrize("tag", [
    "cp312-cp312-manylinux_2_17_x86_64",
    "cp312-cp312-musllinux_1_1_aarch64",
    "cp312-cp312-android_24_x86_64",      # wrong ABI
    "cp312-cp312-android_30_arm64_v8a",   # needs a newer Android than the device
    "cp311-cp311-android_24_arm64_v8a",   # wrong Python
    "cp312-cp312-win_amd64",
])
def test_android_rejects_incompatible_wheels(env, monkeypatch, tag):
    android(monkeypatch)
    env.add("pypi", "bad", *make_wheel("bad", "1.0", tag=tag))
    assert pkgmgr.lookup("bad")["status"] == "no_android_wheel"
    with pytest.raises(pkgmgr.PkgError, match="can run on this device"):
        pkgmgr.install(["bad"])


def test_android_prefers_pure_wheel_over_native_for_same_version(env, monkeypatch):
    android(monkeypatch)
    env.add("pypi", "both", *make_wheel("both", "1.0", tag="cp312-cp312-android_24_arm64_v8a"))
    env.add("pypi", "both", *make_wheel("both", "1.0", tag="py3-none-any"))
    assert pkgmgr.lookup("both")["kind"] == "pure"


def test_abi3_wheel_accepted(env, monkeypatch):
    android(monkeypatch)
    env.add("pypi", "stable", *make_wheel("stable", "1.0", tag="cp39-abi3-android_24_arm64_v8a"))
    assert pkgmgr.lookup("stable")["kind"] == "native"


def test_not_found_and_invalid_names(env):
    assert pkgmgr.lookup("nope")["status"] == "not_found"
    with pytest.raises(pkgmgr.PkgError, match="not found"):
        pkgmgr.install(["nope"])
    with pytest.raises(pkgmgr.PkgError, match="valid package requirement"):
        pkgmgr.install(["not a name!!"])
    with pytest.raises(pkgmgr.PkgError, match="Enter a package name"):
        pkgmgr.install(["  "])


def test_checksum_mismatch_is_rejected_and_nothing_installed(env, tmp_path):
    fname, data = make_wheel("lib", "1.0")
    env.add("pypi", "lib", fname, data)
    env.corrupt.add(fname)
    with pytest.raises(pkgmgr.PkgError, match="Checksum mismatch"):
        pkgmgr.install(["lib"])
    assert not (tmp_path / "site").exists() or os.listdir(tmp_path / "site") == []


def test_zip_slip_is_refused(env, tmp_path):
    evil = {"../../escape.py": "boom", "evil/__init__.py": ""}
    env.add("pypi", "evil", *make_wheel("evil", "1.0", files=evil))
    with pytest.raises(pkgmgr.PkgError, match="unsafe path"):
        pkgmgr.install(["evil"])
    assert not (tmp_path / "escape.py").exists()


def test_reinstall_replaces_old_version_without_stale_files(env, tmp_path):
    env.add("pypi", "lib", *make_wheel("lib", "1.0", files={"lib/__init__.py": "", "lib/old.py": ""}))
    pkgmgr.install(["lib==1.0"])
    env.pypi["lib"] = []
    env.add("pypi", "lib", *make_wheel("lib", "2.0", files={"lib/__init__.py": ""}))
    pkgmgr.install(["lib>=2"])
    assert not (tmp_path / "site/lib/old.py").exists()
    assert pkgmgr.list_installed()[0]["version"] == "2.0"


def test_staleness_note_when_only_old_version_loadable(env, monkeypatch):
    android(monkeypatch)
    env.add("pypi", "old", *make_wheel("old", "0.0.1"))
    env.add("pypi", "old", *make_wheel("old", "2.5", tag="cp312-cp312-manylinux_2_17_x86_64"))
    info = pkgmgr.lookup("old")
    assert info["version"] == "0.0.1" and "much older" in info["note"]


def test_progress_events(env):
    env.add("pypi", "lib", *make_wheel("lib", "1.0"))
    events = []
    pkgmgr.install(["lib"], events.append)
    assert any(e["t"] == "dl" and e["done"] == e["total"] for e in events)
    assert events[-1] == {"t": "log", "s": "Done."}
