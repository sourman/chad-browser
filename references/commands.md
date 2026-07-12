# chad-browser — command reference

Full reference for every `chad-browser` command, flag, and env var. Verified against
`~/.local/bin/chad-browser`.

## Commands

| Command | What it does |
|---|---|
| `up [opts] [URLs...] [-- chromium-flag...]` | Launch an isolated, pre-authenticated browser + driver daemon. |
| `down <port\|name\|pid>` (`stop`) | Kill browser + driver, remove ephemeral profile + socket. |
| `list` (`ls`) | Show running agent browsers + driver state. |
| `cdp <port\|name\|pid>` (`ws`) | Print the browser websocket endpoint (raw CDP fallback). |
| `eval [--id\|--name <id>] [--page] [--stdin\|--file <f>\|'<js>']` | Run JS against the page. |
| `script [--id\|--name <id>] <file.js>` | Run a JS file (alias for `eval --file`). |
| `repl [--id\|--name <id>]` | Interactive JS prompt (line-buffered). |
| `gc` | Reap profiles/sockets whose process is gone + remove orphans. |
| `probe <url>` | Probe a URL (supports `{8080..8090}` ranges / `{8080,8081}` lists) for a live HTTP server. Prints `<code> <url>` on the first responder. Use to find which localhost port the dev server is on. |
| `info` | Print resolved BASE / BIN / RUNDIR / SOCKDIR / DRIVER / NODE / port range. |
| `--help` / `-h` / (no args) | Print the usage block. |

IDs (`<port|name|pid>`) resolve in that order: an exact port runfile, then a matching
`NAME=`, then a matching `PID=`. `--id` and `--name` are aliases on every driving
subcommand — use whichever you like. For `eval`/`script`/`repl`, omitting both resolves
"my instance" by walking the process tree to find the instance whose launching shell
is an ancestor of the current shell.

## `up` options

| Flag | Effect |
|---|---|
| `--name NAME` | Label for the instance (default `chad-<port>`). |
| `--port N` | Force a specific port (else first free in `CB_PORT_MIN..CB_PORT_MAX`). |
| `--app NAME` | Override the memory key for this instance. By default the key is derived from the first URL's hostname (or `localhost` for localhost/127.0.0.1). The memory file path is shown in `up` output (`MEMORY=...`). Facts from the file are surfaced once per session on `navigate()`. Read/write the file with native file tools. |
| `--headless` | No window. Also via `CB_HEADLESS=1`. |
| `--headed` | Force a window (overrides `CB_HEADLESS=1`). |
| `--store STORE` | `--password-store` value. **Default = inherit base — do not pass this** (see `auth-and-cdp.md`). |
| `--json` | Emit JSON instead of `KEY=VAL` lines. |
| `--` | Everything after is passed through as raw Chromium flags. |

URLs are **positional** — there is no `--url`. Example: `chad-browser up https://a.com https://b.com`.

