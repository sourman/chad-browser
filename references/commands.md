# chad-browser — command reference

Full reference for every `chad-browser` command, flag, and env var. Verified against
`~/.local/bin/chad-browser`.

## Commands

| Command | What it does |
|---|---|
| `up [opts] [URLs...] [-- chromium-flag...]` | Launch an isolated, pre-authenticated browser. |
| `down <port\|name\|pid>` (`stop`) | Kill it + remove its ephemeral profile. |
| `list` (`ls`) | Show running agent browsers. |
| `cdp <port\|name\|pid>` (`ws`) | Print the browser's websocket endpoint. |
| `gc` | Reap profiles whose process is gone + remove orphaned profile dirs. |
| `info` | Print resolved BASE / BIN / RUNDIR / EPHEM / port range / headless / base-open state. |
| `--help` / `-h` / (no args) | Print the usage block. |

IDs (`<port|name|pid>`) resolve in that order: an exact port runfile, then a matching
`NAME=`, then a matching `PID=`.

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

`up` waits for CDP (`/json/version`) to come up; on failure it kills the process, removes
the profile dir, and errors. On success it writes a runfile to `~/.cache/chad-browser/run/<port>.env`
and prints `PORT= NAME= PID= HTTP= WS= PROFILE=`.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `CHAD_BROWSER_BASE` | `~/.config/chromium` | Base profile to clone from (must contain `Default/`). |
| `CHAD_BROWSER_BIN` | `chromium` | Browser binary. **Use `chromium`, not `google-chrome`.** |
| `CB_PORT_MIN` / `CB_PORT_MAX` | `9300` / `9499` | Port range for auto-pick. |
| `CB_HEADLESS` | unset (headed) | Set `1` to default to headless. |

## Where things live

- Base profile: `~/.config/chromium` (Ahmed's real logins — the source of truth).
- Runfiles (tracked instances): `~/.cache/chad-browser/run/<port>.env`.
- Ephemeral profiles: `/tmp/chad-browser/<name>-<port>` (deleted on `down`).

The base browser (Ahmed's, typically CDP `9222`) and `google-chrome` are unrelated and
never touched.
