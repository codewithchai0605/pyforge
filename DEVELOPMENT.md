# PyForge: development notes

Written so that a new chat (or a new contributor) can pick up exactly where the last
session stopped. Update the **Status** section whenever you finish something.

## Status

**Done and verified in the sandbox** (see "What was actually run" below):

- Python runtime: runner, streams, `input()`, REPL, Stop (process kill), tracebacks.
- `turtle` shim (canvas), matplotlib backend, `tkinter` blocked with a clear error.
- Package manager: PyPI + Chaquopy index, strict Android wheel tags, checksum, zip-slip guard,
  **cancellable installs** (cooperative; a cancel before the unpack phase changes nothing).
- UI in TSX (automatic JSX runtime from xtags): editor, tabs, key strip, file browser (rename /
  delete / new-from-template), find-in-files, console (ANSI, `\r`), display (turtle/plots),
  packages page, settings page, dialogs, toasts.
- **Navigation stack** (`src/navigation.ts`): Home → Packages → Settings, Back returns to the page
  you came from; Settings is reachable from Home *and* from Packages.
- **Back chain** (`src/components/backStack.ts`): dialog / sheet / drawer / page share one ordered
  stack (Back closes whichever layer opened last); on Home it runs the exit flow: confirmation, or
  Save / Discard / Stay when files are unsaved; a running program is stopped before exit.
- Auto-save (1.5 s after typing stops, plus on run / pause / exit), session restore.
- Zoom disabled (viewport meta + `touch-action` + WebView `setSupportZoom(false)`); pinch inside the
  editor changes the font size instead.
- Blank band under the status bar: caused by the page adding `env(safe-area-inset-*)` on top of the
  inset cordova-android 15 already applies to the WebView. Now measured natively
  (`PyRuntimePlugin.measureInsets`) and applied as `--inset-*` CSS variables (0 when the WebView is
  already inset).

**Confirmed on a real phone by the user** (screenshots): app runs, Python 3.13.16 on arm64_v8a,
editor/console/packages page render, a package install reaches PyPI. Everything marked
"not verified on device" in the README after that point is still unconfirmed, in particular:
the new inset measurement, `setSupportZoom(false)`, cancel on a real download, back-button chain.

**Not started (deliberately):** the real terminal (see "Terminal: research notes" below).
The user also said they have "one more thing to add"; it had not been described yet.

## Repository map

See README.md. Extras for developers:

```
utils/dev-bridge/bridge.ts       Node HTTP bridge that runs the real pyforge package under desktop Python
utils/dev-tools/                 the tools used to develop/verify in a sandbox (below)
tests/python, tests/ts           test suites
```

## Development setup used (all reproducible; nothing lives only in a sandbox)

Everything here was done in a Linux sandbox with no Android SDK. Reproduce with:

```bash
# JS side
npm install

# Python side: a *clean* venv (a clean venv matters: the package-manager tests assume
# nothing else is installed), plus matplotlib for the plot tests
python3 -m venv /tmp/venv && /tmp/venv/bin/pip install packaging pytest matplotlib
export PYFORGE_PYTHON=/tmp/venv/bin/python
export PATH=/tmp/venv/bin:$PATH            # so `npm run test:python` finds pytest

# Bun (only for `npm run test:app`, the original fs/editor tests, which use top-level await)
#   https://github.com/oven-sh/bun/releases  ->  bun-linux-x64.zip

npm run build          # typecheck + bundle (tsx runs the scripts; Bun not needed)
npm test               # 53 TS + 37 app + 56 Python tests
npm run smoke-test     # drives the BUILT UI in jsdom against real Python
utils/dev-tools/check-kotlin.sh     # Kotlin compile check (see below)
```

### Verifying Kotlin without an Android SDK

`utils/dev-tools/check-kotlin.sh` downloads the Kotlin 2.1.21 compiler (the version cordova-android 15
uses) and compiles the plugin's `.kt` files against Java **stubs** of the Android/Cordova/Chaquopy/
AndroidX APIs in `utils/dev-tools/kotlin-stubs/`. It proves syntax/types/nullability/overrides. It
cannot prove the stubs match the real APIs; the real Gradle build is the final word. When you call a
new Android API from Kotlin, add a stub for it. (Twice the stub was wrong, not the code: real
`PluginResult` has `getKeepCallback`; real `JSONObject` has a no-arg constructor.)

