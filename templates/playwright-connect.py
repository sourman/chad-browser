#!/usr/bin/env python3
"""Connect Playwright to a running chad-browser instance over CDP and drive the page.

The browser is launched by `chad-browser up` (seeded with Ahmed's logins) — Playwright
only attaches; it does NOT launch a browser. Needs the Playwright driver only:
    pip install playwright

Usage:
    chad-browser up --name myagent https://example.com
    WS=$(chad-browser cdp myagent)
    python3 playwright-connect.py "$WS"
    chad-browser down myagent
"""
import sys
from playwright.sync_api import sync_playwright


def main(ws_endpoint: str) -> None:
    with sync_playwright() as p:
        # connect_over_cdp attaches to the already-running browser chad-browser launched.
        browser = p.chromium.connect_over_cdp(ws_endpoint)
        context = browser.contexts[0]                  # the seeded profile context
        page = context.pages[0] if context.pages else context.new_page()

        print("title:", page.title())
        h1 = page.locator("h1").first.text_content()
        print("h1:   ", h1)

        # Auth is already present — no login step needed. Example interaction:
        #   page.goto("https://app.example.com/dashboard")
        #   page.get_by_role("button", name="Export").click()
        #   page.screenshot(path="out.png", full_page=True)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: playwright-connect.py <ws_endpoint>  (get it from: chad-browser cdp <id>)")
    main(sys.argv[1])
