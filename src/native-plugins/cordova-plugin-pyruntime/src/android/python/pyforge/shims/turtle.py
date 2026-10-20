"""turtle for PyForge: the familiar API, drawn on an HTML canvas.

CPython's own `turtle` is a thin layer over tkinter, and Android has no Tk.
This module keeps the *API* (so tutorials and `from turtle import *` scripts
run unchanged) but replaces the drawing back-end:

  Python side (this file)   all state and geometry: position, heading, pen,
                            fill paths, colours, event handlers, timers.
                            Queries like pos() / heading() / distance() are
                            answered instantly, here, never by asking the UI.
  UI side (turtleScene.ts)  receives compact commands and animates/draws them.

Commands are JSON arrays, first item = opcode, batched into {"t":"gui",...}
events (see core.py). Coordinates are the turtle's own: origin at the centre,
y pointing up, angles in degrees counter-clockwise from east.

  ["setup",w,h]  ["bg",css]  ["title",s]  ["world",llx,lly,urx,ury]
  ["m",tid,x0,y0,x1,y1,ms,down,css,width]        straight move (draws if down)
  ["p",tid,[[x,y],..],ms,down,css,width,head]    polyline move (circles)
  ["t",tid,h0,h1,ms]                             turn in place
  ["pos",tid,x,y,head]                           teleport the cursor
  ["dot",tid,x,y,size,css]   ["w",tid,x,y,text,align,family,size,style,css]
  ["bf",tid]  ["ef",tid,css,[[x,y],..]]          begin/end fill
  ["stamp",sid,tid,x,y,head,shape,sx,sy,outline,pen,fill]  ["unstamp",sid]
  ["clear",tid]  ["clearscreen"]
  ["shape",tid,name]  ["color",tid,pen,fill]  ["size",tid,sx,sy,outline]
  ["vis",tid,0|1]  ["keys",[names]]  ["ask",id,kind,title,prompt]
  ["shapedef",name,[[x,y],..]]  ["done"]  ["bye"]

Known differences from tkinter's turtle (documented in the README):
undo() restores position/heading but does not erase drawings; there is no
getcanvas()/tkinter embedding; bgpic() and image shapes are not supported.
"""

from __future__ import annotations

import heapq
import math
import queue
import sys
import time
from typing import Any, Callable, Optional

from .. import core

__all__ = [
    # classes
    "Turtle", "Pen", "RawTurtle", "RawPen", "Screen", "TurtleScreen", "ScrolledCanvas",
    "Shape", "Vec2D", "Terminator", "TNavigator", "TPen", "TurtleScreenBase",
    # turtle methods as functions
    "back", "backward", "begin_fill", "begin_poly", "bk", "circle", "clear", "clearstamp",
    "clearstamps", "clone", "color", "degrees", "distance", "dot", "down", "end_fill",
    "end_poly", "fd", "fillcolor", "filling", "forward", "get_poly", "getpen", "getscreen",
    "get_shapepoly", "getturtle", "goto", "heading", "hideturtle", "home", "ht", "isdown",
    "isvisible", "left", "lt", "onclick", "ondrag", "onrelease", "pd", "pen", "pencolor",
    "pendown", "pensize", "penup", "pos", "position", "pu", "radians", "right", "reset",
    "resizemode", "rt", "seth", "setheading", "setpos", "setposition", "settiltangle",
    "setundobuffer", "setx", "sety", "shape", "shapesize", "shapetransform", "shearfactor",
    "showturtle", "speed", "st", "stamp", "teleport", "tilt", "tiltangle", "towards",
    "turtlesize", "undo", "undobufferentries", "up", "width", "write", "xcor", "ycor",
    # screen methods as functions
    "addshape", "bgcolor", "bgpic", "bye", "clearscreen", "colormode", "delay", "exitonclick",
    "getcanvas", "getshapes", "listen", "mainloop", "mode", "numinput", "onkey", "onkeypress",
    "onkeyrelease", "onscreenclick", "ontimer", "register_shape", "resetscreen", "screensize",
    "setup", "setworldcoordinates", "textinput", "title", "tracer", "turtles", "update",
    "window_height", "window_width", "done",
]


class Terminator(SystemExit):
    """Raised inside drawing calls once the turtle window was closed.

    Subclasses SystemExit (real turtle: Exception) so a closed window ends
    the script quietly instead of printing a traceback, and so user code with
    a broad `except Exception:` can't swallow it and keep running.
    """


