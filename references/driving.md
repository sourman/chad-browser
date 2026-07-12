# chad-browser — driving the page

The `eval` subcommand runs JS in one of two contexts:

- **`--page`** — the JS runs in the page. `document.querySelector(...)` works directly.
  The body is auto-wrapped in `evalInPage(() => { ... })()` with IIFE detection —
  a bare expression returns its value; multi-statement bodies use `return`.
- **default (Node)** — the JS runs in the driver's Node process with the full CDP
  helper surface below in scope. The body is wrapped in an async function, so use
  `await` freely and **`return` the result**.

Both modes accept `--stdin` (pipe a heredoc) and `--file <path>` as alternatives to
the inline positional `<js>` arg — use `--stdin` for anything with nested quotes.

## What's in scope

| Name | What it does |
|---|---|
| `session.<Domain>.<Method>(params)` | Full raw CDP surface. `session.Page.navigate(...)`, `session.Runtime.evaluate(...)`, `session.Input.insertText(...)`, etc. Domain/method names map 1:1 to CDP. |
| `evalInPage(jsExprOrFn)` | `Runtime.evaluate` with `returnByValue:true, awaitPromise:true`. Accepts **either** a string expression **or** an arrow function (preferred — no quoting hell). Returns the value directly. The expression runs in the page's JS context. |
| `navigate(url, { timeout?, hint? })` | `Page.navigate` + wait for `readyState === 'complete'`. Preferred over the raw two-step — eliminates the #1 wrong-answer source (reading mid-hydration after a nav). |
| `waitForNavigation({ timeout?, hint? }, trigger)` | Arm a `Page.frameNavigated` listener, run `trigger` (e.g. a form submit or button click that causes a server-side navigation), then wait for the destination to settle. Returns the destination URL. Solves the read-after-submit pattern. |
| `typeInto(selector, text, { delay? })` | Focus a field, select-all, delete, then `Input.insertText`. **Replaces** the value (unlike raw `insertText`, which appends). Works on React-controlled inputs. Throws clearly on readonly/disabled/hidden/contenteditable. Returns the field's new value. |
| `resetInterception()` | Disable `Fetch`/`Network.setRequestInterception`. Call after traffic-interception experiments (blocking/mocking) so the loader doesn't stay wedged. Safe when no interception is active. |
| `waitForReady({ check, timeout?, hint? })` | Poll a JS expression (in the page) until it returns truthy. Default timeout 10s, interval 300ms. `hint` is a human label included in the timeout error. If `check` itself throws, the error is surfaced immediately. |
| `waitForDomStable({ timeout?, hint?, minStableMs? })` | Wait until `querySelectorAll('*').length` is unchanged across **3** consecutive polls AND no skeleton/spinner selectors present AND the stable window spans ≥ `minStableMs` (default 600ms). **Weak heuristic** — prefer `waitForReady({check})` against real content for production scraping. |
| `listPageTargets()` | Page targets from `Target.getTargets` (excludes chrome:// and devtools://). |
| `use(targetId)` | Switch the active target via `Target.attachToTarget`. For cross-origin iframes and multi-tab flows. |
| `onEvent(method, fn)` | Subscribe to a CDP event. Returns an unsubscribe function. See [Network events](#network-events--capturing-requests). |
| `captureRequests(urlPattern, fn, opts?)` | Run `fn` while collecting network requests whose URL matches `urlPattern` (substring or RegExp). Returns `{ requests, count }`. See [Network events](#network-events--capturing-requests). |
| `snapshotInteractive({ max? })` | Return `{ url, title, count, elements }` for all visible interactive elements on the page (links, buttons, inputs, selects, `[role]`, `[tabindex]`). Each element is a compact object (`{ tag, id?, classes?, role?, text?, href?, type?, placeholder?, value? }`). Use this instead of dumping `outerHTML` — you get the signal without the noise. |

`session` auto-routes to the active page target (set during `up`). Browser-level
methods (`Browser.*`, `Target.*`) go to the browser endpoint. No domain is denied
— you have the full CDP surface, including `Network`, `Page.captureScreenshot`,
`Browser.setDownloadBehavior`, `Target.attachToTarget`.

## Read-after-write: always wait for hydration

SPAs render skeleton/spinner placeholders for 1-3s before the real data. Reading
too early is the #1 source of wrong answers (empty rows, undercounted results,
stale counts). **Wait before you read.**

The `--wait` flag is the one-shot form — it polls a page JS expression until truthy,
then runs the body:

```bash
cat <<'JS' | chad-browser eval --name myagent --page --wait 'document.querySelectorAll("table tbody tr").length > 0' --stdin
const rows = [...document.querySelectorAll('table tbody tr')];
return rows.map(r => r.textContent.trim());
JS
```

From the Node context, the equivalent is `waitForReady` / `waitForDomStable`:

```js
// Explicit check — you know what "ready" means for this page.
await waitForReady({
  check: 'document.querySelectorAll("table tbody tr").length > 0',
  timeout: 10000,
  hint: 'table rows present',
});

// Or the framework-agnostic default when you don't know the skeleton class.
await waitForDomStable({ timeout: 10000, hint: 'initial render' });

// THEN read.
return await evalInPage('document.querySelector("h1").textContent');
```

The `hint` is important: on timeout, the error reads
`waitForReady timed out after 10000ms — table rows present (last value: null)`
instead of a bare `timeout`. That's the difference between debugging in one read
vs. ten turns of hypothesis.

## Navigate

Prefer the `navigate()` helper — it does the nav AND waits for `readyState`:

```js
await navigate('https://example.com/page');   // returns once readyState === 'complete'
return await evalInPage('document.title');
```

The raw form (if you need a custom readiness check):

```js
await session.Page.navigate({ url: 'https://example.com/page' });
await waitForReady({ check: 'document.readyState === "complete"', hint: 'navigation' });
return await evalInPage('document.title');
```

The driver auto re-attaches to the page target after every main-frame
navigation (it listens for `Page.frameNavigated`). If a `session.*` call lands
during the brief re-attach window and fails with a session error, the driver
retries it once on the fresh session. So `Page.navigate`, `Page.reload`, and
SPA route changes no longer detach you — but always follow a navigation with a
`waitForReady` / `waitForDomStable` so you don't read mid-hydration.

## Read DOM text

The cleanest path is `--page --wait --stdin` — the wait hydrates, then the body runs
in the page directly, no `evalInPage` wrapper needed:

```bash
cat <<'JS' | chad-browser eval --name myagent --page --wait 'document.querySelector("table tbody tr")' --stdin
const rows = [...document.querySelectorAll('table tbody tr')];
return rows.map(r => r.textContent.trim());
JS
```

From the Node context, the equivalent uses `evalInPage`. The expression must be a
single expression — wrap multi-statement logic in an IIFE:

```js
return await evalInPage(`
  (() => {
    const rows = [...document.querySelectorAll('table tbody tr')];
    return rows.map(r => r.textContent.trim());
  })()
`);
```

### DOM nodes auto-describe

`evalInPage` (and therefore `--page` mode) automatically describes DOM nodes in the
return value. Returning `document.querySelector('h1')` yields a descriptive string
like `"<h1 class=\"title\">Welcome</h1>"` instead of `{}` (the silent empty you'd
get from raw CDP `returnByValue`). This works recursively through arrays and
objects too:

```js
// In Node context:
return await evalInPage(() => document.querySelectorAll('a'));

// → [
//   '<a href="/login" text="Sign in">',
//   '<a href="/signup" text="Sign up">',
//   '<a class="nav.logo" href="/" text="Home">'
// ]
```

### Snapshot interactive elements

When you don't know the page structure, prefer `snapshotInteractive()` over dumping
`outerHTML` — you get a clean list of every actionable element without megabytes of
div noise:

```js
const snap = await snapshotInteractive();
// snap.elements[0] → { tag: 'a', text: 'Sign in', href: '/login' }
// snap.elements[1] → { tag: 'input', type: 'email', placeholder: 'you@x.com', name: 'email' }
// snap.elements[2] → { tag: 'button', text: 'Continue', classes: ['btn', 'btn-primary'] }
return snap;
```

## Click

```js
// Direct DOM click — works for plain elements.
await evalInPage('document.querySelector("button#submit").click()');

// For elements where the React handler is on a parent, or coordinates matter,
// use Input.dispatchMouseEvent via the node's bounding box.
await evalInPage(`
  const el = document.querySelector('[aria-label="Drafts"]');
  const r = el.getBoundingClientRect();
  window.__click = { x: r.x + r.width/2, y: r.y + r.height/2 };
`);
const c = await evalInPage('window.__click');
await session.Input.dispatchMouseEvent({ type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
await session.Input.dispatchMouseEvent({ type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
```

## Fill inputs

The ergonomic helper handles focus + select-all + delete + insert in one call,
and **replaces** the value (raw `Input.insertText` appends):

```js
// Works on plain HTML AND React-controlled inputs.
const newVal = await typeInto('input[placeholder*="Search"]', 'HIPAA');
return newVal;
```

**Form submit + read the result page.** When a form submit triggers a
server-side navigation, use `waitForNavigation` to arm a listener *before* the
submit, then read the destination page once it settles — no blind polling:

```js
// Navigate to the form page FIRST, outside waitForNavigation.
await navigate('https://example.com/login', { hint: '#username' });
const dest = await waitForNavigation(
  { hint: 'login result' },
  async () => {
    await typeInto('#username', 'wronguser');
    await typeInto('#password', 'wrongpass');
    await evalInPage('document.querySelector("form").submit()');
  },
);
// dest is the destination URL; page is ready for reads.
const result = await evalInPage(() => ({
  url: location.href,
  hasError: !!document.querySelector('.alert-danger'),
  bodyText: document.body.innerText.substring(0, 500),
}));
return { dest, ...result };
```

> **Don't `navigate()` inside the `waitForNavigation` trigger.** `navigate()`
> itself fires `Page.frameNavigated`, which the listener will catch as the
> "navigation" and return early — before your submit even runs. Navigate to the
> form page first, then arm the listener around just the submit action.

> **`evalInPage` accepts an arrow function.** The quoting of nested strings and
> regexes inside `evalInPage('...')` is painful (you have to double-escape).
> Pass an arrow function instead — it runs in the page with native quoting:
>
> ```js
> // Painful: nested quotes, double-escaped regex
> await evalInPage('(() => { const m = document.body.innerHTML.match(/<a[^>]*href="([^"]*)"/); return m ? m[1] : null; })()');
>
> // Clean: arrow function, native quoting
> await evalInPage(() => {
>   const m = document.body.innerHTML.match(/<a[^>]*href="([^"]*)"/);
>   return m ? m[1] : null;
> });
> ```

> **Selector tip:** don't copy selectors from docs verbatim — sites change.
> Verify a selector exists with `evalInPage('document.querySelector("...")?.tagName')`
> before typing into it. (E.g. Google's search box moved from `input[name=q]`
> to `textarea[name=q]`.)

## Downloads

Set the download behavior before clicking the download trigger:

```js
await session.Browser.setDownloadBehavior({ behavior: 'allow', downloadPath: '/tmp/chad-downloads' });
// ...click the export button, fill the form, click "Generate CSV"...
// The download is async on the browser side; sleep briefly to let it start,
// then verify on disk from the shell after eval returns.
await new Promise(r => setTimeout(r, 2000));
```

Then from bash: `ls -la /tmp/chad-downloads/` to confirm the file landed. For
robust verification, poll the directory from bash (Node can't easily stat the
file inside the driver context).

## Cross-origin iframes

The active target is the parent page. To read an iframe's `src` you don't need to
attach — it's in the parent DOM:

```js
return await evalInPage('document.querySelector("iframe")?.src');
```

To *interact with* the iframe's content, attach to its target:

```js
const targets = await listPageTargets();
// The iframe shows up as an iframe target in Target.getTargets:
const all = await session.Target.getTargets({});
const iframe = all.targetInfos.find(t => t.type === 'iframe');
if (iframe) await use(iframe.targetId);
return await evalInPage('document.title');  // now reads the iframe's document
```

## Network events / capturing requests

CDP pushes events (`Network.requestWillBeSent`, `Page.frameNavigated`, etc.)
as you drive the page. The driver subscribes to the `Page`, `Runtime`, `DOM`,
and `Network` domains automatically on attach — **you do not need to (and
should not) call `Network.enable` / `Page.enable` yourself.**

### `onEvent(method, fn)`

Subscribe to a single CDP event. `method` is the **full event name** as a
string (e.g. `'Network.requestWillBeSent'`). `fn` receives `(params, sessionId)`.
Returns an unsubscribe function — **call it when you're done** so listeners
don't pile up across evals.

```js
const seen = [];
const unsub = onEvent('Network.requestWillBeSent', (p) => {
  if (p.request.url.includes('/api/')) seen.push({ url: p.request.url, method: p.request.method });
});
// ...trigger the action that fires the requests...
await evalInPage('document.querySelector("#load-more").click()');
await waitForDomStable({ hint: 'requests settled' });
unsub();
return seen;
```

### `captureRequests(urlPattern, fn, opts?)` — the ergonomic wrapper

The common case is "run this action and tell me what API calls it made."
`captureRequests` wires up the request/response/body listeners for you, runs
`fn`, waits a beat for trailing responses, unsubscribes, and returns the
collected records.

- `urlPattern`: substring or RegExp. Substrings are escaped to literal matches.
- `fn`: async function that performs the click/navigate/etc.
- `opts.body` (default `true`): fetch response bodies via `Network.getResponseBody`.
- Returns `{ requests: [{ requestId, url, method, headers, postData, status, responseHeaders, mimeType, body }], count }`.

```js
const { requests, count } = await captureRequests('/rest/policies', async () => {
  await evalInPage('document.querySelector("[aria-label=Filter]").click()');
  await waitForDomStable({ hint: 'filter results loaded' });
});
return { count, first: requests[0] };
```

### Pitfalls (read these once)

- **`session.Network.requestWillBeSent(...)` is NOT a thing.** That name is an
  *event*, not a method. Calling it sends `Network.requestWillBeSent` as a CDP
  *method*, which doesn't exist — CDP returns an error and the call rejects.
  Events are consumed via `onEvent` / `captureRequests`, never via `session.*`.
  This was the single biggest source of driver crashes in the incident agent.
- **`Page.reload({})` inside an eval is fine now** — the driver auto re-attaches
  after the reload's `frameNavigated`. Previously it detached the target and
  every subsequent call failed. You still must `waitForReady` after.
- **Listeners persist for the life of the driver unless you unsubscribe.** If
  you `onEvent` inside an `eval` and don't `unsub()`, the listener survives
  into the next eval and keeps firing. Prefer `captureRequests`, which
  auto-unsubscribes.
- **`requestWillBeSent` can fire multiple times for one logical request**
  (redirects, service-worker handoffs). If you de-dupe low-level `onEvent`
  output, key by `requestId`. `captureRequests` already de-dupes for you.
- **Readiness checks should assert a content selector, not just a URL substring.**
  Error/redirect pages (CAPTCHAs, bot-detection "sorry" pages, login walls)
  often echo query params, so a check like `location.search.includes('q=')`
  passes on the wrong page. Assert something like
  `document.querySelector('#search h3')` instead — a node that only exists on
  the page you actually want.

## Traffic interception (mocking / blocking / rewriting)

The `Fetch` domain is the headline power-user capability — you can block requests,
mock responses, and rewrite headers before they're sent. This is what the "raw
CDP" design exists to unlock.

```js
// Block all requests to an ad/analytics domain.
await session.Fetch.enable({ patterns: [{ urlPattern: '*doubleclick.net*' }] });
const unsub = onEvent('Fetch.requestPaused', async (p) => {
  // Inspect p.request.url / p.request.headers, then either:
  await session.Fetch.failRequest({ requestId: p.requestId, errorReason: 'BlockedByClient' });
  // ...or let it through: await session.Fetch.continueRequest({ requestId: p.requestId });
});
// ...do work...
unsub();
await resetInterception();   // MUST disable before navigating, or the loader wedges
```

**Critical pitfall:** if you `Fetch.failRequest` on a **main-frame** request (or
forget to `Fetch.disable`), the page's loader wedges and every subsequent nav
times out. Two recoveries:

1. Call `resetInterception()` (disables `Fetch` + clears interception patterns),
   then `navigate()` — which now auto-creates a fresh target if the old one's
   loader is stuck.
2. Or `await resetInterception()` then `navigate(url)` — `navigate` handles the
   fresh-target path internally if it detects an aborted load.

`Network.setExtraHTTPHeaders({ headers })` works and **persists across navigations** —
remember to reset it (`session.Network.setExtraHTTPHeaders({ headers: {} })`) when done,
or it poisons every later request.

## Multi-tab

`up url1 url2` opens multiple tabs. Two gotchas:

- **Not supported with `--headless`** (Chromium limitation) — `up` will fail fast
  with a clear error. Open one URL and create the rest via `Target.createTarget`.
- **The driver attaches to a non-deterministic tab.** Always call `listPageTargets()`
  and `use(targetId)` before driving after a multi-URL `up` — don't assume you're
  on the first URL.

```js
const targets = await listPageTargets();
const myTab = targets.find(t => t.url.includes('my-first-url'));
await use(myTab.targetId);
// use() enables read domains on the new session, so onEvent/captureRequests work
// immediately even without a subsequent navigation.
return await evalInPage('document.title');
```

## Screenshots

```js
const { data } = await session.Page.captureScreenshot({ format: 'png' });
return data;  // base64 PNG — write to disk from bash or pass to the caller
```

The reply is `{"value":"<base64>"}`. To save it as a PNG from bash:

```bash
chad-browser eval 'const { data } = await session.Page.captureScreenshot({ format: "png" }); return data;' \
  | jq -r '.value' | base64 -d > /tmp/shot.png
```

## Multi-step scripts

For flows longer than a few lines, pipe a heredoc to `--stdin` (preferred — no temp
file, no shell-quoting pain):

```bash
cat <<'JS' | chad-browser eval --name myagent --stdin
await navigate('https://example.com');
await waitForReady({ check: 'document.readyState === "complete"', hint: 'load' });
const title = await evalInPage('document.title');
const links = await evalInPage('[...document.querySelectorAll("a")].map(a => a.href)');
return { title, links };
JS
```

Or write to a file and use `script` / `eval --file`:

```bash
cat > /tmp/flow.js <<'EOF'
await navigate('https://example.com');
await waitForReady({ check: 'document.readyState === "complete"', hint: 'load' });
const title = await evalInPage('document.title');
const links = await evalInPage('[...document.querySelectorAll("a")].map(a => a.href)');
return { title, links };
EOF
chad-browser script --name myagent /tmp/flow.js
```

## Memory (sharing facts across agents)

When multiple agents visit the same app (e.g. several agents testing different
routes of a dev server), they can share hard-won knowledge: which selectors work,
where the server lives, how to wait for hydration, etc.

**Implicit surfacing on navigation:** when you call `navigate(url)`, the driver
computes a memory key from the URL and checks for a memory file. If facts exist
and haven't been surfaced yet this session, they ride along in the return value:

```javascript
const result = await navigate('http://localhost:8080/w/regulatory-qa');
// If no memories: result === "http://localhost:8080/w/regulatory-qa" (string)
// If memories exist (first time this session):
//   result === {
//     href: "http://localhost:8080/w/regulatory-qa",
//     memory: {
//       key: "localhost",
//       path: "~/.cache/chad-browser/memory/localhost.json",
//       facts: [
//         { fact: "chat textarea: textarea.flex.w-full",
//           url: "http://localhost:8080/w/regulatory-qa",
//           title: "[edge-watchdog-combined] Cora - ...",
//           created: "2026-07-11T21:30:00Z",
//           age: "2h" },
//         ...
//       ],
//       note: "Memories from prior sessions on \"localhost\". ..."
//     }
//   }
```

Each key surfaces **once per session** — you see the facts, remember them, done.

**Key resolution (how the driver decides which file to check):**
- Non-localhost URL → hostname (`kijiji.ca`, `app-prod.example.com`)
- localhost / 127.0.0.1 → `localhost` (all dev servers share one file)
  - Memories are fuzzy-matched by page title so the right facts surface for the
    right app (e.g. `[main] Cora` matches `[edge-watchdog-combined] Cora` at 0.75)
- `--app <name>` overrides everything (use it to group or separate apps)

**The `up` output always shows the memory path:**
```
MEMORY=~/.cache/chad-browser/memory/localhost.json (3 facts, key=localhost)
```

**Writing memories:** use your native file tools on that path. The file is a JSON
array of structured records:

```json
[
  {
    "fact": "chat textarea selector: textarea.flex.w-full",
    "url": "http://localhost:8080/w/regulatory-qa",
    "title": "[edge-watchdog-combined] Cora - Your Personal Compliance Coach",
    "created": "2026-07-11T21:30:00Z"
  }
]
```

Always include `url` and `title` — they let future agents verify the memory
applies (especially on localhost where multiple apps share one file). The driver
computes `age` from `created` when surfacing, so the agent can reason temporally
("this is 2 days old, the UI may have changed").

**Search across all apps:** `Grep` in `~/.cache/chad-browser/memory/`.

**Override the key:** pass `--app <name>` on `up` to force a specific key.

## Error handling

- A failed CDP call rejects with `Error: CDP <code>: <message>`.
- A failed `evalInPage` (JS exception in the page) rejects with `Error: page JS error: <description>`.
- A failed top-level `eval` body rejects with the error message and stack in the reply JSON.
- A timeout in `waitForReady` / `waitForDomStable` rejects with a labeled message — read the label.
- If your `waitForReady({ check })` expression itself throws (typo'd selector, runtime error),
  the error is surfaced immediately as `waitForReady check threw: ...` rather than timing out.
- A `session.*` call that fails because the page navigated is auto-retried once after re-attach.
- The eval body has a **120s default timeout** (overridable via `chad-browser eval --timeout <ms>`
  or the request's `timeout` field; capped at 600000ms / 10min). An await-yielding runaway
  loop (`while(true){ await something() }`) is caught and returns an error. A **purely
  synchronous** infinite loop (`while(true){}`) cannot be interrupted from the same process
  and will wedge the driver — the only recovery is `chad-browser down` + `up`.

### Return contract (what serializes, what silently empties)

The eval's return value is JSON-serialized. Most values work fine, but some silently
produce `{}` (empty) — always read primitive values, not live objects:

| Return value | Result | Notes |
|---|---|---|
| `string`, `number`, `boolean`, `null` | works | |
| `undefined` | `{"value":null}` | coerced for you (not dropped) |
| `BigInt` | `{"value":"123n"}` | stringified with `n` suffix |
| object with circular refs | `{"value":{...,"[Circular]":"..."}}` | no longer hangs |
| plain `{a:1}` / arrays | works | |
| `Map`, `Set` | `{"value":{}}` **silent empty** | spread first: `[...map.entries()]` |
| DOM node (`document.body`) | `{"value":{}}` **silent empty** | read `.textContent` / `.value` instead |
| `{ a: undefined }` | `{"value":{"a":null}}` | `undefined` keys are coerced to `null` |

> **Rule of thumb:** `return await evalInPage("el.textContent")`, never
> `return await evalInPage("el")`. Pull the primitive (string/number) out of the
> page in the same expression that reads the node.

### Recovering from a closed page (`window.close()`)

If the page closes itself (`window.close()`, some OAuth popups), the driver's
auto-re-attach will **create a fresh `about:blank` target** and resume on it.
So you won't be left stranded — but anything you had on the old page (DOM state,
form input) is gone. To drive a specific URL after a close, just call
`navigate(url)` and the fresh target will load it.
