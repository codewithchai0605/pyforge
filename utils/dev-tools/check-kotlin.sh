#!/bin/bash
# Compile-check the plugin's Kotlin with the real Kotlin compiler against small
# Java stubs of the Android/Cordova/Chaquopy APIs (utils/dev-tools/kotlin-stubs).
# Catches syntax, type, nullability and override errors; it can NOT catch a stub
# that doesn't match the real API, so a real Gradle build is still the final word.
#   utils/dev-tools/check-kotlin.sh                              (downloads kotlinc 2.1.21 to /tmp/kt on first use)
#   utils/dev-tools/check-kotlin.sh PtyNative.kt TerminalPlugin.kt   (only these files, by name; the stubs
#                                                                      do not cover every API the other files use)
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KT=/tmp/kt
if [ ! -x "$KT/kotlinc/bin/kotlinc" ]; then
  mkdir -p "$KT" && curl -sL -o "$KT/kotlinc.zip" https://github.com/JetBrains/kotlin/releases/download/v2.1.21/kotlin-compiler-2.1.21.zip
  (cd "$KT" && unzip -q -o kotlinc.zip)
fi
OUT="$(mktemp -d)"
if [ "$#" -gt 0 ]; then
  SRC=""
  for f in "$@"; do SRC="$SRC $(ls "$ROOT"/src/native-plugins/*/src/android/"$f")"; done
else
  SRC=$(ls "$ROOT"/src/native-plugins/*/src/android/*.kt)
fi
"$KT/kotlinc/bin/kotlinc" $(find "$ROOT/utils/dev-tools/kotlin-stubs" -name '*.java') $SRC -d "$OUT" 2>&1 | grep -v '^$' || true
test -n "$(find "$OUT" -name '*.class' | head -1)" && echo "Kotlin OK ($(ls "$OUT"/com/pyforge/*/ 2>/dev/null | grep -c class) classes)" || { echo "Kotlin FAILED"; exit 1; }