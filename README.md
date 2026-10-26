# PyForge

A Python IDE for Android, built with Cordova. Write Python in a CodeMirror 6 editor,
run it on a real embedded CPython, see output / `input()` / **turtle graphics** /
**matplotlib plots**, and install packages with one tap.

- **Editor:** CodeMirror 6 with Python highlighting, auto-save, pinch-to-resize font, 4-space indentation, completion
  (keywords, builtins, module names, snippets), and a Python-symbol key strip above the
  keyboard (`: ( ) [ ] { } _ #`, Tab, arrow keys, undo/redo, comment toggle).
- **Python:** CPython 3.13 via [Chaquopy](https://chaquo.com/chaquopy/) 17.1, run in an
  **isolated process**: Stop is a hard kill (infinite loops, blocking C calls), a native
  crash can't take the editor down, and every run starts with a fresh interpreter.
- **Graphics:** a `turtle` module with the standard API that draws on an HTML canvas
  (Android has no Tk, so the real one can't work), and a matplotlib backend that turns
  `plt.show()` into an image.
- **Packages:** a Packages page that installs/uninstalls from PyPI (pure-Python wheels, and
  Android wheels where they exist) with live progress and a **Cancel** button that stops a
  download on the fly without leaving anything half-installed.
- **Navigation:** a real page stack (Home → Packages → Settings; Back returns to where you
  came from) and an exit flow on Back from Home: a confirmation, or Save / Discard / Stay
  when files are unsaved.
- **Files:** an app-private workspace (real paths, so imports and file I/O work),
  rename/delete/new-from-template, find-in-files, and optionally an external folder via
  Android's Storage Access Framework.

## Build the Android app

You need (versions as tested against cordova-android 15):

| Tool                                 | Notes                                                                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 20+                             | `npm install`                                                                                                                                         |
| JDK 17+                              | Gradle 8.14 / AGP 8.10                                                                                                                                |
| Android SDK                          | platform 36, build-tools; set `ANDROID_HOME`                                                                                                          |
| **Python 3.13 on the build machine** | Chaquopy runs pip with it; must match the app's Python. Not on `PATH`? set `PYFORGE_BUILD_PYTHON=/path/to/python3.13` (or `-PpyforgeBuildPython=...`) |

```bash
npm install
npm run cordova:build      # = build the web app, then `cordova build android`
npm run cordova:run        # same, then install on a connected device / emulator
```

`config.xml` already lists the platform and plugins, so `cordova build android` adds
what's missing. A first build downloads Gradle, Chaquopy and Python (a few hundred MB).

Python 3.12+ is **64-bit only** (arm64-v8a, x86_64). 32-bit-only phones aren't supported
with the default setup; see "Python version" in
`src/native-plugins/cordova-plugin-pyruntime/src/android/pyruntime.gradle` for 3.11.

### Bundling numpy / matplotlib / pillow

Packages with compiled code are only _officially_ supported by Chaquopy when baked into
the APK at build time. Edit `python/requirements.txt` and uncomment what you want. They're
commented out by default **on purpose**: if any line has no wheel for the app's Python
version, the whole Gradle build fails. Enable them one at a time. (The Packages page can
also _try_ to install compiled wheels at runtime; see "Honest status".)

**Don't add every scientific package here.** PyForge uses Python 3.13 because it has
Android NumPy wheels, so NumPy can normally be downloaded by the Packages page only for
the people who choose it. That keeps it out of the base app. The same is true of any
pure-Python package or package which publishes a compatible Android wheel. A package with
no compatible Android wheel cannot be installed safely on a phone at all: ship it only in
a separate, purpose-built app flavor (for example, a "scientific" edition), or obtain/build
Android wheels for it. Adding it to `requirements.txt` is not a universal workaround; it
will fail the build if Chaquopy can't resolve a compatible wheel.

## Develop in a desktop browser

```bash
npm run dev               # builds, serves http://localhost:8000, watches
```

The preview runs your **desktop Python** behind a small bridge (`/__py/*`, see
`utils/dev-bridge/bridge.ts`), using the _same_ `pyforge` package that ships in the APK, so
run/stop/`input()`/turtle/plots/packages all work, with an in-memory file system. Python 3
with `packaging` is required (`PYFORGE_PYTHON=/path/to/python` to choose). Esc = Back,
Ctrl/Cmd+Enter = Run/Stop, Ctrl/Cmd+S = Save.

## Tests

```bash
npm test                  # everything below
npm run test:python       # pytest: runner, turtle, matplotlib backend, package manager (fake PyPI), the C PTY core, the JNI layer in a JVM (needs a JDK)
npm run test:ts           # ANSI parser, turtle scene, console view, terminal (xterm, line editor, touch selection, sessions), navigation, app logic, TS<->Python e2e (incl. cancel, and a real bash on a PTY)
npm run test:app          # the original filesystem/editor tests (needs Bun)
npm run build && npm run smoke-test   # drives the built UI against real Python in jsdom
```

Python tests need `pytest` and `packaging` (and `matplotlib` for the plot tests, which skip
otherwise). `PYFORGE_PYTHON` selects the interpreter for the TS tests.

## How it fits together

```
 WebView (src/)                         Android (Kotlin)                  Python (Chaquopy)
 ──────────────                         ────────────────                  ─────────────────
 editor, tabs, files, console,   exec   PyRuntimePlugin ──bind──► PythonRunnerService  (:python0/:python1,
 turtle canvas, packages page  ───────►  (UI process)    Messenger   one process per run, killed on exit)
        │                                    │                              │ pyforge.runner → your script
        │  protocol.ts (JSON events)         └─ package manager runs        │ pyforge.shims.turtle / pyforge_mpl
        ▼                                       in-process (pyforge.pkgmgr) ▼
 pyruntime.ts  → cordovaRuntime | devRuntime (desktop bridge) | noneRuntime
```

- **Event protocol** (`pyforge/core.py`, mirrored in `src/python/protocol.ts`): one JSON
  line per event: `out`, `err`, `input`, `gui` (turtle commands), `img`, `exit`.
- **Why a separate process:** see `PythonRunnerService.kt`. Two service classes alternate so
  tapping Run right after Stop never races a dying process.
- **Turtle:** Python owns all state and geometry (so `pos()`, `heading()`, `distance()`
  answer instantly); it emits compact draw commands and sleeps for the animation time. The
  UI (`turtleScene.ts`) animates them on per-turtle layers.
- **Package manager** (`pkgmgr.py`): PEP 691 JSON index → newest loadable wheel → sha256-verified
  download → dependencies from the wheel's METADATA → unzip into
  `files/pyforge/site-packages`. On Android it accepts **only** pure wheels and
  `android_<api>_<abi>` wheels for this device; it will never install a `manylinux` wheel
  (glibc builds crash on Android).

## Terminal

**Menu -> Terminal** opens a real shell (tabs, search, Copy/Paste, sticky Ctrl/Alt key bar) and program output
is shown in the same xterm.js terminal (**Settings -> Terminal-style console**; turn it off for the classic
console). On the phone the shell is Android's own `sh` (no Python in it); on your computer (`npm run dev`) it is
your own shell. Long-press selects text, drag the handles, then Copy / Paste / Select all. Details and limits:
DEVELOPMENT.md, "Terminal". **The Android part (NDK build, PTY under Android, touch gestures, soft keyboard) has
not been run on a device.**

## Honest status: what is and isn't verified

Everything below was built and tested in a Linux sandbox **without an Android SDK, device
or emulator**.

| Verified (automated, real execution)                                                                                                   | Not verified on a device                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| All Python code: 56 pytest tests against a real host process, incl. a fake PyPI and cancellation                                       | The Gradle script (`pyruntime.gradle`) against real Chaquopy 17.1 / AGP    |
| Kotlin: compiles with the real Kotlin 2.1.21 compiler _against stubs I wrote_ of the Android/Cordova/Chaquopy APIs                     | The Kotlin against the real SDK jars; Chaquopy ⇄ Kotlin calls at runtime   |
| Cordova integration: the real Cordova 13 CLI generates the Android project correctly (sources, manifest, services, Gradle hook, icons) | Binder messaging, process kill/restart, Python start-up time on a phone    |
| TS ⇄ Python end to end (run, `input()`, stop, turtle, matplotlib, pip) via the dev bridge                                              | The Cordova bridge path (`cordovaRuntime`) on a device                     |
| UI rendered in a real browser engine (WebKitGTK) at phone size and driven through the main flows                                       | Android WebView specifics: keyboard insets, touch/long-press, edge-to-edge |

Known limits and risks:

- **Runtime install of compiled wheels is best-effort.** Chaquopy has no runtime pip; this is
  my own installer. Pure-Python packages are the reliable path. Native wheels need an Android
  build to exist, and their shared-library dependencies (`chaquopy/lib/*.so`) are pre-loaded
  via `ctypes`, which I could not test on a device. Bundle important compiled packages in
  `python/requirements.txt` instead.
- **Seen working on a real phone** (user's screenshots): app start, Python 3.13 on arm64, run/console,
  the Packages page and a PyPI install starting. **Not yet confirmed on a device:** the inset
  measurement that removes the blank band under the status bar, native zoom disabling, Cancel on a
  real download, and the Android Back chain.
- **No terminal yet.** A real terminal (xterm.js + native PTY + Debian/Ubuntu via proot) is designed
  and researched but intentionally not built; see DEVELOPMENT.md.
- **No `tkinter`.** `import tkinter` raises a clear ImportError. Use `turtle` or matplotlib.
  pygame/Kivy-style apps aren't supported.
- **turtle differences:** `undo()` restores position/heading but doesn't erase drawings;
  `getcanvas()`, `bgpic()` and image shapes aren't supported. Key-driven turtle programs get
  an on-screen key pad automatically.
- **Backgrounding:** Android may freeze or kill a long-running script if you leave the app
  (there's no foreground service yet). Files are auto-saved when the app is paused.
- **External (SAF) folders** can be browsed and edited, but a script in one runs from a copy of
  the editor buffer: sibling imports from that folder won't resolve. Use the workspace for
  multi-file projects.
- Dark theme only. Console output is capped at 4000 lines.

## What changed from the original project

Removed (not needed for a Python editor): the Rust `rusttools` plugin (diff/search), the C++
`filetools` plugin (hashing/gzip), the demo editor plugins (word count, file hash, diff view),
and the `motion` dependency. Search was rewritten in plain TypeScript. Kept: the SAF plugin
(renamed to `com.pyforge.saf`), the filesystem layer and its tests, `EditorManager`, xtags (now
your newer version, see below).

One thing worth knowing if you add Kotlin plugins later: **cordova-android 15 only maps
`.java` files from the legacy `src/<pkg>` target.** The original `RustToolsPlugin.kt` was
installed to `app/src/main/src/...`, which Gradle never compiles. Use
`target-dir="app/src/main/kotlin/<package path>"` (see this project's `plugin.xml`).

`src/packages/xtags` now contains the newer files you sent (`dom`, `list`, `reactive`,
`render`, `jsx-runtime`, `jsx-dev-runtime`, `index`). Only the typing shim in `index.ts` and
a local `HTMLElementAttributes` alias in `jsx-runtime.ts` were adapted, because this project
doesn't depend on `acode-plugin-types`.

The UI is written in **TSX** using xtags' automatic JSX runtime (`jsx: react-jsx`,
`jsxImportSource: xtags`); `consoleView.ts` and `displayView.ts` stay as imperative DOM classes on
purpose (they handle tens of thousands of lines/frames).

Scripts now use `tsx` instead of Bun, so a plain `npm` workflow works (Bun still works; it is
only needed for `npm run test:app`).

## Project layout

```
config.xml, package.json         Cordova + npm setup (id com.pyforge.app)
python/requirements.txt          packages baked into the APK
src/                             the web app (TypeScript)
  components/                    UI: shell, console, display (turtle/plots), packages, dialogs…
  python/                        protocol, ANSI parser, turtle scene, templates
  native/                        cordova wrappers: pyruntime (3 backends), saf
  fileSystem/, editor/, editorManager/   (from the original project, extended)
  native-plugins/cordova-plugin-pyruntime/   Kotlin + Chaquopy + the `pyforge` Python package
  native-plugins/cordova-plugin-saf/         Storage Access Framework (Java)
tests/{python,ts}/               test suites
utils/                           build scripts, dev server, desktop Python bridge,
                                 dev-tools/ (screenshot rig, Kotlin stub checker)
DEVELOPMENT.md                   progress, dev setup, decisions, terminal research (read this first)
```