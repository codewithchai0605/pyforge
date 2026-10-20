"""Runs a user script (or a REPL) inside a Session.

This always executes in a *fresh* interpreter process: on Android that's the
`:python` service process Kotlin kills on "Stop", on desktop it's the host
process the dev bridge spawns. So there is deliberately no attempt to clean
up sys.modules / threads / signal handlers afterwards; the process just ends.
"""

from __future__ import annotations

import atexit
import builtins
import os
import sys
import threading
import time
import tokenize
import traceback
import types

from . import bootstrap, core, shims


def _install_streams(session: core.Session) -> None:
    sys.stdout = core.OutStream(session.mux, "out")
    sys.stderr = core.OutStream(session.mux, "err")
    stdin = core.InStream(session)
    sys.stdin = stdin
    builtins.input = stdin.input  # type: ignore[assignment]
    # Quiet the one thing that otherwise spams every run on Android.
    try:
        import warnings

        warnings.filterwarnings("ignore", message=".*pyforge.*")
    except Exception:  # pragma: no cover
        pass


def _format_exception(exc: BaseException, skip_frames: int = 1) -> str:
    """Traceback text as the user's own code would show it.

    The first `skip_frames` frames belong to this runner, not the user's
    script, so they're dropped (a "File runner.py, line 83, in run" line on
    every error would be pure noise).
    """
    tb = exc.__traceback__
    for _ in range(skip_frames):
        if tb is not None:
            tb = tb.tb_next
    return "".join(traceback.format_exception(type(exc), exc, tb))


def _exit_code(exc: SystemExit) -> int:
    code = exc.code
    if code is None:
        return 0
    if isinstance(code, int):
        return code
    print(code, file=sys.stderr)
    return 1


def _join_user_threads() -> None:
    """Python waits for non-daemon threads before exiting; do the same."""
    # Skip ourselves and the process's main thread: the main thread is the one
    # waiting on *us* (the desktop host, the Android service), so joining it
    # here would deadlock and the run would never report its exit.
    skip = {threading.current_thread(), threading.main_thread()}
    for t in threading.enumerate():
        if t not in skip and not t.daemon and t.is_alive():
            t.join()


def run_script(session: core.Session, req: dict) -> int:
    path = req["path"]
    cwd = req.get("cwd") or os.path.dirname(os.path.abspath(path)) or "."
    code = 0
    try:
        os.chdir(cwd)
        sys.argv = [path] + list(req.get("args") or [])
        # `python script.py` puts the script's directory first on sys.path so
        # sibling modules import; runpy-style helpers don't, so do it here.
        sys.path.insert(0, os.path.dirname(os.path.abspath(path)))
        for key, value in (req.get("env") or {}).items():
            os.environ[str(key)] = str(value)

        if "code" in req and req["code"] is not None:
            source = req["code"]
        else:
            with tokenize.open(path) as f:  # honours `# -*- coding: -*-`
                source = f.read()

        main = types.ModuleType("__main__")
        main.__file__ = path
        main.__builtins__ = builtins  # type: ignore[attr-defined]
        sys.modules["__main__"] = main
        compiled = compile(source, path, "exec")
        exec(compiled, main.__dict__)
    except SystemExit as e:
        code = _exit_code(e)
    except KeyboardInterrupt:
        sys.stderr.write("KeyboardInterrupt\n")
        code = 130
    except BaseException as e:  # noqa: BLE001 - this *is* the top-level handler
        sys.stderr.write(_format_exception(e))
        code = 1
    try:
        _join_user_threads()
        atexit._run_exitfuncs()
    except BaseException as e:  # noqa: BLE001
        sys.stderr.write(_format_exception(e, 0))
    return code


def run_repl(session: core.Session, req: dict) -> int:
    import code as codemod

    cwd = req.get("cwd") or os.environ.get("PYFORGE_PROJECTS") or "."
    os.chdir(cwd)
    sys.path.insert(0, cwd)
    stdin = sys.stdin

    class Console(codemod.InteractiveConsole):
        def raw_input(self, prompt: str = "") -> str:  # type: ignore[override]
            return stdin.input(prompt)  # type: ignore[union-attr]

    banner = f"Python {sys.version.split()[0]} on Android (PyForge)\nType help() for help, Ctrl-D (EOF button) to exit."
    try:
        Console(locals={"__name__": "__main__"}).interact(banner=banner, exitmsg="")
    except SystemExit as e:
        return _exit_code(e)
    return 0


def run(session: core.Session, req: dict) -> None:
    """Thread body: set everything up, run, report the exit code."""
    core.set_session(session)
    shims.install()
    _install_streams(session)
    try:
        bootstrap.preload_native_libs()
    except Exception:  # noqa: BLE001 - optional nicety, never fatal
        pass
    started = time.time()
    try:
        if req.get("mode") == "repl":
            code = run_repl(session, req)
        else:
            code = run_script(session, req)
    finally:
        session.run_exit_hooks()
        session.mux.close()
    session.emit(t="exit", code=code, ms=int((time.time() - started) * 1000))
