"""The C pseudo-terminal core (pty_core.c) against real shells, via ctypes.

This is the code that starts the Terminal page's shell on Android. It is plain
POSIX, so it is compiled here with gcc and exercised on Linux.
"""

import ctypes
import os
import shutil
import signal
import subprocess
import time

import pytest

from conftest import ROOT

CPP = ROOT / "src/native-plugins/cordova-plugin-pyruntime/src/android/cpp"

pytestmark = pytest.mark.skipif(shutil.which("gcc") is None, reason="needs gcc")


@pytest.fixture(scope="module")
def lib(tmp_path_factory):
    out = tmp_path_factory.mktemp("pty") / "libpfcore.so"
    subprocess.run(
        [
            "gcc",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-O2",
            "-fPIC",
            "-shared",
            str(CPP / "pty_core.c"),
            "-o",
            str(out),
            "-lutil",
            "-lpthread",
        ],
        check=True,
    )
    c = ctypes.CDLL(str(out))
    c.pf_spawn.argtypes = [
        ctypes.c_char_p,
        ctypes.POINTER(ctypes.c_char_p),
        ctypes.POINTER(ctypes.c_char_p),
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.POINTER(ctypes.c_int),
        ctypes.POINTER(ctypes.c_int),
    ]
    c.pf_read.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t]
    c.pf_write_all.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_size_t]
    return c


class Shell:
    def __init__(
        self,
        lib,
        command,
        *,
        rows=24,
        cols=80,
        cwd=None,
        env=None,
        file="/bin/sh",
        argv=None,
    ):
        self.lib = lib
        argv = argv or ["sh", "-c", command]
        argv_c = (ctypes.c_char_p * (len(argv) + 1))(*[a.encode() for a in argv], None)
        env = (
            env
            if env is not None
            else {"PATH": "/usr/bin:/bin", "TERM": "xterm-256color"}
        )
        env_c = (ctypes.c_char_p * (len(env) + 1))(
            *[f"{k}={v}".encode() for k, v in env.items()], None
        )
        fd, pid = ctypes.c_int(), ctypes.c_int()
        rc = lib.pf_spawn(
            file.encode(),
            argv_c,
            env_c,
            cwd.encode() if cwd else None,
            rows,
            cols,
            ctypes.byref(fd),
            ctypes.byref(pid),
        )
        assert rc == 0, rc
        self.fd, self.pid = fd.value, pid.value

    def write(self, text: str):
        data = text.encode()
        assert self.lib.pf_write_all(self.fd, data, len(data)) == 0

    def read_all(self) -> str:
        chunks = []
        buf = ctypes.create_string_buffer(4096)
        while True:
            n = self.lib.pf_read(self.fd, buf, 4096)
            if n <= 0:
                break
            chunks.append(buf.raw[:n])
        return b"".join(chunks).decode(errors="replace")

    def finish(self) -> int:
        code = self.lib.pf_wait(self.pid)
        self.lib.pf_close(self.fd)
        return code


def test_output_and_exit_status(lib):
    sh = Shell(lib, "echo hello; exit 3")
    assert "hello" in sh.read_all()
    assert sh.finish() == 3


def test_it_is_a_terminal_with_the_requested_size(lib):
    sh = Shell(lib, "[ -t 0 ] && [ -t 1 ] && echo tty; stty size", rows=30, cols=100)
    out = sh.read_all()
    assert "tty" in out
    assert "30 100" in out
    sh.finish()


def test_resize_reaches_the_program(lib):
    sh = Shell(lib, "sleep 0.4; stty size", rows=24, cols=80)
    assert lib.pf_set_size(sh.fd, 17, 61) == 0
    assert "17 61" in sh.read_all()
    sh.finish()


def test_utf8_mode_is_on_so_backspace_erases_whole_characters(lib):
    sh = Shell(lib, "stty -a")
    assert "iutf8" in sh.read_all().replace("-iutf8", "NOT")  # present and not negated
    sh.finish()


def test_start_directory_and_exact_environment(lib, tmp_path):
    sh = Shell(
        lib,
        "pwd; echo FOO=$FOO; echo HOME=${HOME:-unset}",
        cwd=str(tmp_path),
        env={"PATH": "/usr/bin:/bin", "FOO": "bar"},
    )
    out = sh.read_all()
    assert str(tmp_path) in out
    assert "FOO=bar" in out
    assert "HOME=unset" in out, "the shell must get only the environment it was given"
    sh.finish()


def test_typing_and_echo(lib):
    sh = Shell(lib, "read line; echo got:$line")
    sh.write("typed\n")
    out = sh.read_all()
    assert "got:typed" in out
    assert out.count("typed") >= 2, "the terminal echoes what is typed"
    sh.finish()


def test_ctrl_c_is_sigint_for_the_foreground_job(lib):
    sh = Shell(lib, "sleep 30")
    time.sleep(0.2)
    sh.write("\x03")
    assert sh.finish() == 128 + signal.SIGINT


def test_signal_group_stops_the_shell_and_its_children(lib):
    sh = Shell(lib, "sleep 30 & sleep 30; wait")
    time.sleep(0.2)
    assert lib.pf_signal_group(sh.pid, signal.SIGHUP) == 0
    assert sh.finish() == 128 + signal.SIGHUP
    time.sleep(0.2)
    leftovers = subprocess.run(
        ["pgrep", "-f", "^sleep 30$"], capture_output=True, text=True
    ).stdout.split()
    for pid in leftovers:  # clean up if the group kill missed something
        os.kill(int(pid), signal.SIGKILL)
    assert not leftovers, "no stray 'sleep 30' may survive the hang-up"


def test_signal_sent_immediately_after_spawn_is_not_lost(lib):
    # The child starts with the parent's signal handlers; the signal must wait
    # for the reset instead of being eaten by an inherited handler.
    for _ in range(5):
        sh = Shell(lib, "sleep 30")
        assert lib.pf_signal_group(sh.pid, signal.SIGTERM) == 0
        t = time.time()
        assert sh.finish() == 128 + signal.SIGTERM
        assert time.time() - t < 5


def test_the_apps_other_file_descriptors_do_not_leak_into_the_shell(lib):
    leaked = os.open("/dev/null", os.O_RDONLY)
    os.dup2(leaked, 57)
    os.set_inheritable(57, True)
    try:
        sh = Shell(lib, "ls /proc/self/fd")
        fds = sh.read_all().split()
        sh.finish()
    finally:
        os.close(57)
        os.close(leaked)
    assert "57" not in fds
    assert {"0", "1", "2"} <= set(fds)


def test_a_program_that_cannot_start_exits_127_with_a_message(lib):
    sh = Shell(lib, "", file="/no/such/program", argv=["x"])
    assert "cannot start" in sh.read_all()
    assert sh.finish() == 127


def test_a_missing_start_directory_still_gives_a_shell(lib):
    sh = Shell(lib, "echo still-here", cwd="/no/such/dir")
    out = sh.read_all()
    assert "still-here" in out
    assert "cannot enter" in out
    sh.finish()


def test_read_returns_zero_once_the_shell_has_gone(lib):
    sh = Shell(lib, "true")
    sh.read_all()
    buf = ctypes.create_string_buffer(16)
    assert lib.pf_read(sh.fd, buf, 16) == 0
    sh.finish()
