# cordova-plugin-pyruntime

Embeds CPython (Chaquopy) in a Cordova Android app.

- `src/android/PyRuntimePlugin.kt`: the Cordova plugin (actions `init`, `run`, `stdin`, `gui`, `stop`, `pip`).
- `src/android/PythonRunnerService.kt`: runs each script in its own process (`:python0` / `:python1`).
- `src/android/pyruntime.gradle`: applies the Chaquopy Gradle plugin and sets the Python version/ABIs.
- `src/android/python/pyforge/`: the Python side. Plain Python with no Android imports, so it also runs
  under desktop CPython (that is how it's tested): `runner`, `core` (streams/session), `pkgmgr`, `tags`,
  `shims/turtle`, `shims/pyforge_mpl`, `host` (desktop stand-in for the Kotlin service).

`plugin.xml` lists every Python file explicitly; `tests/python/test_plugin_xml.py` fails if it drifts.

The project must set `<preference name="GradlePluginKotlinEnabled" value="true"/>` (cordova-android 15
compiles Kotlin only when that is on).
