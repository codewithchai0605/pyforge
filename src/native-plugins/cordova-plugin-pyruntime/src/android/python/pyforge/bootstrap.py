"""Process-level setup, run once per interpreter (UI process and :python process).

Kotlin calls `configure()` right after starting Chaquopy, passing the app's
private directories. Everything that has to be true *before* user code or a
library like matplotlib is imported belongs here (env vars, sys.path).
"""

from __future__ import annotations

import os
import sys

_configured = False


def configure(home: str, site: str, projects: str, cache: str, abi: str = "", api: str = "") -> None:
    global _configured
    for d in (home, site, projects, cache, os.path.join(home, "mpl"), os.path.join(home, "home"), os.path.join(cache, "tmp"), os.path.join(cache, "plots")):
        os.makedirs(d, exist_ok=True)

    os.environ["PYFORGE_HOME"] = home
    os.environ["PYFORGE_SITE"] = site
    os.environ["PYFORGE_PROJECTS"] = projects
    os.environ["PYFORGE_CACHE"] = cache
    if abi:
        os.environ["PYFORGE_ABI"] = abi
    if api:
        os.environ["PYFORGE_API"] = api

    # Android gives apps no usable $HOME / $TMPDIR; libraries that cache
    # things (matplotlib font cache, pip, pathlib.Path.home()) need one.
    os.environ.setdefault("HOME", os.path.join(home, "home"))
    os.environ.setdefault("TMPDIR", os.path.join(cache, "tmp"))
    os.environ.setdefault("MPLCONFIGDIR", os.path.join(home, "mpl"))
    # Make `import matplotlib.pyplot` pick our backend; plt.show() then
    # writes a PNG and tells the UI instead of trying to open a window.
    # Forced (not setdefault): an inherited or empty MPLBACKEND would send
    # plt.show() to a backend that has no window to show on.
    os.environ["MPLBACKEND"] = "module://pyforge.shims.pyforge_mpl"
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")

    # Packages the user installed at runtime. Inserted at the *front* so a
    # deliberate `pip install -U` of something that's also bundled in the APK
    # actually takes effect.
    if site not in sys.path:
        sys.path.insert(0, site)
    _configured = True


def is_configured() -> bool:
    return _configured


def site_dir() -> str:
    return os.environ.get("PYFORGE_SITE", "")


def preload_native_libs() -> list[str]:
    """Load shared libraries installed by wheels (see pkgmgr._record_native_libs).

    Android's linker only resolves a native extension's DT_NEEDED entries from
    the app's own lib dir, so e.g. numpy's libopenblas (shipped as a separate
    wheel under chaquopy/lib/) must already be loaded, by SONAME, before the
    extension is imported. Order between libraries is unknown, so retry
    failures a few times: a library that needs another succeeds on a later pass.
    """
    import ctypes
    import json

    site = site_dir()
    manifest = os.path.join(site, "pyforge_preload.json")
    try:
        with open(manifest) as f:
            pending = [os.path.join(site, rel) for rel in json.load(f)]
    except (OSError, ValueError):
        return []
    loaded: list[str] = []
    for _ in range(3):
        still = []
        for path in pending:
            try:
                ctypes.CDLL(path, mode=ctypes.RTLD_GLOBAL)
                loaded.append(path)
            except OSError:
                still.append(path)
        if not still:
            break
        pending = still
    return loaded
