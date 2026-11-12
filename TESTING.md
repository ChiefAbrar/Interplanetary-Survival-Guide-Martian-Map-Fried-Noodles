# Development testing

## Browser test setup (Windows PowerShell)

Create a project-local virtual environment, install the pinned development dependency, and install Playwright's matching Chromium browser:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m playwright install chromium
```

Run the browser suite with the virtual environment interpreter:

```powershell
.\.venv\Scripts\python.exe test/ui_test.py
```

The UI test runs `tools/build_dist.py` before launching the browser, so it regenerates `dist/` and any terrain derivative whose raw source pair is present.

Run JavaScript checks from the project root:

```powershell
node --check public/js/app.js
node --test test/routing.test.js
node --test "test/*.test.js"
```
