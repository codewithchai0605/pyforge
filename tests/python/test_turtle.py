import math

import pytest


def cmds(host, op):
    return [c for c in host.gui_cmds() if c[0] == op]


def test_import_turtle_works_without_tkinter(host, script):
    host.run(path=script("import turtle, sys\nprint('tkinter' in sys.modules, turtle.__name__)"))
    host.finish()
    assert host.stdout.strip() == "False pyforge.shims.turtle"
    assert host.stderr == ""


def test_square_geometry_and_state(host, script):
    host.run(path=script(
        "import turtle\nt = turtle.Turtle()\nt.speed(0)\n"
        "for _ in range(4):\n    t.forward(100)\n    t.left(90)\n"
        "print(t.pos(), t.heading(), t.xcor(), t.ycor())\n"
        "t.goto(30, 40)\nprint(round(t.distance(0, 0), 3), round(t.towards(0, 0), 1))\n"
    ))
    host.finish()
    lines = host.stdout.splitlines()
    assert lines[0] == "(0.00,0.00) 0.0 0.0 0.0", lines[0]
    assert lines[1] == "50.0 233.1"
    moves = cmds(host, "m")
    assert len(moves) == 5
    x0, y0, x1, y1 = moves[0][2:6]
    assert (x0, y0) == (0, 0) and (round(x1), round(y1)) == (100, 0)
    assert moves[0][6] == 0  # speed 0 => no animation time


def test_pen_up_moves_do_not_draw(host, script):
    host.run(path=script("import turtle\nt = turtle.Turtle()\nt.speed(0)\nt.penup()\nt.forward(10)\nt.pendown()\nt.forward(10)"))
    host.finish()
    downs = [m[7] for m in cmds(host, "m")]
    assert downs == [0, 1]


def test_circle_heading_and_points(host, script):
    host.run(path=script(
        "import turtle\nt = turtle.Turtle()\nt.speed(0)\nt.circle(50)\nprint(round(t.heading(), 6))\n"
        "print(round(abs(t.pos()), 3))\nt.circle(-50, 90)\nprint(round(t.heading() % 360, 3))\n"))
    host.finish()
    full, back, after = host.stdout.split()
    assert float(full) in (0.0, 360.0)
    assert float(back) < 0.5  # a full circle returns to the start
    assert abs(float(after) - 270.0) < 0.01  # -90 degrees from 0, clockwise arc


def test_fill_commands(host, script):
    host.run(path=script(
        "import turtle\nt = turtle.Turtle()\nt.speed(0)\nt.fillcolor('red')\nt.begin_fill()\n"
        "for _ in range(3):\n    t.forward(50); t.left(120)\nt.end_fill()\nprint(t.filling())"))
    host.finish()
    ef = cmds(host, "ef")[0]
    assert ef[2] == "red" and len(ef[3]) == 4  # start + 3 visited points
    assert host.stdout.strip() == "False"


def test_colors(host, script):
    host.run(path=script(
        "import turtle\nt = turtle.Turtle()\nt.color('gray50', (0, 128, 255))\nprint(t.color())\n"
        "turtle.colormode(255)\nt.pencolor((255, 0, 0))\nt.fillcolor('#0a0b0c')\nt.dot(10, 'blue')"))
    host.finish()
    last_color = cmds(host, "color")[-1]
    assert last_color[2] == "#ff0000" and last_color[3] == "#0a0b0c"
    assert cmds(host, "dot")[0][5] == "blue"
    assert "('gray50', (0, 128, 255))" in host.stdout


def test_animation_blocks_for_roughly_the_animation_time(host, script):
    host.run(path=script(
        "import turtle, time\nt = turtle.Turtle()\nt.speed(3)\nt0 = time.time()\nt.forward(200)\nprint(time.time() - t0 > 0.1)"))
    host.finish()
    ms = cmds(host, "m")[0][6]
    assert ms >= 100
    assert host.stdout.strip() == "True"


def test_write_stamp_shape_and_module_level_api(host, script):
    host.run(path=script(
        "from turtle import *\nspeed(0)\nshape('turtle')\nbgcolor('black')\ntitle('Demo')\nsetup(500, 400)\n"
        "write('hi', align='center', font=('Arial', 20, 'bold'))\nstamp()\nhideturtle()\nprint(isvisible(), shape())"))
    host.finish()
    assert host.stdout.strip() == "False turtle"
    w = cmds(host, "w")[0]
    assert w[4] == "hi" and w[7] == 20 and w[8] == "bold"
    assert cmds(host, "bg")[0][1] == "black" and cmds(host, "title")[0][1] == "Demo"
    assert [c[1:] for c in cmds(host, "setup")][-1] == [500, 400]
    assert len(cmds(host, "stamp")) == 1


def test_key_click_and_timer_events_run_via_mainloop(host, script):
    host.run(path=script(
        "import turtle\nt = turtle.Turtle()\nt.speed(0)\ns = turtle.Screen()\n"
        "def up():\n    t.forward(10); print('up', t.ycor() == 0 and t.xcor())\n"
        "def clicked(x, y):\n    print('click', x, y)\n"
        "s.onkey(up, 'Up')\ns.onscreenclick(clicked)\ns.listen()\n"
        "s.ontimer(lambda: print('timer'), 100)\nturtle.done()\nprint('after done')"))
    host.wait_for(lambda e: e["t"] == "gui" and ["done"] in e["cmds"])
    assert ["keys", ["Up"]] in host.gui_cmds()
    host.send(op="gui", event={"k": "key", "key": "Up", "down": False})
    host.send(op="gui", event={"k": "click", "x": 12.5, "y": -3})
    host.wait_for(lambda e: e["t"] == "out" and "timer" in e["s"])
    host.send(op="gui", event={"k": "close"})
    host.finish()
    assert "up 10.0" in host.stdout and "click 12.5 -3.0" in host.stdout and "timer" in host.stdout
    assert host.stdout.strip().endswith("after done")


def test_textinput_dialog_roundtrip(host, script):
    host.run(path=script("import turtle\nturtle.Turtle()\nprint('got', turtle.textinput('Name', 'Your name?'))"))
    ask = host.wait_for(lambda e: e["t"] == "gui" and any(c[0] == "ask" for c in e["cmds"]))
    cmd = [c for c in ask["cmds"] if c[0] == "ask"][0]
    assert cmd[2:] == ["text", "Name", "Your name?"]
    host.send(op="gui", event={"k": "answer", "id": cmd[1], "value": "Grace"})
    host.finish()
    assert host.stdout.strip() == "got Grace"


def test_closing_window_ends_script_quietly(host, script):
    host.run(path=script("import turtle\nt = turtle.Turtle()\nt.speed(0)\nwhile True:\n    t.forward(1)\n    turtle.update()"))
    host.wait_for(lambda e: e["t"] == "gui")
    host.send(op="gui", event={"k": "close"})
    ev = host.finish()
    assert ev["code"] == 0 and host.stderr == ""


def test_clearscreen_and_multiple_turtles_have_distinct_ids(host, script):
    host.run(path=script(
        "import turtle\na = turtle.Turtle(); b = turtle.Turtle()\na.speed(0); b.speed(0)\n"
        "a.forward(5); b.forward(7)\nturtle.clearscreen()\nprint(len(turtle.turtles()))"))
    host.finish()
    ids = {m[1] for m in cmds(host, "m")}
    assert len(ids) == 2
    assert cmds(host, "clearscreen")
    assert host.stdout.strip() == "1"
