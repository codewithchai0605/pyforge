"""Desktop stand-in for the Android `:python` service.

Speaks the same protocol over stdin/stdout as Kotlin does over Binder, so the
browser preview and the automated tests drive the *real* runner:

  host   -> parent   one JSON event per line (see core.py)
  parent -> host     {"op":"run","req":{...}} | {"op":"stdin","text":..|null}
                     | {"op":"gui","event":{...}}

and a one-shot mode for the package manager:

  python -m pyforge.host --pip <call> '<json args>'
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading


class _Sink:
    def __init__(self, out):
        self._out = out
        self._lock = threading.Lock()

    def emit(self, line: str) -> None:
        with self._lock:
            self._out.write(line + "\n")
            self._out.flush()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", default=os.environ.get("PYFORGE_HOME", "/tmp/pyforge/home"))
    ap.add_argument("--site", default=os.environ.get("PYFORGE_SITE", "/tmp/pyforge/site"))
    ap.add_argument("--projects", default=os.environ.get("PYFORGE_PROJECTS", "/tmp/pyforge/projects"))
    ap.add_argument("--cache", default=os.environ.get("PYFORGE_CACHE", "/tmp/pyforge/cache"))
    ap.add_argument("--pip", nargs=2, metavar=("CALL", "JSON"))
    args = ap.parse_args(argv)

    # The protocol owns the *original* fds; user code will get its own
    # sys.stdin/stdout replacements from the runner.
    proto_out = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    proto_in = os.fdopen(os.dup(0), "r", encoding="utf-8")
    sink = _Sink(proto_out)

    from . import api

    api.configure(args.home, args.site, args.projects, args.cache)

    if args.pip:
        call, payload = args.pip

        def listen_for_cancel() -> None:
            for line in proto_in:
                if line.strip() == "cancel":
                    api.cancel_pip()

        threading.Thread(target=listen_for_cancel, daemon=True).start()
        result = api.pip_call(sink, call, payload)
        sink.emit(json.dumps({"t": "result", "payload": json.loads(result)}))
        return 0

    def reader() -> None:
        for line in proto_in:
            line = line.strip()
            if not line:
                continue
            msg = json.loads(line)
            op = msg.get("op")
            if op == "run":
                api.start_run(sink, json.dumps(msg["req"]))
            elif op == "stdin":
                api.feed_stdin(msg.get("text"))
            elif op == "gui":
                api.feed_gui(json.dumps(msg["event"]))

    threading.Thread(target=reader, daemon=True).start()

    # Wait for the run to be requested, then for it to finish.
    while api._thread is None:
        threading.Event().wait(0.02)
    api._thread.join()
    return 0


if __name__ == "__main__":
    sys.exit(main())