# ----------------------------------------------------------------- Vec2D
class Vec2D(tuple):
    """A 2-D vector, the type pos() returns (same operators as stdlib turtle)."""

    def __new__(cls, x, y):
        return tuple.__new__(cls, (x, y))

    def __add__(self, other):
        return Vec2D(self[0] + other[0], self[1] + other[1])

    def __mul__(self, other):
        if isinstance(other, Vec2D):
            return self[0] * other[0] + self[1] * other[1]
        return Vec2D(self[0] * other, self[1] * other)

    def __rmul__(self, other):
        if isinstance(other, (int, float)):
            return Vec2D(self[0] * other, self[1] * other)
        return NotImplemented

    def __sub__(self, other):
        return Vec2D(self[0] - other[0], self[1] - other[1])

    def __neg__(self):
        return Vec2D(-self[0], -self[1])

    def __abs__(self):
        return math.hypot(self[0], self[1])

    def rotate(self, angle):
        """Rotate counter-clockwise by `angle` degrees."""
        a = math.radians(angle)
        c, s = math.cos(a), math.sin(a)
        return Vec2D(self[0] * c - self[1] * s, self[0] * s + self[1] * c)

    def __getnewargs__(self):
        return (self[0], self[1])

    def __repr__(self):
        return "(%.2f,%.2f)" % self


class Shape:
    """A custom shape: Shape("polygon", ((x, y), ...))."""

    def __init__(self, type_, data=None):
        self._type = type_
        self._data = data

    def addcomponent(self, poly, fill, outline=None):
        self._data = [tuple(p) for p in poly]


# --------------------------------------------------------------- colours
_TK_GREY = {}  # populated lazily: "gray37" -> "#5e5e5e"


def _css_color(spec: Any, colormode: float) -> str:
    """Turn any turtle colour spec into something a canvas understands."""
    if isinstance(spec, str):
        s = spec.strip().lower()
        if s.startswith("#") or s == "":
            return spec
        # Tk has grey0..grey100 and name1..name4 shades; CSS has neither.
        if s.startswith(("gray", "grey")) and s[4:].isdigit():
            level = round(int(s[4:]) * 255 / 100)
            return "#%02x%02x%02x" % (level, level, level)
        if s[-1:] in "1234" and s[:-1].isalpha():
            return s[:-1]  # "red4" -> "red"; close enough for a hint of shade
        return s
    if isinstance(spec, (tuple, list)) and len(spec) == 3:
        r, g, b = (float(v) for v in spec)
        scale = 255.0 / colormode
        return "#%02x%02x%02x" % tuple(max(0, min(255, int(round(v * scale)))) for v in (r, g, b))
    raise TypeError(f"bad color argument: {spec!r}")


def _norm_color_args(args: tuple) -> Any:
    if len(args) == 1:
        return args[0]
    if len(args) == 3:
        return tuple(args)
    raise TypeError(f"bad color arguments: {args!r}")


_SPEEDS = {"fastest": 0, "fast": 10, "normal": 6, "slow": 3, "slowest": 1}
_HOP_MS = 3  # ms of UI animation per "delay" millisecond; tuned to feel like Tk

# ---------------------------------------------------------------- screen


