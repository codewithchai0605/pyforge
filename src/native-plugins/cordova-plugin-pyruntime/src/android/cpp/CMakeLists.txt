cmake_minimum_required(VERSION 3.18.1)
project(pyforge_pty C)

# The pseudo-terminal helper behind the Terminal page (see PtyNative.kt).
add_library(pyforge_pty SHARED pty_core.c pty_jni.c)
target_compile_options(pyforge_pty PRIVATE -Wall -Wextra -O2 -fvisibility=hidden)
# JNIEXPORT keeps the JNI entry points visible; everything else is hidden.