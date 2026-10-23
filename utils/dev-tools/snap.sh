#!/bin/bash
# Screenshot the real built UI in a real browser engine (WebKitGTK) at phone size.
#   utils/dev-tools/snap.sh steps.json [width height]
# Run from the repo root after `npm run build`. Starts the server, runs the steps, stops it.
# Needs: xvfb python3-gi python3-gi-cairo gir1.2-webkit2-4.1 (apt) and PYFORGE_PYTHON set.
# shot.py runs under the SYSTEM python (it has the "gi" bindings); override with SNAP_PYTHON.
# steps.json: [{"js": "...", "eval": "...", "wait": ms, "shot": "out.png"}, ...]
#   NB: within one step, "eval" runs BEFORE "js"; the screenshot is taken after "wait".
#   The first step should wait ~6000ms for the app to start.
HERE="$(cd "$(dirname "$0")" && pwd)"
npx tsx "$HERE/serve.mts" 4177 > /tmp/pyforge-serve.log 2>&1 &
SRV=$!
for i in $(seq 1 40); do curl -s -m 1 -o /dev/null localhost:4177/__py/ping && break; sleep 0.3; done
timeout 150 xvfb-run -a -s "-screen 0 1280x1024x24" "${SNAP_PYTHON:-/usr/bin/python3}" "$HERE/shot.py" http://127.0.0.1:4177/ "${2:-412}" "${3:-860}" "$1" 2>&1 | grep -E "EVAL|saved|timeout|FAILED"
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; true
