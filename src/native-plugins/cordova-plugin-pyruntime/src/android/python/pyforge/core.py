"""Session plumbing shared by the script runner, the REPL and the GUI shims.

A *session* is one run of one script (or one REPL). Everything the user's
program can observe or produce goes through it:

  outbound   JSON events -> Kotlin -> WebView   (stdout/stderr text, turtle
             commands, plot images, "waiting for input", exit code)
  inbound    stdin lines and GUI events        (WebView -> Kotlin -> here)

Events are one-line JSON objects with a short type key `t`:

  {"t":"out","s":"text"}            stdout text
  {"t":"err","s":"text"}            stderr text
  {"t":"input","prompt":"Name: "}   the program is blocked waiting for stdin
  {"t":"gui","cmds":[[...],...]}    batch of turtle commands (see shims/turtle)
  {"t":"img","path":"/x/plot.png"}  a matplotlib figure was written to disk
  {"t":"exit","code":0,"ms":123}    the program finished
"""

from __future__ import annotations

import io
import json
import queue
import threading
import time
from typing import Callable, Optional

_session: Optional["Session"] = None


def current_session() -> "Session":
    if _session is None:
        raise RuntimeError("No active PyForge session (are you running outside the app?)")
    return _session


def has_session() -> bool:
    return _session is not None


def set_session(session: Optional["Session"]) -> None:
    global _session
    _session = session


class Session:
    """Owns the outbound transport and the inbound queues for one run."""

    def __init__(self, emit_line: Callable[[str], None]):
        self._emit_line = emit_line
        self._emit_lock = threading.Lock()
        self.stdin_q: "queue.Queue[Optional[str]]" = queue.Queue()
        self.gui_q: "queue.Queue[dict]" = queue.Queue()
        self.started = time.time()
        self.mux = Mux(self)
        # Things that hold buffered output of their own (the turtle command
        # batch) register a flush here; the runner calls them before it
        # reports the exit code, so nothing drawn right before the script
        # ended is lost.
        self.exit_hooks: list[Callable[[], None]] = []

    def run_exit_hooks(self) -> None:
        for hook in self.exit_hooks:
            try:
                hook()
            except Exception:  # noqa: BLE001 - never let cleanup mask the real result
                pass

    def emit(self, **event) -> None:
        line = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
        # One lock so two threads (script + flusher) never interleave
        # half-lines on the transport.
        with self._emit_lock:
            self._emit_line(line)

    # -- inbound -------------------------------------------------------
    def feed_stdin(self, text: Optional[str]) -> None:
        self.stdin_q.put(text)

    def feed_gui(self, event: dict) -> None:
        self.gui_q.put(event)


class Mux:
    """Ordered, coalescing buffer for stdout + stderr.

    Why not emit on every write(): a script printing in a tight loop would
    otherwise push thousands of tiny messages through Binder and the WebView
    bridge per second. Instead writes accumulate here and a flusher thread
    drains them ~every 30 ms (or immediately when asked, e.g. before blocking
    on input()). Order *between* the two streams is preserved because both
    append to one list; adjacent chunks of the same kind are merged.
    """

    FLUSH_INTERVAL = 0.03
    MAX_PENDING_CHARS = 64 * 1024

    def __init__(self, session: Session):
        self._session = session
        self._lock = threading.Lock()
        self._chunks: list[tuple[str, str]] = []
        self._pending = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._pump, name="pyforge-flush", daemon=True)
        self._thread.start()

    def write(self, kind: str, text: str) -> None:
        if not text:
            return
        flush_now = False
        with self._lock:
            if self._chunks and self._chunks[-1][0] == kind:
                self._chunks[-1] = (kind, self._chunks[-1][1] + text)
            else:
                self._chunks.append((kind, text))
            self._pending += len(text)
            flush_now = self._pending >= self.MAX_PENDING_CHARS
        if flush_now:
            self.flush()

    def flush(self) -> None:
        with self._lock:
            chunks, self._chunks, self._pending = self._chunks, [], 0
        for kind, text in chunks:
            self._session.emit(t="out" if kind == "out" else "err", s=text)

    def close(self) -> None:
        self._stop.set()
        self.flush()

    def _pump(self) -> None:
        while not self._stop.wait(self.FLUSH_INTERVAL):
            self.flush()


class OutStream(io.TextIOBase):
    """sys.stdout / sys.stderr replacement that feeds the session's Mux."""

    def __init__(self, mux: Mux, kind: str):
        self._mux = mux
        self._kind = kind

    @property
    def encoding(self):  # type: ignore[override]
        return "utf-8"

    @property
    def errors(self):  # type: ignore[override]
        return "replace"

    def writable(self) -> bool:
        return True

    def isatty(self) -> bool:
        # False on purpose: libraries that see a TTY start emitting cursor
        # control codes and full-screen UIs our console doesn't implement.
        return False

    def write(self, s) -> int:  # type: ignore[override]
        if not isinstance(s, str):
            raise TypeError(f"write() argument must be str, not {type(s).__name__}")
        self._mux.write(self._kind, s)
        return len(s)

    def flush(self) -> None:
        # Real flush so print(..., flush=True) / time.sleep() animations show
        # up immediately instead of waiting for the next 30 ms tick.
        self._mux.flush()


class InStream(io.TextIOBase):
    """sys.stdin replacement: blocks on the session's stdin queue."""

    def __init__(self, session: Session):
        self._session = session
        self._buffer = ""
        self._eof = False

    @property
    def encoding(self):  # type: ignore[override]
        return "utf-8"

    def readable(self) -> bool:
        return True

    def isatty(self) -> bool:
        return False

    def _fill(self, prompt: str = "") -> bool:
        """Block for one more chunk. Returns False at EOF."""
        if self._eof:
            return False
        self._session.mux.flush()
        self._session.emit(t="input", prompt=prompt)
        chunk = self._session.stdin_q.get()
        if chunk is None:
            self._eof = True
            return False
        self._buffer += chunk
        return True

    def readline(self, size: int = -1) -> str:  # type: ignore[override]
        while "\n" not in self._buffer:
            if not self._fill():
                break
        nl = self._buffer.find("\n")
        end = len(self._buffer) if nl == -1 else nl + 1
        if size is not None and size >= 0:
            end = min(end, size)
        line, self._buffer = self._buffer[:end], self._buffer[end:]
        return line

    def read(self, size: int = -1) -> str:  # type: ignore[override]
        if size is None or size < 0:
            while self._fill():
                pass
            data, self._buffer = self._buffer, ""
            return data
        while len(self._buffer) < size and self._fill():
            pass
        data, self._buffer = self._buffer[:size], self._buffer[size:]
        return data

    def input(self, prompt: object = "") -> str:
        """Implementation of builtins.input()."""
        text = "" if prompt is None else str(prompt)
        if text:
            self._session.mux.write("out", text)
        # Hand the prompt to the UI too so it can show it as the input
        # box's placeholder; the text itself was already written above.
        while "\n" not in self._buffer:
            if not self._fill(text):
                if self._buffer:
                    break
                raise EOFError("EOF when reading a line")
        nl = self._buffer.find("\n")
        end = len(self._buffer) if nl == -1 else nl
        line, self._buffer = self._buffer[:end], self._buffer[end + 1 :]
        # The console echoes what the user typed (like a terminal would),
        # so the transcript reads naturally. Nothing to echo here.
        return line.rstrip("\r")
