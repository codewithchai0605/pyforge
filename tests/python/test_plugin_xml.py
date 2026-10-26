"""plugin.xml must list every Python file, or it silently won't be in the APK."""

import re

from conftest import ROOT, PY_SRC

PLUGIN = ROOT / "src/native-plugins/cordova-plugin-pyruntime"


def test_every_python_file_is_declared_with_matching_target_dir():
    xml = (PLUGIN / "plugin.xml").read_text()
    declared = dict(
        re.findall(
            r'<source-file src="(src/android/python/[^"]+\.py)" target-dir="([^"]+)"',
            xml,
        )
    )
    actual = {str(p.relative_to(PLUGIN)): p for p in PY_SRC.rglob("*.py")}
    assert set(declared) == set(actual), set(declared) ^ set(actual)
    for src, target in declared.items():
        rel_dir = str(actual[src].parent.relative_to(PY_SRC))
        assert target == f"app/src/main/python/{rel_dir}", (src, target)


def test_kotlin_sources_use_explicit_gradle_source_dirs():
    xml = (PLUGIN / "plugin.xml").read_text()
    for kt in re.findall(r'<source-file src="[^"]+\.kt" target-dir="([^"]+)"', xml):
        assert kt.startswith("app/src/main/kotlin/"), kt
    for f in (PLUGIN / "src/android").glob("*.kt"):
        assert f.name in xml, f"{f.name} missing from plugin.xml"


def test_native_sources_are_declared_and_cmake_points_at_them():
    xml = (PLUGIN / "plugin.xml").read_text()
    gradle = (PLUGIN / "src/android/pyruntime.gradle").read_text()
    cpp = {p.name for p in (PLUGIN / "src/android/cpp").iterdir()}
    declared = re.findall(
        r'<source-file src="src/android/cpp/([^"]+)" target-dir="([^"]+)"', xml
    )
    assert {name for name, _ in declared} == cpp, {name for name, _ in declared} ^ cpp
    # The CMake file is found by the path the Gradle file gives, so that is where the files must land.
    assert all(target == "app/src/main/cpp" for _, target in declared)
    assert 'path "src/main/cpp/CMakeLists.txt"' in gradle


def test_terminal_plugin_is_registered_and_its_library_name_matches_the_jni_loader():
    xml = (PLUGIN / "plugin.xml").read_text()
    assert 'name="PyTerminal"' in xml
    assert "com.pyforge.pyruntime.TerminalPlugin" in xml
    cmake = (PLUGIN / "src/android/cpp/CMakeLists.txt").read_text()
    kotlin = (PLUGIN / "src/android/PtyNative.kt").read_text()
    lib = re.search(r"add_library\((\w+) SHARED", cmake).group(1)
    assert f'System.loadLibrary("{lib}")' in kotlin
    # Every native method the Kotlin object declares must exist as a JNI export in the C file.
    jni = (PLUGIN / "src/android/cpp/pty_jni.c").read_text()
    for name in re.findall(r"external fun (\w+)\(", kotlin):
        assert f"Java_com_pyforge_pyruntime_PtyNative_{name}(" in jni, name