Baked-in Chromium flags (anti-throttle so agent-driven background tabs don't stall):
`--no-first-run --no-default-browser-check --no-pings --disable-background-timer-throttling
--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-features=Translate`.

`up` waits for CDP (`/json/version`) to come up, then spawns the driver daemon
(`~/.local/lib/chad-browser/driver.mjs`) which connects to Chromium's WS endpoint,
auto-enables `Page`/`Runtime`/`DOM`/`Network`, attaches to the first page target,
and listens on a Unix socket at `$SOCKDIR/<name>.sock`. On success it writes a runfile
to `~/.cache/chad-browser/run/<port>.env` and prints `PORT= NAME= PID= HTTP= WS= PROFILE= SOCKET= MEMORY=`.

Wall-clock for `up` is typically ~1-7s (profile clone + Chromium start + CDP wait + driver
attach). Headless launches are near the low end (~1s); the first launch of a session may be
slower because the base profile copy is cold. It is not hung — `up` prints readiness once the
driver socket is listening.

All commands exit 0 on success, non-zero on error. `list` exits 0 whether or not any
instances are running; `down <id>` exits non-zero with a message if no instance matches
the id (safe to re-run for cleanup retries — just check `$?` if you need to know).

## `eval` / `script` / `repl`

These send JS over the driver's Unix socket. `eval` is the primary interface; `script`
is a backward-compat alias for `eval --file`; `repl` is an interactive loop.

### `eval` flags

| Flag | Effect |
|---|---|
| `--id\|--name <id>` | Target instance (alias; either works). Omit to auto-resolve "my instance." |
| `--page` | Run JS in the page's context. `document.*` works directly. Multi-statement bodies auto-IIFE. |
| `--wait '<check>'` | Poll a page JS expression until truthy, THEN run the body. Composes with `--page`. Default 15s timeout. |
| `--stdin` | Read JS from stdin (pipe a heredoc — the recommended default for multi-line). |
| `--file <path>` | Read JS from a file or FIFO. |
| `--timeout <ms>` | Eval body timeout (default 120000, capped 600000). Also sets socket timeout. |

If no `--stdin`/`--file` is given, the positional `<js>` arg is the body.

```bash
# The common case: hydrate then read, in one call
cat <<'JS' | chad-browser eval --name myagent --page --wait 'document.querySelector("table tbody tr")' --stdin
const rows = [...document.querySelectorAll('table tbody tr')];
return rows.map(r => r.textContent.trim());
JS

# Page-context read (one-liner)
chad-browser eval --name myagent --page 'document.title'

# Node context (CDP helpers in scope)
chad-browser eval --name myagent 'return await evalInPage("document.title")'

# Node context with an arrow function (avoids quoting hell for nested strings/regex)
cat <<'JS' | chad-browser eval --name myagent --stdin
return await evalInPage(() => document.title);
JS

# Read-after-submit: arm nav listener, submit, read destination
cat <<'JS' | chad-browser eval --name myagent --stdin
const dest = await waitForNavigation({ hint: 'login result' }, async () => {
  await typeInto('#username', 'me');
  await typeInto('#password', 'pw');
  await evalInPage('document.querySelector("form").submit()');
});
const body = await evalInPage(() => document.body.innerText.substring(0, 500));
return { dest, body };
JS

# From a file
chad-browser script --name myagent /tmp/flow.js
```

The reply is a single JSON line: `{"value": <result>}` on success, `{"error": "...",
"stack": "..."}` on failure.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `CHAD_BROWSER_BASE` | `~/.config/chromium` | Base profile to clone from (must contain `Default/`). |
| `CHAD_BROWSER_BIN` | `chromium` | Browser binary. **Use `chromium`, not `google-chrome`.** |
| `CB_PORT_MIN` / `CB_PORT_MAX` | `9300` / `9499` | Port range for auto-pick. |
| `CB_HEADLESS` | unset (headed) | Set `1` to default to headless. |
| `XDG_RUNTIME_DIR` | `/run/user/<uid>` | Where the driver sockets live (`$XDG_RUNTIME_DIR/chad-browser/`). |

## Where things live

- Base profile: `~/.config/chromium` (the user's real logins — the source of truth).
- Driver: `~/.local/lib/chad-browser/driver.mjs` (the CDP daemon spawned by `up`).
- Runfiles (tracked instances): `~/.cache/chad-browser/run/<port>.env`.
- Ephemeral profiles: `/tmp/chad-browser/<name>-<port>` (deleted on `down`).
- Driver sockets: `$XDG_RUNTIME_DIR/chad-browser/<name>.sock` (deleted on `down`).
- Driver logs: `~/.cache/chad-browser/<name>-driver.log` (for debugging launch failures).
- Memory files: `~/.cache/chad-browser/memory/<key>.json` where `<key>` is the hostname, `localhost`, or the `--app` value.

The base browser (the user's daily browser, typically CDP `9222`) and `google-chrome` are
unrelated and never touched.
