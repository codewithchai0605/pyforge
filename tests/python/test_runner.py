import json


def test_stdout_and_exit_code(host, script):
    host.run(path=script("print('hello'); print('world')"))
    ev = host.finish()
    assert host.stdout == "hello\nworld\n"
    assert ev["code"] == 0


def test_stderr_is_separate_and_ordered(host, script):
    host.run(path=script("import sys\nprint('a')\nprint('b', file=sys.stderr)\nprint('c')"))
    host.finish()
    kinds = [(e["t"], e["s"]) for e in host.events if e["t"] in ("out", "err")]
    assert kinds == [("out", "a\n"), ("err", "b\n"), ("out", "c\n")]


def test_traceback_hides_runner_frames_and_exit_code_1(host, script):
    host.run(path=script("def f():\n    1/0\nf()\n"))
    ev = host.finish()
    assert ev["code"] == 1
    assert "ZeroDivisionError" in host.stderr
    assert "main.py" in host.stderr and 'line 3, in <module>' in host.stderr
    assert "runner.py" not in host.stderr, host.stderr


def test_syntax_error_reported_cleanly(host, script):
    host.run(path=script("print('x'\n"))
    ev = host.finish()
    assert ev["code"] == 1
    assert "SyntaxError" in host.stderr and "runner.py" not in host.stderr


def test_sys_exit_codes(host, script):
    host.run(path=script("import sys; sys.exit(7)"))
    assert host.finish()["code"] == 7


def test_input_roundtrip(host, script):
    host.run(path=script("name = input('Name? ')\nprint('Hi,', name)\nn = int(input())\nprint(n * 2)"))
    ev = host.wait_for(lambda e: e["t"] == "input")
    assert ev["prompt"] == "Name? "
    host.send(op="stdin", text="Ada\n")
    host.wait_for(lambda e: e["t"] == "input" and e is not ev)
    host.send(op="stdin", text="21\n")
    assert host.finish()["code"] == 0
    assert host.stdout == "Name? Hi, Ada\n42\n"


def test_input_eof_raises(host, script):
    host.run(path=script("try:\n    input()\nexcept EOFError:\n    print('eof')"))
    host.wait_for(lambda e: e["t"] == "input")
    host.send(op="stdin", text=None)
    host.finish()
    assert host.stdout == "eof\n"


def test_sys_stdin_read_until_eof(host, script):
    host.run(path=script("import sys\nprint(sys.stdin.read().upper())"))
    host.wait_for(lambda e: e["t"] == "input")
    host.send(op="stdin", text="abc\n")
    host.wait_for(lambda e: e["t"] == "input" and e is not None, 5)
    host.send(op="stdin", text=None)
    host.finish()
    assert host.stdout.strip() == "ABC"


def test_cwd_and_sibling_imports(host, script):
    script("VALUE = 41", name="helper.py")
    host.run(path=script("import helper, os\nprint(helper.VALUE + 1)\nprint(os.path.basename(os.getcwd()))"))
    host.finish()
    assert host.stdout == "42\nprojects\n"


def test_argv_and_main_name(host, script):
    host.run(path=script("import sys\nprint(__name__, sys.argv[1:], __file__.endswith('main.py'))"), args=["a", "b"])
    host.finish()
    assert host.stdout.strip() == "__main__ ['a', 'b'] True"


def test_unbuffered_output_streams_before_exit(host, script):
    host.run(path=script("import time\nprint('first', flush=True)\ntime.sleep(1.5)\nprint('second')"))
    host.wait_for(lambda e: e["t"] == "out" and "first" in e["s"], 1.2)  # arrives while still running
    host.finish()


def test_heavy_output_is_coalesced(host, script):
    host.run(path=script("for i in range(20000):\n    print(i)"))
    host.finish()
    out_events = [e for e in host.events if e["t"] == "out"]
    assert len(out_events) < 400, len(out_events)  # not one event per print
    assert host.stdout.count("\n") == 20000


def test_non_daemon_threads_are_joined(host, script):
    host.run(path=script("import threading, time\nthreading.Thread(target=lambda:(time.sleep(0.4), print('late'))).start()\nprint('main done')"))
    host.finish()
    assert host.stdout == "main done\nlate\n"


def test_tkinter_gives_helpful_error_and_find_spec_does_not_raise(host, script):
    host.run(path=script(
        "import importlib.util\nprint(importlib.util.find_spec('tkinter') is not None)\n"
        "try:\n    import tkinter\nexcept ImportError as e:\n    print('ERR', e)\n"))
    host.finish()
    assert "ERR tkinter isn't available in PyForge" in host.stdout


def test_stop_by_killing_process_ends_infinite_loop(host, script):
    host.run(path=script("while True:\n    pass"))
    host.wait_for(lambda e: e["t"] == "started")
    host.kill()
    host.proc.wait(timeout=5)


def test_repl(host):
    host.run(mode="repl")
    host.wait_for(lambda e: e["t"] == "input")
    host.send(op="stdin", text="x = 6 * 7\n")
    host.wait_for(lambda e: e["t"] == "input" and e is not None, 5)
    host.send(op="stdin", text="x\n")
    host.wait_for(lambda e: e["t"] == "out" and "42" in e["s"], 5)
    host.send(op="stdin", text=None)
    assert host.finish()["code"] == 0