class _Screen:
    """The single window. `Screen()` always returns the same instance."""

    _instance: Optional["_Screen"] = None

    def __init__(self) -> None:
        self._session = core.current_session()
        self._buf: list = []
        self._turtles: list["Turtle"] = []
        self._next_tid = 0
        self._next_sid = 0
        self._tracing = 1
        self._delay_ms = 10
        self._colormode = 1.0
        self._mode = "standard"
        self._closed = False
        self._width = 640
        self._height = 640
        self._bgcolor = "white"
        self._key_press: dict[Optional[str], Callable] = {}
        self._key_release: dict[Optional[str], Callable] = {}
        self._click: list[Callable] = []
        self._timers: list[tuple[float, int, Callable]] = []
        self._timer_seq = 0
        self._answers: dict[int, Any] = {}
        self._ask_id = 0
        self._last_update = 0.0
        self._shapes = {"classic", "arrow", "turtle", "circle", "square", "triangle", "blank"}
        self._emit(["setup", self._width, self._height])
        self._session.exit_hooks.append(self._flush)

    # -- plumbing ------------------------------------------------------
    def _emit(self, cmd: list) -> None:
        self._buf.append(cmd)
        if len(self._buf) >= 400:
            self._flush()

    def _flush(self) -> None:
        if self._buf:
            batch, self._buf = self._buf, []
            self._session.emit(t="gui", cmds=batch)

    def _check_open(self) -> None:
        if self._closed:
            raise Terminator()

    def _sleep(self, seconds: float) -> None:
        """Wait for the UI's animation, staying responsive to events."""
        self._flush()
        end = time.time() + seconds
        while True:
            self._process_events()
            self._check_open()
            remaining = end - time.time()
            if remaining <= 0:
                return
            time.sleep(min(remaining, 0.01))

    def _process_events(self, block: float = 0.0) -> None:
        """Run due timers and queued UI events (clicks, keys, dialogs)."""
        q = self._session.gui_q
        while True:
            try:
                ev = q.get(timeout=block) if block else q.get_nowait()
            except queue.Empty:
                break
            block = 0.0
            self._dispatch(ev)
        now = time.time()
        while self._timers and self._timers[0][0] <= now:
            _, _, fun = heapq.heappop(self._timers)
            fun()

    def _dispatch(self, ev: dict) -> None:
        kind = ev.get("k")
        if kind == "close":
            self._closed = True
        elif kind == "click":
            x, y = float(ev["x"]), float(ev["y"])
            for t in list(self._turtles):
                if t._on_click and t._hit(x, y):
                    t._on_click(x, y)
            for fun in list(self._click):
                fun(x, y)
        elif kind == "key":
            key = ev.get("key")
            table = self._key_press if ev.get("down", True) else self._key_release
            fun = table.get(key) or table.get(None)
            if fun:
                fun()
        elif kind == "answer":
            self._answers[int(ev["id"])] = ev.get("value")

    def _ask(self, kind: str, title: str, prompt: str) -> Any:
        self._ask_id += 1
        ident = self._ask_id
        self._emit(["ask", ident, kind, title, prompt])
        self._flush()
        while ident not in self._answers:
            self._process_events(block=0.05)
            self._check_open()
        return self._answers.pop(ident)

    # -- Screen API ----------------------------------------------------
    def bgcolor(self, *args):
        if not args:
            return self._bgcolor
        self._bgcolor = _css_color(_norm_color_args(args), self._colormode)
        self._emit(["bg", self._bgcolor])

    def bgpic(self, picname=None):
        return "nopic"

    def title(self, titlestring):
        self._emit(["title", str(titlestring)])

    def setup(self, width=0.5, height=0.75, startx=None, starty=None):
        base = 800
        w = int(width * base) if isinstance(width, float) and width <= 1 else int(width)
        h = int(height * base) if isinstance(height, float) and height <= 1 else int(height)
        self._width, self._height = max(50, w), max(50, h)
        self._emit(["setup", self._width, self._height])

    def screensize(self, canvwidth=None, canvheight=None, bg=None):
        if canvwidth is None and canvheight is None and bg is None:
            return (self._width, self._height)
        if canvwidth:
            self._width = int(canvwidth)
        if canvheight:
            self._height = int(canvheight)
        self._emit(["setup", self._width, self._height])
        if bg:
            self.bgcolor(bg)

    def window_width(self):
        return self._width

    def window_height(self):
        return self._height

    def setworldcoordinates(self, llx, lly, urx, ury):
        self._emit(["world", llx, lly, urx, ury])

    def mode(self, mode=None):
        if mode is None:
            return self._mode
        mode = mode.lower()
        if mode not in ("standard", "logo", "world"):
            raise ValueError("bad mode value %s" % mode)
        self._mode = mode
        for t in self._turtles:
            t._set_mode(mode)

    def colormode(self, cmode=None):
        if cmode is None:
            return self._colormode
        if cmode not in (1, 1.0, 255):
            raise ValueError("colormode must be 1.0 or 255")
        self._colormode = float(cmode)

    def delay(self, delay=None):
        if delay is None:
            return self._delay_ms
        self._delay_ms = max(0, int(delay))

    def tracer(self, n=None, delay=None):
        if n is None:
            return self._tracing
        self._tracing = int(n)
        if delay is not None:
            self._delay_ms = int(delay)
        self.update()

    def update(self):
        """Flush drawing, process events; never faster than ~120 Hz."""
        self._check_open()
        self._flush()
        self._process_events()
        elapsed = time.time() - self._last_update
        if elapsed < 0.008:
            time.sleep(0.008 - elapsed)
        self._last_update = time.time()
        self._check_open()

    def clearscreen(self):
        self._emit(["clearscreen"])
        for t in list(self._turtles):
            t._reset_state()
        self._turtles = self._turtles[:1]
        self._bgcolor = "white"
        # The UI wipes every cursor on clearscreen; the turtle that survives
        # has to announce itself again.
        for t in self._turtles:
            t._emit_appearance()
            t._emit(["pos", t._tid, 0, 0, t._h])
        self._key_press.clear()
        self._key_release.clear()
        self._click.clear()
        self._timers.clear()

    clear = clearscreen

    def resetscreen(self):
        for t in self._turtles:
            t.reset()

    def turtles(self):
        return list(self._turtles)

    def getcanvas(self):
        raise NotImplementedError("getcanvas() needs tkinter, which isn't available on Android.")

    def getshapes(self):
        return sorted(self._shapes)

    def register_shape(self, name, shape=None):
        if isinstance(shape, Shape):
            data = shape._data
        elif isinstance(shape, (tuple, list)):
            data = shape
        else:
            raise NotImplementedError("Only polygon shapes can be registered in PyForge.")
        pts = [[float(x), float(y)] for x, y in data]
        self._shapes.add(name)
        self._emit(["shapedef", name, pts])

    addshape = register_shape

    # events
    def listen(self, xdummy=None, ydummy=None):
        self._announce_keys()

    def onkey(self, fun, key):
        self.onkeyrelease(fun, key)

    def onkeyrelease(self, fun, key):
        _set_handler(self._key_release, key, fun)
        self._announce_keys()

    def onkeypress(self, fun, key=None):
        _set_handler(self._key_press, key, fun)
        self._announce_keys()

    def onscreenclick(self, fun, btn=1, add=None):
        if fun is None:
            self._click.clear()
        else:
            if not add:
                self._click.clear()
            self._click.append(fun)

    onclick = onscreenclick

    def _announce_keys(self) -> None:
        names = sorted({k for k in [*self._key_press, *self._key_release] if k})
        self._emit(["keys", names])

    def ontimer(self, fun, t=0):
        self._timer_seq += 1
        heapq.heappush(self._timers, (time.time() + t / 1000.0, self._timer_seq, fun))

    def mainloop(self):
        """Block, serving events and timers, until the window is closed."""
        self._flush()
        self._emit(["done"])
        self._flush()
        while not self._closed:
            wait = 0.05
            if self._timers:
                wait = max(0.0, min(wait, self._timers[0][0] - time.time()))
            self._process_events(block=wait)

    done = mainloop

    def bye(self):
        self._flush()
        self._emit(["bye"])
        self._flush()
        self._closed = True

    def exitonclick(self):
        fired = []

        def on_click(x, y):
            fired.append(True)

        self.onscreenclick(on_click)
        self._flush()
        self._emit(["done"])
        self._flush()
        while not fired and not self._closed:
            self._process_events(block=0.05)
        self.bye()

    def textinput(self, title, prompt):
        value = self._ask("text", str(title), str(prompt))
        return None if value is None else str(value)

    def numinput(self, title, prompt, default=None, minval=None, maxval=None):
        while True:
            value = self._ask("num", str(title), str(prompt))
            if value is None:
                return None
            try:
                num = float(value)
            except (TypeError, ValueError):
                continue
            if (minval is not None and num < minval) or (maxval is not None and num > maxval):
                continue
            return num


