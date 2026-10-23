"""The only module Kotlin (and the desktop host) calls into.

Functions take/return plain strings and JSON so that the Chaquopy boundary
stays trivial: no PyObject juggling of dicts, nothing to marshal wrongly.
"""

from __future__ import annotations

import json
import sys
import threading
from typing import Any, Optional

from . import bootstrap, core, runner

_thread: Optional[threading.Thread] = None


def configure(home: str, site: str, projects: str, cache: str, abi: str = "", api: str = "") -> None:
    bootstrap.configure(home, site, projects, cache, abi, api)


def runtime_info() -> str:
    from . import tags

    info = tags.describe_platform()
    info["python"] = sys.version.split()[0]
    info["site"] = bootstrap.site_dir()
    return json.dumps(info)


# -- script / REPL execution (runner process) ----------------------------


def start_run(sink: Any, req_json: str) -> None:
    """Start a script or REPL on a worker thread and return immediately.

    `sink` is any object with an `emit(str)` method (a Kotlin PySink on
    Android, a tiny stdout writer in the desktop host).
    """
    global _thread
    req = json.loads(req_json)
    session = core.Session(sink.emit)
    core.set_session(session)
    session.emit(t="started", python=sys.version.split()[0])
    # daemon=False is deliberate and must be explicit: a thread inherits the
    # daemon flag of the thread that creates it, and on Android that's a Java
    # binder thread (daemon). Threads the user's script starts would then be
    # daemonic too, and a script like `Thread(target=...).start()` would exit
    # without waiting for them, unlike under plain `python script.py`.
    thread = threading.Thread(target=runner.run, args=(session, req), name="pyforge-main", daemon=False)
    thread.start()
    # Published only once started: the desktop host waits on `_thread` from
    # another thread and join()ing a not-yet-started thread raises.
    _thread = thread


def feed_stdin(text: Optional[str]) -> None:
    if core.has_session():
        core.current_session().feed_stdin(text)


def feed_gui(event_json: str) -> None:
    if core.has_session():
        core.current_session().feed_gui(json.loads(event_json))


def cancel_pip() -> None:
    """Ask the running package operation to stop (safe to call from any thread)."""
    from . import pkgmgr

    pkgmgr.request_cancel()


# -- package manager (UI process) --------------------------------------


def pip_call(sink: Any, call: str, args_json: str) -> str:
    """Run one package-manager operation, streaming progress via `sink`.

    Returns a JSON string: {"ok":true,"result":...} or {"ok":false,"error":"..."}.
    """
    from . import pkgmgr

    args = json.loads(args_json) if args_json else {}

    def progress(event: dict) -> None:
        sink.emit(json.dumps(event, separators=(",", ":")))

    try:
        if call == "list":
            result = pkgmgr.list_installed()
        elif call == "lookup":
            result = pkgmgr.lookup(args["spec"], progress)
        elif call == "install":
            result = pkgmgr.install(args["specs"], progress)
        elif call == "uninstall":
            result = pkgmgr.uninstall(args["name"], progress)
        else:
            raise ValueError(f"unknown pip call: {call}")
        return json.dumps({"ok": True, "result": result})
    except pkgmgr.Cancelled:
        return json.dumps({"ok": False, "cancelled": True, "error": "Cancelled"})
    except pkgmgr.PkgError as e:
        return json.dumps({"ok": False, "error": str(e)})
    except Exception as e:  # noqa: BLE001 - report, never crash the UI process
        import traceback

        traceback.print_exc()
        return json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"})
