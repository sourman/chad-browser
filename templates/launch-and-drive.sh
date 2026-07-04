#!/usr/bin/env bash
# chad-browser launch-and-drive recipe.
# Launches an isolated, pre-authenticated browser, probes it over CDP, then tears down.
# Self-contained: needs only chad-browser + curl + python3.
#
# Usage: launch-and-drive.sh [name] [url]
set -euo pipefail

NAME=${1:-demo}
URL=${2:-https://example.com}

# 1) Launch — logins carry over from ~/.config/chromium, so no re-auth.
OUT=$(chad-browser up --name "$NAME" "$URL")
PORT=$(printf '%s\n' "$OUT" | awk -F= '/^PORT=/{print $2}')
WS=$(printf '%s\n'   "$OUT" | awk -F= '/^WS=/{print $2}')
echo ">> $NAME up on port $PORT"
echo ">> HTTP: http://127.0.0.1:$PORT   (try: curl http://127.0.0.1:$PORT/json/version)"
echo ">> WS:   $WS   (hand to a CDP driver, e.g. templates/playwright-connect.py)"

# 2) Drive — here we just list open targets. Replace with real CDP driving as needed.
echo ">> targets:"
curl -s "http://127.0.0.1:$PORT/json" | python3 -c '
import sys, json
for t in json.load(sys.stdin):
    print("   -", repr(t["title"][:40]), "->", t["url"])
'

# 3) Tear down — always (frees the port + deletes the ephemeral profile).
chad-browser down "$NAME"
