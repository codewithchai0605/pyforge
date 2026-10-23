"""Usage: shot.py URL WIDTH HEIGHT STEPS.json   (run under xvfb-run)
STEPS: [{"js": "...", "wait": ms, "shot": "out.png"}, ...]; first step runs after page load."""
import json, sys
import gi
gi.require_version("Gtk", "3.0"); gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2, GLib

url, w, h, steps_file = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
steps = json.load(open(steps_file))
win = Gtk.OffscreenWindow(); win.set_default_size(w, h)
ctx = WebKit2.WebContext.new_ephemeral()
view = WebKit2.WebView.new_with_context(ctx)
view.set_size_request(w, h)
s = view.get_settings(); s.set_enable_developer_extras(True); s.set_enable_write_console_messages_to_stdout(True)
win.add(view); win.show_all()

def run_step(i):
    if i >= len(steps):
        Gtk.main_quit(); return False
    st = steps[i]
    if st.get("eval"):
        def ev_done(v, res):
            try:
                print("EVAL ->", v.run_javascript_finish(res).get_js_value().to_string(), flush=True)
            except Exception as e:
                print("EVAL error", e, flush=True)
        view.run_javascript(st["eval"], None, ev_done)
    if st.get("js"):
        view.run_javascript(st["js"], None, None, None)
    def after():
        if st.get("shot"):
            def done(v, res):
                surf = v.get_snapshot_finish(res)
                surf.write_to_png(st["shot"]); print("saved", st["shot"], flush=True)
                GLib.timeout_add(50, lambda: (run_step(i + 1), False)[1])
            view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, done)
        else:
            run_step(i + 1)
        return False
    GLib.timeout_add(st.get("wait", 300), after)

def on_load(v, ev):
    if ev == WebKit2.LoadEvent.FINISHED:
        GLib.timeout_add(1500, lambda: (run_step(0), False)[1])
view.connect("load-changed", on_load)
view.connect("console-message" if False else "load-failed", lambda *a: print("LOAD FAILED", a[2]) or False)
view.load_uri(url)
GLib.timeout_add(90000, lambda: (print("timeout"), Gtk.main_quit()))
Gtk.main()