def _set_handler(table: dict, key: Optional[str], fun: Optional[Callable]) -> None:
    if fun is None:
        table.pop(key, None)
    else:
        table[key] = fun


def _screen() -> _Screen:
    if _Screen._instance is None:
        _Screen._instance = _Screen()
    return _Screen._instance


def Screen() -> _Screen:  # noqa: N802 - stdlib name
    return _screen()


TurtleScreen = _Screen
ScrolledCanvas = _Screen
TurtleScreenBase = _Screen


# ---------------------------------------------------------------- turtle
class Turtle:
    """A drawing turtle. Method names/semantics follow the stdlib module."""

    _pen_instance: Optional["Turtle"] = None

    def __init__(self, shape="classic", undobuffersize=1000, visible=True):
        self.screen = _screen()
        self.screen._check_open()
        self._tid = self.screen._next_tid
        self.screen._next_tid += 1
        self.screen._turtles.append(self)
        self._on_click: Optional[Callable] = None
        self._reset_state()
        self._shape = shape
        self._visible = bool(visible)
        self._emit_appearance()
        self._emit(["pos", self._tid, 0, 0, 0])

    # -- internal state --------------------------------------------------
    def _reset_state(self) -> None:
        self._x = 0.0
        self._y = 0.0
        self._h = 90.0 if self.screen._mode == "logo" else 0.0  # internal: math degrees, CCW from east
        self._down = True
        self._pencolor = "black"
        self._fillcolor = "black"
        self._pensize = 1.0
        self._speed = 3
        self._fullcircle = 360.0
        self._visible = True
        self._shape = getattr(self, "_shape", "classic")
        self._stretch = (1.0, 1.0)
        self._outline = 1.0
        self._tilt = 0.0
        self._fill_path: Optional[list] = None
        self._stamps: list[int] = []
        self._poly: Optional[list] = None
        self._history: list[tuple] = []

    def _set_mode(self, mode: str) -> None:
        self._h = 90.0 if mode == "logo" else 0.0

    def _emit(self, cmd: list) -> None:
        self.screen._emit(cmd)

    def _emit_appearance(self) -> None:
        self._emit(["shape", self._tid, self._shape])
        self._emit(["color", self._tid, self._pencolor, self._fillcolor])
        self._emit(["size", self._tid, self._stretch[0], self._stretch[1], self._outline])
        self._emit(["vis", self._tid, 1 if self._visible else 0])

    def _col(self, spec) -> str:
        return _css_color(spec, self.screen._colormode)

    # angle unit conversion: user units <-> degrees
    def _to_deg(self, angle: float) -> float:
        return angle * 360.0 / self._fullcircle

    def _from_deg(self, deg: float) -> float:
        return deg * self._fullcircle / 360.0

    def _animates(self) -> bool:
        return self.screen._tracing != 0 and self._speed != 0

    def _ms_for(self, distance: float = 0.0, angle: float = 0.0) -> int:
        if not self._animates():
            return 0
        step = 3 * 1.1 ** self._speed * self._speed
        hops = 1 + int(distance / step) if distance else 0
        hops = max(hops, 1 + int(abs(angle) / step)) if angle else hops
        return int(hops * max(self.screen._delay_ms, 1) * _HOP_MS)

    def _after(self, ms: int) -> None:
        self.screen._check_open()
        if ms > 0:
            self.screen._sleep(ms / 1000.0)
        elif len(self.screen._buf) >= 400:
            self.screen._flush()

    def _note_point(self) -> None:
        if self._fill_path is not None:
            self._fill_path.append([round(self._x, 3), round(self._y, 3)])
        if self._poly is not None:
            self._poly.append((self._x, self._y))

    def _hit(self, x: float, y: float) -> bool:
        return self._visible and math.hypot(x - self._x, y - self._y) <= 12 * max(self._stretch)

    def _push_history(self) -> None:
        self._history.append((self._x, self._y, self._h))
        if len(self._history) > 100:
            self._history.pop(0)

    # -- motion ---------------------------------------------------------
    def forward(self, distance):
        self.screen._check_open()
        self._push_history()
        rad = math.radians(self._h)
        self._goto_xy(self._x + distance * math.cos(rad), self._y + distance * math.sin(rad), abs(distance))

    fd = forward

    def back(self, distance):
        self.forward(-distance)

    backward = bk = back

    def left(self, angle):
        self._turn(self._to_deg(angle))

    lt = left

    def right(self, angle):
        self._turn(-self._to_deg(angle))

    rt = right

    def _turn(self, deg: float) -> None:
        self.screen._check_open()
        self._push_history()
        h0 = self._h
        self._h = h0 + deg
        self._emit(["t", self._tid, h0, self._h, self._ms_for(angle=deg)])
        self._after(self._ms_for(angle=deg))

    def _goto_xy(self, x: float, y: float, dist: Optional[float] = None) -> None:
        x0, y0 = self._x, self._y
        if dist is None:
            dist = math.hypot(x - x0, y - y0)
        # Rounded to 10 places (and "+ 0.0" turns -0.0 into 0.0) so a closed
        # square reports (0, 0), not (-1.8e-14, 1.4e-14); stdlib turtle does
        # the same for heading().
        self._x, self._y = round(float(x), 10) + 0.0, round(float(y), 10) + 0.0
        ms = self._ms_for(distance=dist)
        self._emit(["m", self._tid, x0, y0, self._x, self._y, ms, 1 if self._down else 0, self._col(self._pencolor), self._pensize])
        self._note_point()
        self._after(ms)

    def goto(self, x, y=None):
        if y is None:
            x, y = x
        self.screen._check_open()
        self._push_history()
        self._goto_xy(x, y)

    setpos = setposition = goto

    def teleport(self, x=None, y=None, *, fill_gap=False):
        self.screen._check_open()
        nx = self._x if x is None else x
        ny = self._y if y is None else y
        was, self._down = self._down, bool(fill_gap) and self._down
        pre = self.screen._tracing
        self.screen._tracing = 0
        self._goto_xy(nx, ny)
        self.screen._tracing = pre
        self._down = was

    def setx(self, x):
        self.goto(x, self._y)

    def sety(self, y):
        self.goto(self._x, y)

    def setheading(self, to_angle):
        deg = self._to_deg(to_angle)
        target = (90.0 - deg) if self.screen._mode == "logo" else deg
        delta = ((target - self._h + 180.0) % 360.0) - 180.0
        self._turn(delta)

    seth = setheading

    def home(self):
        self.goto(0, 0)
        self.setheading(0)

    def circle(self, radius, extent=None, steps=None):
        self.screen._check_open()
        self._push_history()
        if extent is None:
            extent = self._fullcircle
        frac = abs(extent) / self._fullcircle
        if steps is None:
            steps = 1 + int(min(11 + abs(radius) / 6.0, 59.0) * frac)
        w = 1.0 * self._to_deg(extent) / steps
        w2 = 0.5 * w
        seg = 2.0 * radius * math.sin(math.radians(w2))
        if radius < 0:
            seg, w, w2 = -seg, -w, -w2
        # Walk the polygon exactly like stdlib turtle: half a turn first, then
        # (segment, full turn) `steps` times. `w` is signed (negative radius
        # circles clockwise), so total rotation is steps * w either way.
        h = self._h + w2
        x, y = self._x, self._y
        pts = [[x, y]]
        for _ in range(steps):
            x += seg * math.cos(math.radians(h))
            y += seg * math.sin(math.radians(h))
            pts.append([round(x, 3), round(y, 3)])
            h += w
        self._h = self._h + w * steps
        arc = abs(2 * math.pi * radius * frac)
        ms = self._ms_for(distance=arc)
        self._emit(["p", self._tid, pts, ms, 1 if self._down else 0, self._col(self._pencolor), self._pensize, self._h])
        self._x, self._y = x, y
        for p in pts[1:]:
            if self._fill_path is not None:
                self._fill_path.append(p)
        if self._poly is not None:
            self._poly.append((x, y))
        self._after(ms)

    def dot(self, size=None, *color):
        self.screen._check_open()
        if size is None:
            size = max(self._pensize + 4, 2 * self._pensize)
        css = self._col(_norm_color_args(color)) if color else (
            self._col(size) if isinstance(size, str) else self._col(self._pencolor)
        )
        if isinstance(size, str):
            size = max(self._pensize + 4, 2 * self._pensize)
        self._emit(["dot", self._tid, self._x, self._y, size, css])
        self._after(0)

    def stamp(self):
        self.screen._check_open()
        sid = self.screen._next_sid
        self.screen._next_sid += 1
        self._stamps.append(sid)
        self._emit([
            "stamp", sid, self._tid, self._x, self._y, self._h, self._shape,
            self._stretch[0], self._stretch[1], self._outline,
            self._col(self._pencolor), self._col(self._fillcolor),
        ])
        self._after(0)
        return sid

    def clearstamp(self, stampid):
        if stampid in self._stamps:
            self._stamps.remove(stampid)
            self._emit(["unstamp", stampid])
            self._after(0)

    def clearstamps(self, n=None):
        ids = self._stamps[:] if n is None else (self._stamps[:n] if n >= 0 else self._stamps[n:])
        for sid in ids:
            self.clearstamp(sid)

    def undo(self):
        """Step back one movement. (Does not erase what that movement drew.)"""
        if self._history:
            self._x, self._y, self._h = self._history.pop()
            self._emit(["pos", self._tid, self._x, self._y, self._h])
            self._after(0)

    def setundobuffer(self, size):
        pass

    def undobufferentries(self):
        return len(self._history)

    def speed(self, speed=None):
        if speed is None:
            return self._speed
        if isinstance(speed, str):
            speed = _SPEEDS.get(speed, 3)
        speed = int(speed)
        self._speed = speed if 0.5 < speed < 10.5 else 0

    # -- tell state -------------------------------------------------------
    def position(self):
        return Vec2D(self._x, self._y)

    pos = position

    def xcor(self):
        return self._x

    def ycor(self):
        return self._y

    def heading(self):
        deg = (90.0 - self._h) % 360.0 if self.screen._mode == "logo" else self._h % 360.0
        return round(self._from_deg(deg), 10) + 0.0

    def towards(self, x, y=None):
        if y is None:
            x, y = x
        deg = math.degrees(math.atan2(y - self._y, x - self._x)) % 360.0
        if self.screen._mode == "logo":
            deg = (90.0 - deg) % 360.0
        return self._from_deg(deg)

    def distance(self, x, y=None):
        if y is None:
            if isinstance(x, Turtle):
                x, y = x._x, x._y
            else:
                x, y = x
        return math.hypot(x - self._x, y - self._y)

    def degrees(self, fullcircle=360.0):
        self._fullcircle = float(fullcircle)

    def radians(self):
        self._fullcircle = 2 * math.pi

    # -- pen ----------------------------------------------------------------
    def pendown(self):
        self._down = True

    pd = down = pendown

    def penup(self):
        self._down = False

    pu = up = penup

    def isdown(self):
        return self._down

    def pensize(self, width=None):
        if width is None:
            return self._pensize
        self._pensize = float(max(width, 0.0))
        self._emit(["size", self._tid, self._stretch[0], self._stretch[1], self._outline])

    width = pensize

    def pen(self, pen=None, **pendict):
        current = dict(
            shown=self._visible, pendown=self._down, pencolor=self._pencolor, fillcolor=self._fillcolor,
            pensize=self._pensize, speed=self._speed, resizemode="noresize", stretchfactor=self._stretch,
            outline=self._outline, tilt=self._tilt,
        )
        if pen is None and not pendict:
            return current
        merged = {**(pen or {}), **pendict}
        if "pendown" in merged:
            self._down = bool(merged["pendown"])
        if "pencolor" in merged:
            self.pencolor(merged["pencolor"])
        if "fillcolor" in merged:
            self.fillcolor(merged["fillcolor"])
        if "pensize" in merged:
            self.pensize(merged["pensize"])
        if "speed" in merged:
            self.speed(merged["speed"])
        if "shown" in merged:
            self.showturtle() if merged["shown"] else self.hideturtle()

    def pencolor(self, *args):
        if not args:
            return self._pencolor
        self._pencolor = _norm_color_args(args)
        self._emit(["color", self._tid, self._col(self._pencolor), self._col(self._fillcolor)])

    def fillcolor(self, *args):
        if not args:
            return self._fillcolor
        self._fillcolor = _norm_color_args(args)
        self._emit(["color", self._tid, self._col(self._pencolor), self._col(self._fillcolor)])

    def color(self, *args):
        if not args:
            return self._pencolor, self._fillcolor
        if len(args) == 1:
            self._pencolor = self._fillcolor = args[0]
        elif len(args) == 2:
            self._pencolor, self._fillcolor = args
        elif len(args) == 3:
            self._pencolor = self._fillcolor = tuple(args)
        else:
            raise TypeError("color() takes 0-3 arguments")
        self._emit(["color", self._tid, self._col(self._pencolor), self._col(self._fillcolor)])

    # -- filling ------------------------------------------------------------
    def filling(self):
        return self._fill_path is not None

    def begin_fill(self):
        if self._fill_path is None:
            self._fill_path = [[round(self._x, 3), round(self._y, 3)]]
            self._emit(["bf", self._tid])

    def end_fill(self):
        if self._fill_path is not None:
            if len(self._fill_path) > 2:
                self._emit(["ef", self._tid, self._col(self._fillcolor), self._fill_path])
            else:
                self._emit(["ef", self._tid, self._col(self._fillcolor), []])
            self._fill_path = None
            self._after(0)

    # -- more drawing / state -------------------------------------------------
    def clear(self):
        self._emit(["clear", self._tid])
        self._after(0)

    def reset(self):
        self._emit(["clear", self._tid])
        for sid in self._stamps[:]:
            self.clearstamp(sid)
        keep_shape = self._shape
        self._reset_state()
        self._shape = keep_shape
        self._emit_appearance()
        self._emit(["pos", self._tid, 0, 0, self._h])
        self._after(0)

    def write(self, arg, move=False, align="left", font=("Arial", 8, "normal")):
        self.screen._check_open()
        text = str(arg)
        family, size, style = (tuple(font) + ("Arial", 8, "normal")[len(font):])[:3]
        self._emit(["w", self._tid, self._x, self._y, text, align, family, size, style, self._col(self._pencolor)])
        if move and align == "left":
            self._x += len(text) * float(size) * 0.6
            self._emit(["pos", self._tid, self._x, self._y, self._h])
        self._after(0)

    # -- visibility / appearance ----------------------------------------------
    def showturtle(self):
        self._visible = True
        self._emit(["vis", self._tid, 1])
        self._after(0)

    st = showturtle

    def hideturtle(self):
        self._visible = False
        self._emit(["vis", self._tid, 0])
        self._after(0)

    ht = hideturtle

    def isvisible(self):
        return self._visible

    def shape(self, name=None):
        if name is None:
            return self._shape
        if name not in self.screen._shapes:
            raise Exception("There is no shape named %s" % name)
        self._shape = name
        self._emit(["shape", self._tid, name])
        self._after(0)

    def resizemode(self, rmode=None):
        return "noresize" if rmode is None else None

    def shapesize(self, stretch_wid=None, stretch_len=None, outline=None):
        if stretch_wid is None and stretch_len is None and outline is None:
            return (*self._stretch, self._outline)
        if stretch_wid is not None and stretch_len is None:
            stretch_len = stretch_wid
        sw = self._stretch[0] if stretch_wid is None else float(stretch_wid)
        sl = self._stretch[1] if stretch_len is None else float(stretch_len)
        self._stretch = (sw, sl)
        if outline is not None:
            self._outline = float(outline)
        self._emit(["size", self._tid, sw, sl, self._outline])
        self._after(0)

    turtlesize = shapesize

    def shearfactor(self, shear=None):
        return 0.0

    def settiltangle(self, angle):
        self._tilt = angle

    def tiltangle(self, angle=None):
        return self._tilt

    def tilt(self, angle):
        self._tilt += angle

    def shapetransform(self, *args):
        return (1.0, 0.0, 0.0, 1.0)

    def get_shapepoly(self):
        return None

    # -- events --------------------------------------------------------------
    def onclick(self, fun, btn=1, add=None):
        self._on_click = fun

    def onrelease(self, fun, btn=1, add=None):
        pass

    def ondrag(self, fun, btn=1, add=None):
        pass

    # -- poly / clone / accessors ---------------------------------------------
    def begin_poly(self):
        self._poly = [(self._x, self._y)]

    def end_poly(self):
        pass

    def get_poly(self):
        return tuple(self._poly) if self._poly is not None else None

    def clone(self):
        c = Turtle(self._shape)
        c._x, c._y, c._h = self._x, self._y, self._h
        c._down, c._pencolor, c._fillcolor = self._down, self._pencolor, self._fillcolor
        c._pensize, c._speed, c._stretch = self._pensize, self._speed, self._stretch
        c._fullcircle, c._visible = self._fullcircle, self._visible
        c._emit_appearance()
        c._emit(["pos", c._tid, c._x, c._y, c._h])
        return c

    def getturtle(self):
        return self

    getpen = getturtle

    def getscreen(self):
        return self.screen


