"""Shared helpers: drive the real desktop host process over its JSON protocol."""

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PY_SRC = ROOT / "src/native-plugins/cordova-plugin-pyruntime/src/android/python"


class Host:
    """One `python -m pyforge.host` process = one script run."""

    def __init__(self, tmp: Path, extra_env=None):
        env = {**os.environ, "PYTHONPATH": str(PY_SRC), "MPLBACKEND": ""}
        env.pop("PYFORGE_PLATFORM", None)
        env.update(extra_env or {})
        self.dirs = {k: tmp / k for k in ("home", "site", "projects", "cache")}
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "pyforge.host", *sum(([f"--{k}", str(v)] for k, v in self.dirs.items()), [])],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, cwd=tmp,
        )
        self.events: list[dict] = []
        self._cv = threading.Condition()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            with self._cv:
                self.events.append(json.loads(line))
                self._cv.notify_all()
        with self._cv:
            self.events.append({"t": "eof"})
            self._cv.notify_all()

    def send(self, **msg):
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def run(self, **req):
        self.send(op="run", req=req)
        return self

    def wait_for(self, pred, timeout=20):
        end = time.time() + timeout
        with self._cv:
            while True:
                for ev in self.events:
                    if pred(ev):
                        return ev
                if time.time() > end:
                    raise AssertionError(f"timeout; events so far: {self.events[-8:]}")
                self._cv.wait(0.1)

    def finish(self, timeout=20):
        ev = self.wait_for(lambda e: e["t"] == "exit", timeout)
        self.proc.wait(timeout=10)
        return ev

    @property
    def stdout(self):
        return "".join(e["s"] for e in self.events if e["t"] == "out")

    @property
    def stderr(self):
        return "".join(e["s"] for e in self.events if e["t"] == "err")

    def gui_cmds(self):
        return [c for e in self.events if e["t"] == "gui" for c in e["cmds"]]

    def kill(self):
        self.proc.kill()


@pytest.fixture
def host(tmp_path):
    h = Host(tmp_path)
    yield h
    if h.proc.poll() is None:
        h.kill()


@pytest.fixture
def script(tmp_path):
    def make(code: str, name="main.py") -> str:
        p = tmp_path / "projects" / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(code)
        return str(p)

    return make
