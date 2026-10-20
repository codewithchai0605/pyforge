"""Drop-in replacements for stdlib/third-party modules that can't work on Android.

* `turtle`      – the real one needs tkinter; ours draws on an HTML canvas.
* `tkinter`     – not available; importing it raises a helpful ImportError.
* `pyforge_mpl` – matplotlib backend that saves figures as PNGs for the UI.
"""

import importlib
import importlib.abc
import importlib.machinery
import sys

_ALIASES = {"turtle": "pyforge.shims.turtle"}
_UNAVAILABLE = {
    "tkinter": (
        "tkinter isn't available in PyForge (Android has no Tk). "
        "For simple graphics use `import turtle`, which PyForge renders on its own canvas; "
        "for plots use matplotlib."
    ),
    "_tkinter": "tkinter isn't available in PyForge (Android has no Tk).",
}


class _ShimFinder(importlib.abc.MetaPathFinder):
    """Redirects `import turtle` to our implementation and blocks tkinter."""

    def find_spec(self, fullname, path=None, target=None):
        top = fullname.split(".")[0]
        if top in _UNAVAILABLE:
            # Return a spec whose loader fails, instead of raising here:
            # `importlib.util.find_spec("tkinter")` is a common feature test
            # and must not blow up. The *import* is what should fail.
            return importlib.machinery.ModuleSpec(fullname, _UnavailableLoader(_UNAVAILABLE[top]))
        if fullname in _ALIASES:
            return importlib.machinery.ModuleSpec(fullname, _AliasLoader(_ALIASES[fullname]))
        return None


class _UnavailableLoader(importlib.abc.Loader):
    def __init__(self, message: str):
        self._message = message

    def create_module(self, spec):
        raise ModuleNotFoundError(self._message, name=spec.name)

    def exec_module(self, module):  # pragma: no cover - create_module always raises
        raise ModuleNotFoundError(self._message)


class _AliasLoader(importlib.abc.Loader):
    def __init__(self, target: str):
        self._target = target

    def create_module(self, spec):
        return importlib.import_module(self._target)

    def exec_module(self, module):
        # Already executed under its real name; nothing more to do.
        pass


def install() -> None:
    if not any(isinstance(f, _ShimFinder) for f in sys.meta_path):
        sys.meta_path.insert(0, _ShimFinder())
    # If the stdlib versions were imported earlier in this process, evict them.
    for name in ("turtle", "tkinter", "_tkinter"):
        sys.modules.pop(name, None)
