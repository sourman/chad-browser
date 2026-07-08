# chad-browser

Isolated, pre-authenticated Chromium instances for AI agents — with a built-in CDP driver daemon.

Each `chad-browser up` clones your base Chromium profile (`~/.config/chromium`, which holds your logins) into a fresh throw-away `--user-data-dir`, launches Chromium with remote debugging on its own port, **and** spawns a driver daemon that holds the CDP WebSocket connection and serves a JS eval surface over a Unix socket. The agent drives the page with `chad-browser eval '<js>'` — no driver library, no WS wiring, no per-call CDP client setup.

- **Pre-authenticated**: logins carry over from the base profile, so agents start already signed in.
- **Isolated**: every launch is its own browser + port + profile + driver socket. No two agents fight over a tab.
- **Raw CDP, first-class**: the driver exposes the full Chrome DevTools Protocol surface (`session.Page.navigate(...)`, `session.Runtime.evaluate(...)`, `session.Input.insertText(...)`, `Target.attachToTarget`, downloads, iframes, network — nothing is denied or abstracted away).
- **Instance-aware by default**: bare `eval` resolves to "my instance" by walking the process tree to the launching shell. Parallel agents in separate shells resolve to separate instances automatically.
- **Hydration-aware**: `waitForReady({ check, timeout, hint })` and `waitForDomStable()` cure the #1 SPA bug — reading a table mid-hydration and getting skeleton-row counts.

## The core loop

```bash
chad-browser up   --name myagent https://app.example.com    # launch + driver
chad-browser eval 'return await evalInPage("document.title")'          # drive
chad-browser down myagent                                             # tear down
```

## Install

Requires: `chromium`, `node` (v22+ for global `WebSocket`), `python3`, `sqlite3`.

```bash
git clone https://github.com/sourman/chad-browser.git ~/.claude/skills/chad-browser
ln -sf ~/.claude/skills/chad-browser/bin/chad-browser ~/.local/bin/chad-browser
```

The base profile (`~/.config/chromium`) must already hold the logins you want agents to inherit. Log in to the base Chromium once; every clone inherits it. A login done inside one clone does **not** reach the base or other clones.

See [`SKILL.md`](SKILL.md) for the agent-facing entry point and [`references/`](references/) for the full docs:
- [`references/driving.md`](references/driving.md) — the JS eval surface and common recipes (navigate, click, React inputs, downloads, cross-origin iframes, screenshots, hydration waits).
- [`references/commands.md`](references/commands.md) — every command, flag, env var, exit code.
- [`references/auth-and-cdp.md`](references/auth-and-cdp.md) — how seeded auth works and the gotchas that silently break it.
- [`references/workflows.md`](references/workflows.md) — single-instance driving, parallel agents, teardown hygiene.

## Why this exists

Built after a head-to-head race (10 agents, 5 models, 5 tasks on a live React app) comparing raw-CDP driving against a high-level browser MCP. The raw-CDP track won cleanly on capability (downloads verified 5/5 vs 0/5; cross-origin iframe located 5/5 vs 0/5), but every agent struggled with the same three things: attaching to the wrong browser via auto-detect, forgetting to enable CDP domains, and reading tables mid-hydration. chad-browser's driver fixes all three structurally — no auto-detect exists (the driver is handed its WS URL), read domains are auto-enabled, and `waitForReady` / `waitForDomStable` are first-class primitives.

## License

MIT
