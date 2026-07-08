#!/usr/bin/env bash
# chad-browser launch-and-drive recipe (driver-based).
# Launches an isolated, pre-authenticated browser with the driver daemon, drives
# the page via `chad-browser eval`, then tears down.
#
# Usage: launch-and-drive.sh [name] [url]
set -euo pipefail

NAME=${1:-demo}
URL=${2:-https://example.com}

# 1) Launch — logins carry over from ~/.config/chromium, driver daemon auto-starts.
chad-browser up --name "$NAME" "$URL" >/dev/null

# 2) Drive — the driver is already attached to the page.
echo ">> $NAME title:"
chad-browser eval --id "$NAME" 'return await evalInPage("document.title")'

echo ">> $NAME url:"
chad-browser eval --id "$NAME" 'return await evalInPage("location.href")'

# 3) Tear down — always (kills driver + browser, frees port + socket + profile).
chad-browser down "$NAME"
