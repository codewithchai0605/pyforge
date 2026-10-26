"""The desktop stand-in for the Android PTY plugin (utils/dev-bridge/pty_host.py)."""

import base64
import json
import subprocess
import sys
import threading
import time

from conftest import ROOT

HOST = ROOT / "utils/dev-bridge/pty_host.py"


class Term:
    def __init__(self, *args):
        self.proc = subprocess.Popen(
            [sys.executable, "-u", str(HOST), "--shell", "/bin/bash", *args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        self.output = b""
        self.exit = None
        self._t = threading.Thread(target=self._read, daemon=True)
        self._t.start()

    def _read(self):
        for line in self.proc.stdout:
            ev = json.loads(line)
            if ev["t"] == "out":
                self.output += base64.b64decode(ev["b"])
            elif ev["t"] == "exit":
                self.exit = ev["code"]

    def send(self, **cmd):
        self.proc.stdin.write(json.dumps(cmd) + "\n")
        self.proc.stdin.flush()

    def wait_for(self, needle: bytes, timeout=8):
        end = time.time() + timeout
        while time.time() < end:
            if needle in self.output:
                return
            time.sleep(0.02)
        raise AssertionError(f"{needle!r} not in {self.output[-300:]!r}")

    def wait_exit(self, timeout=8):
        end = time.time() + timeout
        while time.time() < end and self.exit is None:
            time.sleep(0.02)
        return self.exit


def test_runs_commands_and_reports_exit_status():
    t = Term("--cols", "90", "--rows", "20")
    t.send(op="in", d="stty size; echo caf\u00e9-$((6*7))\nexit 9\n")
    t.wait_for("caf\u00e9-42".encode())
    assert b"20 90" in t.output
    assert t.wait_exit() == 9


def test_resize_and_hang_up():
    t = Term()
    t.send(op="resize", cols=61, rows=17)
    t.send(op="in", d="stty size\n")
    t.wait_for(b"17 61")
    t.send(op="close")
    assert t.wait_exit() is not None


def test_closing_stdin_hangs_up_the_shell():
    t = Term()
    t.send(op="in", d="echo up\n")
    t.wait_for(b"up")
    t.proc.stdin.close()  # the bridge went away
    assert t.wait_exit() is not None
