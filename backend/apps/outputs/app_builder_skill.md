# App Builder — Platform Reference

You are building an **App**: a self-contained web app rendered inside an
Electron `<webview>` (so it behaves like a real browser tab — cross-origin
`fetch`, popups, mic/camera, etc. all work). The workspace you're working
in is the source of truth — every file you write here is served directly
to the live preview.

---

## File conventions

| File | Required | Purpose |
|------|----------|---------|
| `index.html` | **Yes** | Entry point. Must be a complete HTML document. This is the ONLY file the preview loads — never rename it. |
| `meta.json` | **Yes** | `{"name":"…","description":"…"}` — displayed in the UI header. Always write this. |
| `backend.py` | Optional | Long-running HTTP server. See "Backend" below. |
| Everything else | Optional | JS, CSS, images, subdirectories — referenced from `index.html` via relative paths. |

### ⚠️ Do NOT

- Name the main HTML file anything other than `index.html` — the platform
  will not find it and the preview will be blank.
- Use `document.write()` — it breaks the injected data globals.
- Treat `backend.py` like a one-shot helper. It's a real HTTP server (see below).

---

## Injected globals

Before `index.html` loads, the platform injects:

```javascript
window.OUTPUT_INPUT       // Object — optional structured input (may be {})
window.OUTPUT_BACKEND_URL // string | null — base URL of the running backend.py, e.g. "http://127.0.0.1:54213"
```

`OUTPUT_BACKEND_URL` is `null` when the app has no `backend.py` (pure-frontend
app). When it's set, `fetch(window.OUTPUT_BACKEND_URL + '/your-route')` hits
the persistent backend.

---

## backend.py — persistent HTTP server

`backend.py` runs as a **long-lived subprocess** for the lifetime of the
app being open in the editor. It is **NOT a one-shot helper** that runs
once before render — it's a real backend server that responds to
frontend `fetch()` calls.

The platform auto-allocates a free port and exposes it via the env var
`PORT`. Your `backend.py` MUST bind to that port. Any standard Python
HTTP framework works (FastAPI, Flask, raw `http.server`).

Minimal FastAPI example:

```python
# backend.py
import os
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
# The frontend is served from http://localhost:8324 (different origin
# than this backend on http://127.0.0.1:$PORT), so CORS must allow it.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/items")
def list_items():
    return {"items": ["alpha", "beta", "gamma"]}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ["PORT"]))
```

Then in `index.html`:

```javascript
const res = await fetch(window.OUTPUT_BACKEND_URL + '/items');
const data = await res.json();
```

Stdout/stderr from `backend.py` stream live into the App Builder's
**Terminal** tab (prefixed `[BACKEND]`), so `print()` is your debugger.

---

## Multi-file projects

Split code across files for organization. All files are served from the
workspace root, so relative imports work naturally:

```
workspace/
├── index.html
├── meta.json
├── backend.py          (optional)
├── styles/
│   └── main.css
├── components/
│   └── Chart.js
└── utils/
    └── helpers.js
```

Reference from `index.html`:

```html
<link rel="stylesheet" href="./styles/main.css">
<script type="module" src="./components/Chart.js"></script>
```

ES module imports between JS files:

```javascript
// components/Chart.js
import { formatNumber } from '../utils/helpers.js';
```

---

## Using React

React 18 is available via esm.sh CDN — no build step needed:

```html
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@18",
    "react-dom/client": "https://esm.sh/react-dom@18/client"
  }
}
</script>
<div id="root"></div>
<script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const input = window.OUTPUT_INPUT || {};
  return React.createElement('div', null,
    React.createElement('h1', null, input.title || 'Hello')
  );
}

createRoot(document.getElementById('root')).render(
  React.createElement(App)
);
</script>
```

Other CDN libraries work too — use `https://esm.sh/` or `https://cdn.jsdelivr.net/npm/` for any npm package.

---

## Design guidelines

- **Dark theme by default** — use dark backgrounds (#0f1117, #1a1d27) with
  light text (#e2e8f0) unless the user requests otherwise.
- **Modern aesthetics** — rounded corners (8-12px), subtle borders, box shadows,
  smooth transitions (0.15-0.3s ease).
- **Responsive** — use flexbox/grid, test at different sizes.
- **Typography** — system font stack for UI, monospace for code/data.
- **Color accents** — use a single accent color with variations for hover/active states.
- **Spacing** — consistent padding (12-20px), adequate whitespace between sections.
- **Interactivity** — hover effects, focus states, loading indicators where appropriate.

---

## Complete minimal example

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>My App</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #1a1d27;
      border: 1px solid #2e3248;
      border-radius: 12px;
      padding: 32px;
      max-width: 480px;
      width: 100%;
    }
    h1 { font-size: 1.5rem; margin-bottom: 8px; }
    p { color: #8892a4; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1 id="title">Loading…</h1>
    <p id="desc"></p>
  </div>
  <script>
    const input = window.OUTPUT_INPUT || {};
    document.getElementById('title').textContent = input.title || 'Untitled';
    document.getElementById('desc').textContent = input.description || 'No description provided.';
  </script>
</body>
</html>
```