### Verifying the Cordova integration without an SDK

`cordova platform add android@15` works without an SDK (set `ANDROID_HOME` to any empty dir). Add the
plugins, then inspect `platforms/android`: Kotlin must be under `app/src/main/kotlin/...`, Python under
`app/src/main/python/pyforge/`, services in `AndroidManifest.xml`, an `apply from:` line for
`pyruntime.gradle` in `app/build.gradle`. That is how the original bug (Kotlin installed to a folder
Gradle never compiles) was found.

### Seeing the UI in a real browser engine (no Chromium available)

WebKitGTK renders the app faithfully enough to catch CSS/layout bugs that jsdom cannot:

```bash
sudo apt-get install -y xvfb python3-gi python3-gi-cairo gir1.2-webkit2-4.1 fonts-noto-core
npm run build
utils/dev-tools/snap.sh steps.json        # writes the PNGs named in steps.json; 412x860 by default
```

`steps.json` is a list of `{"js": "...", "eval": "...", "wait": ms, "shot": "out.png"}`. Caveats learned
the hard way: `eval` runs *before* `js` inside one step; the first step needs `"wait": 6000` for the
app to start; `pkill -f` in a command kills your own shell (match by PID instead); the server must be
started in the same command as the screenshot in a sandbox where background jobs don't survive.

## Decisions and gotchas worth remembering

- **Why a separate process per run** (`PythonRunnerService`, two alternating `:pythonN` services):
  Stop must be a hard kill; a native crash must not take the editor down; each run needs a fresh
  interpreter. The process is killed in `onDestroy`.
- **Why my own package manager**: Chaquopy has no runtime pip. Android accepts only pure wheels and
  `android_<api>_<abi>` wheels; never `manylinux` (glibc builds crash on bionic).
- **cordova-android 15 only maps `.java` from the legacy `src/<pkg>` target**; `.kt` needs
  `target-dir="app/src/main/kotlin/<pkg>"`, and `GradlePluginKotlinEnabled=true`.
- **Chaquopy 17.1**: Python 3.12+ is 64-bit only; `buildPython` must match the app's Python minor.
  Compiled packages are commented out in `python/requirements.txt` on purpose.
- **Threads inherit `daemon`** from the creating thread. The runner thread must be created with
  `daemon=False` or user threads become daemonic and a script exits without waiting for them.
- **`HTTPResponse.read(n)` blocks until n bytes**; use `read1` for responsive progress/cancel.
- **WebKit buffers an open streaming response** unless `X-Content-Type-Options: nosniff` (dev bridge only).
- **Race on Stop**: a Stop sent before the run id / Python start is known must still cancel the run
  (dev runtime queues it; Kotlin registers the run synchronously before the slow work).
- **Back order**: pages must be on the same Back stack as sheets/dialogs, or Back closes a sheet that
  is *under* the page (found by the smoke test).
- **Insets**: never combine a host-inset WebView with `env(safe-area-inset-*)`.
- tsx runs CommonJS by default: test files with top-level `await` need `.mts` (smoke test) or Bun.
- `window.pyforge` (editorManager, runPanel, workspace, runtime, router) exists for DevTools and the
  smoke test.

## Terminal: research notes (NOT implemented)

The user wants a real terminal: xterm.js + a native plugin + a Debian/Ubuntu environment.
Feasibility was researched and the facts below were verified; no code was written.

- **W^X**: apps targeting API 29+ cannot `exec` files from writable storage. Ship executables as
  `lib<name>.so` in `jniLibs/<abi>/`, set `extractNativeLibs="true"` /
  `packaging.jniLibs.useLegacyPackaging = true`, and exec them from `applicationInfo.nativeLibraryDir`.
- **proot for Android**: `github.com/green-green-avk/build-proot-android`, `packages/proot-android-
  {aarch64,x86_64}.tar.gz` (git clone works; the API is rate-limited). Contains `root/bin/proot` and
  `root/libexec/proot/loader` (bionic, talloc static; set `PROOT_LOADER`). PRoot is GPL-2.0: ship its
  source/offer. Upstream `proot-me/proot` releases are x86_64 only.
