#!/usr/bin/env python3
"""Browser checks for the public layer controls (Playwright + Chromium)."""
import http.server
import pathlib
import subprocess
import sys
import threading
from contextlib import closing

try:
    from playwright.sync_api import sync_playwright
except ImportError as exc:
    raise SystemExit("Playwright is unavailable; install the project test requirements to run browser checks.") from exc

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
subprocess.run([sys.executable, str(ROOT / "tools" / "build_dist.py")], check=True)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST), **kwargs)

    def log_message(self, *_args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{server.server_port}/"
checks = []


def check(name, condition):
    checks.append((name, bool(condition)))
    print(("PASS " if condition else "FAIL ") + name)


try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page_errors = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_selector("#route-list .route", timeout=30000)
        page.wait_for_function("document.querySelector('#dataset-summary').textContent.includes('MOLA MEGDR')", timeout=30000)

        initial_routes = page.locator("#route-list").inner_text()
        initial_elevation = page.locator("#elevation-layer").input_value()
        page.select_option("#imagery-layer", "off")
        check("imagery can be disabled independently", page.locator("#elevation-layer").input_value() == initial_elevation)
        check("imagery-off state is visible", "Imagery disabled" in page.locator("#globe-status").inner_text())
        check("imagery selection preserves automatic route results", page.locator("#route-list").inner_text() == initial_routes)

        page.select_option("#elevation-layer", "hirise")
        page.wait_for_function("document.querySelector('#dataset-summary').textContent.includes('HiRISE DTM')")
        check("HiRISE selection leaves imagery selection unchanged", page.locator("#imagery-layer").input_value() == "off")
        check("HiRISE source loads into the terrain planner", "HiRISE" in page.locator("#elevation-status").inner_text())

        page.select_option("#elevation-layer", "mola")
        page.wait_for_function("document.querySelector('#dataset-summary').textContent.includes('MOLA MEGDR')")
        automatic_routes = page.locator("#route-list").inner_text()
        page.select_option("#elevation-layer", "ctx")
        page.wait_for_function("document.querySelector('#ctx-terrain-status').textContent.toLowerCase().includes('failure') || document.querySelector('#ctx-terrain-status').textContent.toLowerCase().includes('unconfigured')", timeout=30000)
        check("CTX failure is reported with a retry control", not page.locator("#retry-ctx-analysis").is_hidden())
        check("CTX mode clearly excludes automatic routing", "CTX Dijkstra routing is not implemented" in page.locator("#automatic-route-source").inner_text())
        check("CTX selection preserves MOLA automatic routes", page.locator("#route-list").inner_text() == automatic_routes)
        page.locator("#retry-ctx-analysis").click()
        page.wait_for_function("document.querySelector('#ctx-terrain-status').textContent.toLowerCase().includes('failure')", timeout=30000)
        check("CTX retry repeats the catalog request and reports its failure", not page.locator("#retry-ctx-analysis").is_hidden())

        page.select_option("#imagery-layer", "viking")
        check("Viking VIS can be selected without changing CTX elevation", page.locator("#elevation-layer").input_value() == "ctx")
        page.set_viewport_size({"width": 390, "height": 844})
        check("mobile layer controls remain visible", page.locator("#panel-layers").is_visible() and page.locator("#elevation-layer").is_visible())
        check("no browser runtime errors", not page_errors)
        browser.close()
finally:
    server.shutdown()
    server.server_close()

failed = [name for name, passed in checks if not passed]
print(f"{len(checks) - len(failed)}/{len(checks)} browser checks passed")
raise SystemExit(bool(failed))
