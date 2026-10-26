"""The JNI layer of the PTY plugin, loaded into a real JVM.

Compiles pty_core.c + pty_jni.c against the JDK's jni.h and runs
tests/native/PtyJniCheck.java, which calls the same static native methods that
PtyNative.kt declares. That checks the JNI names, signatures and the
string/array marshalling without an Android device. Skipped where there is no
C compiler or no JDK (the JRE alone has no jni.h).
"""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import ROOT

CPP = ROOT / "src/native-plugins/cordova-plugin-pyruntime/src/android/cpp"
HARNESS = ROOT / "tests/native/PtyJniCheck.java"


def _jni_include() -> Path | None:
    candidates = []
    if os.environ.get("JNI_INCLUDE"):
        candidates.append(Path(os.environ["JNI_INCLUDE"]))
    if os.environ.get("JAVA_HOME"):
        candidates.append(Path(os.environ["JAVA_HOME"]) / "include")
    java = shutil.which("java")
    if java:
        candidates.append(Path(os.path.realpath(java)).parent.parent / "include")
    for c in candidates:
        if (c / "jni.h").exists():
            return c
    return None


INCLUDE = _jni_include()

pytestmark = pytest.mark.skipif(
    shutil.which("gcc") is None or shutil.which("java") is None or INCLUDE is None,
    reason="needs gcc, java and the JDK's jni.h (set JNI_INCLUDE or JAVA_HOME)",
)


def test_jni_library_works_in_a_real_jvm(tmp_path):
    lib = tmp_path / "libpyforge_pty.so"
    subprocess.run(
        [
            "gcc",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-O2",
            "-fvisibility=hidden",
            "-fPIC",
            "-shared",
            f"-I{INCLUDE}",
            f"-I{INCLUDE / 'linux'}",
            str(CPP / "pty_core.c"),
            str(CPP / "pty_jni.c"),
            "-o",
            str(lib),
            "-lutil",
            "-lpthread",
        ],
        check=True,
    )
    result = subprocess.run(
        ["java", str(HARNESS), str(lib)], capture_output=True, text=True, timeout=120
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ALL OK" in result.stdout
