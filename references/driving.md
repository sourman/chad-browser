# chad-browser — driving the page

The `eval` and `script` subcommands run JS in a Node context connected to one
page target. The JS body is wrapped in an async function, so use `await` freely
and **`return` the result**.

## What's in scope

| Name | What it does |
|---|---|
| `session.<Domain>.<Method>(params)` | Full raw CDP surface. `session.Page.navigate(...)`, `session.Runtime.evaluate(...)`, `session.Input.insertText(...)`, etc. Domain/method names map 1:1 to CDP. |
| `evalInPage(jsExpr)` | `Runtime.evaluate` with `returnByValue:true, awaitPromise:true`. Returns the value directly. The expression runs in the page's JS context. |
| `waitForReady({ check, timeout?, hint? })` | Poll a JS expression (in the page) until it returns truthy. Default timeout 10s, interval 300ms. `hint` is a human label included in the timeout error. |
| `waitForDomStable({ timeout?, hint? })` | Wait until `querySelectorAll('*').length` is unchanged across two polls AND no skeleton/spinner selectors present. Framework-agnostic default. |
| `listPageTargets()` | Page targets from `Target.getTargets` (excludes chrome:// and devtools://). |
| `use(targetId)` | Switch the active target via `Target.attachToTarget`. For cross-origin iframes and multi-tab flows. |

`session` auto-routes to the active page target (set during `up`). Browser-level
methods (`Browser.*`, `Target.*`) go to the browser endpoint. No domain is denied
— you have the full CDP surface, including `Network`, `Page.captureScreenshot`,
`Browser.setDownloadBehavior`, `Target.attachToTarget`.

## Read-after-write: always wait for hydration

SPAs render skeleton/spinner placeholders for 1-3s before the real data. Reading
too early is the #1 source of wrong answers (empty rows, undercounted results,
stale counts). **Wait before you read.**

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

```js
await session.Page.navigate({ url: 'https://example.com/page' });
await waitForReady({ check: 'document.readyState === "complete"', hint: 'navigation' });
return await evalInPage('document.title');
```

## Read DOM text

```js
return await evalInPage(`
  (() => {
    const rows = [...document.querySelectorAll('table tbody tr')];
    return rows.map(r => r.textContent.trim());
  })()
`);
```

The expression must be a single expression. Wrap multi-statement logic in an IIFE.

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

Plain HTML inputs — set `.value` and dispatch `input`:

```js
await evalInPage(`
  const i = document.querySelector('input[name=q]');
  i.value = 'search term';
  i.dispatchEvent(new Event('input', { bubbles: true }));
`);
```

React-controlled inputs — React ignores `.value =`. Use `Input.insertText`:

```js
await evalInPage('document.querySelector("input[placeholder*=Search]").focus()');
await session.Input.insertText({ text: 'HIPAA' });
// If insertText doesn't trigger the React onChange (some controlled inputs reject it),
// fall back to per-character key events:
// await session.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Backspace' });
// for (const ch of 'HIPAA') await session.Input.dispatchKeyEvent({ type: 'char', text: ch });
```

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

## Screenshots

```js
const { data } = await session.Page.captureScreenshot({ format: 'png' });
return data;  // base64 PNG — write to disk from bash or pass to the caller
```

## Multi-step scripts

For flows longer than a few lines, write to a file and use `script`:

```bash
cat > /tmp/flow.js <<'EOF'
await session.Page.navigate({ url: 'https://example.com' });
await waitForReady({ check: 'document.readyState === "complete"', hint: 'load' });
const title = await evalInPage('document.title');
const links = await evalInPage('[...document.querySelectorAll("a")].map(a => a.href)');
return { title, links };
EOF
chad-browser script /tmp/flow.js
```

## Error handling

- A failed CDP call rejects with `Error: CDP <code>: <message>`.
- A failed `evalInPage` (JS exception in the page) rejects with `Error: page JS error: <description>`.
- A failed top-level `eval` body rejects with the error message and stack in the reply JSON.
- A timeout in `waitForReady` / `waitForDomStable` rejects with a labeled message — read the label.

If an `eval` hangs, the instance may have navigated away from the attached target.
Check `chad-browser list` (DRIVER column) and re-attach with `use`.
