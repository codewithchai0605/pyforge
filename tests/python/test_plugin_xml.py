"""plugin.xml must list every Python file, or it silently won't be in the APK."""
import re

from conftest import ROOT, PY_SRC

PLUGIN = ROOT / "src/native-plugins/cordova-plugin-pyruntime"


def test_every_python_file_is_declared_with_matching_target_dir():
    xml = (PLUGIN / "plugin.xml").read_text()
    declared = dict(re.findall(r'<source-file src="(src/android/python/[^"]+\.py)" target-dir="([^"]+)"', xml))
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
