# chad-browser — auth, CDP, and the gotchas

How the seeded login works, how to drive a clone over CDP, and the gotchas that have
each silently broken things. Read before deviating from defaults.

## How auth carries over

`chad-browser up` copies the base profile (`~/.config/chromium`) into a fresh
`--user-data-dir` so the clone opens already logged in to everything the base user is. The
copy is **not** a naive `cp`:

- `cp -a` of `Default/` and `Local State` (and `First Run` if present).
- The live auth SQLite DBs — `Cookies`, `Login Data`, `Login Data For Account` — are
  snapshotted with `sqlite3 … '.backup'`. This captures rows still sitting in the
  `-wal` file (a plain `cp` of a live `Cookies` DB would miss them). Their `-wal`/`-shm`
  siblings are then dropped so Chromium opens a clean file.
- Transient files are stripped: `SingletonLock`/`SingletonCookie`/`SingletonSocket`,
  `DevToolsActivePort`, `LOCK`, `Current/Last Session|Tabs`, `Sessions/`, all `*Cache*`,
  `Service Worker`, `Download Service`. Without this the clone claims "profile in use"
  or inherits the base's open tabs.

So: **log in to the base chromium once; every clone inherits it.** A login done inside
one clone does **not** reach the base or other clones — if you need a new login to
persist, do it in the base.

## Driving a clone over CDP

The clone opens Chrome DevTools Protocol on `127.0.0.1:<port>`. `up` prints the
websocket endpoint (`WS=`); `cdp <id>` prints it on demand. Two ways in:

```bash
# Raw HTTP (no driver) — list tabs, browser metadata:
curl http://127.0.0.1:<port>/json           # open targets, each with its own webSocketDebuggerUrl
curl http://127.0.0.1:<port>/json/version   # browser version + the browser-level WS endpoint

# Or connect a real driver to the WS endpoint (Playwright/Puppeteer/CDP).
# See templates/playwright-connect.py.
```

The browser-level `WS=` (`…/devtools/browser/…`) drives the whole browser; a per-tab
target WS (`…/devtools/page/<id>`) drives one page. For page automation, prefer the
per-tab WS from `/json`.

## Gotchas (each has bitten / silently failed)

1. **Never pass `--store` / `--password-store`.** Default = inherit the base. The base
   uses gnome-keyring (libsecret) under XFCE, so clones decrypt carried cookies with the
   same key. Passing `--password-store=basic` makes Chromium use a different key and
   **silently fails to decrypt the carried cookies** → you appear logged out. Only
   override `--store` if you re-seeded the base under that store.
2. **`up`-time snapshot.** Cookies/profile are frozen at launch. A `down` + `up` re-clones
   fresh from the (possibly updated) base. Don't expect mid-session logins to persist
   across a restart unless done in the base.
3. **Ports are shared and finite** (`9300–9499`). Use `chad-browser list` to see what's
   taken; `chad-browser gc` reaps dead processes' profiles + sockets. Don't pin a port an agent
   already holds.
4. **Always `down`.** It kills by `user-data-dir=<profile>` (so it gets the right
   instance), waits, force-kills, then removes the profile dir and runfile. Skipping it
   leaks a profile + holds the port.
5. **Anti-throttle is already on.** Background tabs driven by an agent don't stall
   (`--disable-background-timer-throttling` etc.). Don't reach for your own throttling
   flags; use the `--headless` *option* (not a hand-rolled `--headless` string) so it
   emits the correct `--headless=new`.

## Verifying auth survived

Open the clone to a page that reflects login state (e.g. a dashboard) and check the page
content via the driver:

```bash
chad-browser up --name verify https://app.example.com/home
chad-browser eval 'return await evalInPage("document.title")'   # a logged-in title, not "Login"
chad-browser down verify
```

A logged-in title/URL (not a redirect to `/login`) means the carry-over worked. For a
quick check without the driver, the raw CDP endpoint still works:

```bash
PORT=$(chad-browser list | awk '$2=="verify"{print $1}')
curl -s "http://127.0.0.1:$PORT/json" | python3 -c 'import sys,json;[print(t["title"],t["url"]) for t in json.load(sys.stdin)]'
```