RawTurtle = RawPen = Pen = Turtle
TNavigator = TPen = Turtle


# --------------------------------------------- module-level function forms
def _default_turtle() -> Turtle:
    if Turtle._pen_instance is None:
        Turtle._pen_instance = Turtle()
    return Turtle._pen_instance


def _make_turtle_fn(name: str):
    def fn(*args, **kw):
        return getattr(_default_turtle(), name)(*args, **kw)

    fn.__name__ = name
    fn.__doc__ = getattr(Turtle, name).__doc__
    return fn


def _make_screen_fn(name: str):
    def fn(*args, **kw):
        return getattr(_screen(), name)(*args, **kw)

    fn.__name__ = name
    fn.__doc__ = getattr(_Screen, name).__doc__
    return fn


_SCREEN_FUNCS = [
    "addshape", "bgcolor", "bgpic", "bye", "clearscreen", "colormode", "delay", "exitonclick",
    "getcanvas", "getshapes", "listen", "mainloop", "mode", "numinput", "onkey", "onkeypress",
    "onkeyrelease", "onscreenclick", "ontimer", "register_shape", "resetscreen", "screensize",
    "setup", "setworldcoordinates", "textinput", "title", "tracer", "turtles", "update",
    "window_height", "window_width", "done",
]
_TURTLE_FUNCS = [
    n for n in __all__
    if n not in _SCREEN_FUNCS and n[0].islower() and hasattr(Turtle, n)
]
for _n in _SCREEN_FUNCS:
    globals()[_n] = _make_screen_fn(_n)
for _n in _TURTLE_FUNCS:
    globals()[_n] = _make_turtle_fn(_n)
del _n


def getscreen():  # noqa: F811 - module-level form returns the Screen
    return _screen()


def _demo() -> None:  # pragma: no cover - manual smoke test
    t = Turtle()
    t.speed(0)
    for _ in range(36):
        t.forward(100)
        t.left(170)
    done()


if __name__ == "__main__":  # pragma: no cover
    _demo()
    sys.exit(0)
