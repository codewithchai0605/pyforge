"""Runs a shell on a pseudo-terminal and speaks newline-delimited JSON on
stdin/stdout. It is the desktop stand-in for the Android PTY plugin
(TerminalPlugin.kt + pty_core.c): the dev bridge spawns one of these per
terminal session, so the terminal UI can be developed and tested in a normal
browser against a real shell.

  stdout (events)   {"t":"out","b":"<base64 bytes>"}     shell output
                    {"t":"exit","code":0}                the shell ended (128+N if killed by signal N)
  stdin  (commands) {"op":"in","d":"text"}               keystrokes
                    {"op":"resize","cols":80,"rows":24}
                    {"op":"close"}                       hang up (SIGHUP, then SIGKILL)

When stdin closes (the bridge went away) the shell is hung up too.
"""
import argparse
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import threading

_out_lock = threading.Lock()


def emit(obj):
    with _out_lock:
        sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def set_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=80)
    ap.add_argument("--rows", type=int, default=24)
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--shell", default="")
    args = ap.parse_args()

    shell = args.shell or os.environ.get("SHELL") or "/bin/sh"
    env = dict(os.environ)
    env.update(TERM="xterm-256color", COLORTERM="truecolor", LANG=env.get("LANG", "C.UTF-8"))

    pid, fd = pty.fork()
    if pid == 0:  # child: becomes the shell
        try:
            os.chdir(args.cwd)
        except OSError:
            pass
        try:
            os.execvpe(shell, [shell, "-i"], env)
        finally:
            os._exit(127)

    set_size(fd, args.rows, args.cols)
    alive = threading.Event()
    alive.set()

    def hang_up():
        try:
            os.killpg(pid, signal.SIGHUP)
        except OSError:
            return
        threading.Timer(1.0, lambda: _kill(pid)).start()

    def _kill(p):
        try:
            os.killpg(p, signal.SIGKILL)
        except OSError:
            pass

    def read_commands():
        for line in sys.stdin:
            try:
                cmd = json.loads(line)
            except ValueError:
                continue
            op = cmd.get("op")
            try:
                if op == "in":
                    data = cmd.get("d", "").encode("utf-8")
                    while data:
                        n = os.write(fd, data)
                        data = data[n:]
                elif op == "resize":
                    set_size(fd, int(cmd["rows"]), int(cmd["cols"]))
                elif op == "close":
                    hang_up()
            except OSError:
                pass
        hang_up()  # the bridge closed our stdin

    threading.Thread(target=read_commands, daemon=True).start()

    while True:
        try:
            ready, _, _ = select.select([fd], [], [], 0.5)
        except (OSError, ValueError):
            break
        if not ready:
            continue
        try:
            chunk = os.read(fd, 16384)
        except OSError:  # EIO: the slave side is closed, the shell has gone
            break
        if not chunk:
            break
        emit({"t": "out", "b": base64.b64encode(chunk).decode("ascii")})

    try:
        _, status = os.waitpid(pid, 0)
    except ChildProcessError:
        status = 0
    code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)
    emit({"t": "exit", "code": code})


if __name__ == "__main__":
    main()