- **Rootfs** (pinned by the official proot-distro v4.38.0 catalog; mirrors not reachable from the
  sandbox, so URLs were not fetched, only the hashes recorded):
  - Debian trixie aarch64 `https://easycli.sh/proot-distro/debian-trixie-aarch64-pd-v4.37.0.tar.xz`
    sha256 `9bd3b19ff7cd300c7c7bf33124b726eb199f4bab9a3b1472f34749c6d12c9195`
  - Debian trixie x86_64 `.../debian-trixie-x86_64-pd-v4.37.0.tar.xz`
    sha256 `17eec851f40330cb3be77880aedd9e49c87d044f4ee5b02b3568c6aae0a5973b`
  - Ubuntu 25.10 aarch64 `.../ubuntu-questing-aarch64-pd-v4.37.0.tar.xz`
    sha256 `37e61ce5fd8593a7d10c4e72ebe611adb7e795f7492e4c0bf3a950441c984161`
  - Ubuntu 25.10 x86_64 sha256 `0fe0add7dff6adeaa58d5a6f44225cedf1924bd6c221c886077fa3b595319c2d`
  (proot-distro 5.x switched to OCI registry images; 4.x tarballs are the simpler route.)
- **Launch command** (from proot-distro 4.38 `proot-distro.sh`): `proot -L --kernel-release=6.17.0-PRoot-
  Distro --link2symlink --kill-on-exit --rootfs=<dir> --root-id --cwd=/root --bind=/dev --bind=/proc
  --bind=/sys` + fake `/proc/{loadavg,stat,uptime,version}` files (Android blocks the real ones) +
  `/usr/bin/env -i HOME=/root LANG=C.UTF-8 PATH=... TERM=xterm-256color TMPDIR=/tmp /bin/bash --login`.
  Extra: env `PROOT_NO_SECCOMP=1`, `PROOT_TMP_DIR`, bind the PyForge workspace to `/root/projects`.
- **Extraction** in Kotlin (commons-compress + `org.tukaani:xz`): turn hard links into copies, symlinks
  via `android.system.Os.symlink`, OR owner-write into modes, skip device nodes; verify sha256 first;
  make the download cancellable (same pattern as the package manager).
- **PTY**: no public Android API. Needs a tiny JNI C file using `forkpty` (bionic has it from API 23),
  `TIOCSWINSZ` for resize, `setsid`/exec in the child, and `waitpid` for the exit code; build with
  CMake via an `externalNativeBuild` block in a plugin Gradle file. It can be built and tested on Linux
  against the JDK's `jni.h` with a real bash. Wrap the fd with `ParcelFileDescriptor.adoptFd`.
- **Frontend**: `@xterm/xterm` + `@xterm/addon-fit`; transport output as base64 bytes (write
  `Uint8Array` to xterm), input as strings; sticky Ctrl, Esc/Tab/arrows key row; reuse the `Page`
  component and router (`RouteName` would gain `'terminal'`; keep sessions in a manager outside the view
  so leaving the page does not kill them). A desktop dev backend can use Python's `pty` module in the
  bridge, which also makes the whole chain testable here.
- Tier 1 (no downloads): `/system/bin/sh` on a PTY. Tier 2: proot + Debian/Ubuntu, opt-in download of
  roughly 50 MB (about 300 MB unpacked).

## What was actually run (so claims are checkable)

| Check | Result |
|---|---|
| `pytest tests/python` | 56 passed |
| `tsx --test tests/ts` | 53 passed (incl. TS ⇄ bridge ⇄ Python e2e and cancel e2e) |
| `bun test src/fileSystem/test src/editorManager/test` | 37 passed |
| `npm run smoke-test` | 12 steps passed (UI in jsdom + real Python) |
| `utils/dev-tools/check-kotlin.sh` | compiles against stubs |
| real Cordova CLI, platform android@15 + plugins | project generated correctly |
| WebKitGTK screenshots at 412x860 | editor, console, turtle, plot, drawer, menu, packages, settings, dialogs |

Never run: the Gradle build, the app on an emulator, anything in the "Not verified" list in README.md
other than what the user's own screenshots showed.
