# chad-browser — workflows

Common recipes. Each assumes the base profile already holds the needed logins (see
`auth-and-cdp.md`) and that `up` has spawned the driver daemon.

## Single instance: launch, drive, teardown

```bash
chad-browser up --name myagent https://app.example.com

# Drive — the driver daemon is already attached to the page.
chad-browser eval 'return await evalInPage("document.title")'

# Multi-step flow → write to a file.
cat > /tmp/flow.js <<'EOF'
await session.Page.navigate({ url: 'https://app.example.com/dashboard' });
await waitForReady({ check: 'document.querySelector(".dashboard") !== null', hint: 'dashboard' });
return await evalInPage('document.querySelector(".user-count").textContent');
EOF
chad-browser script /tmp/flow.js

chad-browser down myagent
```

## Headless / unattended

```bash
chad-browser up --headless --name bot https://example.com        # one-off
CB_HEADLESS=1 chad-browser up --name bot https://example.com     # default for the shell
```

`--headless=new` is applied for you.

## Parallel agents (no collisions)

Each `up` is its own browser + port + profile + driver socket, so just give them
distinct names. Each agent's shell resolves to its own instance automatically (the
runfile records the launching shell's PID).

```bash
# Agent A's shell:
chad-browser up --name agent-a https://app.example.com
chad-browser eval 'return await evalInPage("location.hostname")'   # → "app.example.com" via agent-a

# Agent B's shell (concurrent):
chad-browser up --name agent-b https://other.example.com
chad-browser eval 'return await evalInPage("location.hostname")'   # → "other.example.com" via agent-b
```

When multiple instances share one shell (rare — usually you want separate shells),
pass `--id <name>` to `eval`/`script` to disambiguate.

Names default to `chad-<port>`; ports auto-pick from `CB_PORT_MIN..CB_PORT_MAX`.

## Open several URLs at once

```bash
chad-browser up --name research https://a.com https://b.com https://c.com
```

Each becomes a tab in the one instance. Use `listPageTargets()` + `use(targetId)`
in `eval` to switch between them.

## Pass a Chromium flag

```bash
chad-browser up --name proj https://localhost:8443 -- --ignore-certificate-errors
```

## Raw CDP fallback (no driver)

If the driver daemon isn't installed (`~/.local/lib/chad-browser/driver.mjs` missing),
`up` still launches the browser — you just drive it over raw CDP:

```bash
chad-browser up --name raw https://example.com
PORT=$(chad-browser list | awk '$2=="raw"{print $1}')
curl -s "http://127.0.0.1:$PORT/json" | python3 -c 'import sys,json;[print(t["title"],"->",t["url"]) for t in json.load(sys.stdin)]'
chad-browser down raw
```

This is the zero-dependency path (no Node required). The driver path is strongly
preferred — it auto-enables read domains, handles target attachment, and gives you
`waitForReady`.

## Teardown hygiene

```bash
chad-browser list                 # what's running + driver alive?
chad-browser down <id>            # stop one (port|name|pid) — kills driver + browser
chad-browser gc                   # reap dead processes' profiles + sockets + orphans
```

Always `down` what you `up`. Profiles live in `/tmp/chad-browser/`, sockets in
`$XDG_RUNTIME_DIR/chad-browser/`; both are removed on `down`. `gc` cleans any that
leaked (e.g. a killed shell).
