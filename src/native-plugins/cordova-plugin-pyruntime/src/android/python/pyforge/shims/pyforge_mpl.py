"""matplotlib backend for PyForge.

There's no window to open on Android, so `plt.show()` renders every open
figure to a PNG in the app's cache and tells the UI (an `img` event); the UI
shows it in the Display tab. Rendering uses matplotlib's normal Agg engine,
so output is identical to `savefig()`. `plt.savefig(...)` is untouched.

Selected via MPLBACKEND=module://pyforge.shims.pyforge_mpl (see bootstrap.py).
"""

from __future__ import annotations

import itertools
import os
import tempfile

from matplotlib import interactive  # noqa: F401  (part of the backend contract)
from matplotlib._pylab_helpers import Gcf
from matplotlib.backend_bases import FigureManagerBase, _Backend
from matplotlib.backends.backend_agg import FigureCanvasAgg

from .. import core

_counter = itertools.count(1)


def _plots_dir() -> str:
    base = os.environ.get("PYFORGE_CACHE") or tempfile.gettempdir()
    d = os.path.join(base, "plots")
    os.makedirs(d, exist_ok=True)
    return d


def _publish(fig) -> None:
    path = os.path.join(_plots_dir(), f"plot-{os.getpid()}-{next(_counter)}.png")
    fig.savefig(path, format="png", dpi=max(fig.dpi, 100), facecolor=fig.get_facecolor())
    title = ""
    try:
        title = fig.axes[0].get_title() if fig.axes else ""
    except Exception:  # noqa: BLE001
        pass
    # Only a *path* travels over the bridge: Android's Binder caps a single
    # message at ~1 MB, which a high-DPI figure's base64 would exceed.
    if core.has_session():
        core.current_session().emit(t="img", path=path, title=title)


class FigureManager(FigureManagerBase):
    def show(self) -> None:
        _publish(self.canvas.figure)


class FigureCanvas(FigureCanvasAgg):
    # matplotlib (>= 3.x) asks the *canvas* which manager to build; merely
    # exporting `FigureManager` from the backend is not enough.
    manager_class = FigureManager


@_Backend.export
class _BackendPyForge(_Backend):
    FigureCanvas = FigureCanvas
    FigureManager = FigureManager

    @classmethod
    def show(cls, *, block=None):  # type: ignore[override]
        for manager in Gcf.get_all_fig_managers():
            manager.show()
        # The figures were delivered; closing them keeps a second plt.show()
        # from re-sending the same pictures (matches GUI backends' behaviour
        # of the window going away).
        Gcf.destroy_all()

    @staticmethod
    def mainloop():
        pass
