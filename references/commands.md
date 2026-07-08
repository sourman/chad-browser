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
| `eval [--id <id>] '<js>'` | Run JS against the active page via the driver daemon. |
| `script [--id <id>] <file.js>` | Run a JS file against the active page. |
| `repl [--id <id>]` | Interactive JS prompt (line-buffered). |
| `gc` | Reap profiles/sockets whose process is gone + remove orphans. |
| `info` | Print resolved BASE / BIN / RUNDIR / SOCKDIR / DRIVER / NODE / port range. |
| `--help` / `-h` / (no args) | Print the usage block. |

IDs (`<port|name|pid>`) resolve in that order: an exact port runfile, then a matching
`NAME=`, then a matching `PID=`. For `eval`/`script`/`repl`, omitting `--id` resolves
"my instance" by walking the process tree to find the instance whose launching shell
is an ancestor of the current shell.

## `up` options

| Flag | Effect |
|---|---|
| `--name NAME` | Label for the instance (default `chad-<port>`). |
| `--port N` | Force a specific port (else first free in `CB_PORT_MIN..CB_PORT_MAX`). |
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
to `~/.cache/chad-browser/run/<port>.env` and prints `PORT= NAME= PID= HTTP= WS= PROFILE= SOCKET=`.

Wall-clock for `up` is typically ~1-7s (profile clone + Chromium start + CDP wait + driver
attach). Headless launches are near the low end (~1s); the first launch of a session may be
slower because the base profile copy is cold. It is not hung — `up` prints readiness once the
driver socket is listening.

All commands exit 0 on success, non-zero on error. `list` exits 0 whether or not any
instances are running; `down <id>` exits non-zero with a message if no instance matches
the id (safe to re-run for cleanup retries — just check `$?` if you need to know).

## `eval` / `script` / `repl`

These send JS over the driver's Unix socket. The JS runs in a Node context with
`session` (full CDP surface), `evalInPage`, `waitForReady`, `waitForDomStable`,
`listPageTargets`, and `use` in scope. See `driving.md` for the full surface.

```bash
chad-browser eval 'return await evalInPage("document.title")'
chad-browser eval --id myagent 'return 1 + 1'
chad-browser script /tmp/flow.js
chad-browser repl
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

- Base profile: `~/.config/chromium` (Ahmed's real logins — the source of truth).
- Driver: `~/.local/lib/chad-browser/driver.mjs` (the CDP daemon spawned by `up`).
- Runfiles (tracked instances): `~/.cache/chad-browser/run/<port>.env`.
- Ephemeral profiles: `/tmp/chad-browser/<name>-<port>` (deleted on `down`).
- Driver sockets: `$XDG_RUNTIME_DIR/chad-browser/<name>.sock` (deleted on `down`).
- Driver logs: `~/.cache/chad-browser/<name>-driver.log` (for debugging launch failures).

The base browser (Ahmed's, typically CDP `9222`) and `google-chrome` are unrelated and
never touched.
