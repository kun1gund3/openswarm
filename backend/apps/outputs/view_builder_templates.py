"""Default template files seeded into new App Builder workspaces."""

import os

# Absolute path to the bundled skill source. Surfaced as a constant so the
# skills subsystem can register it as a built-in skill (copy into
# ~/.claude/skills/ on first boot) without re-deriving the path.
APP_BUILDER_SKILL_SOURCE_PATH = os.path.join(os.path.dirname(__file__), "app_builder_skill.md")

# Bundled default — used as the read-once fallback if the user-editable
# copy at ~/.claude/skills/app_builder_skill.md has been removed despite
# the built-in flag (defensive; shouldn't happen in normal use).
with open(APP_BUILDER_SKILL_SOURCE_PATH, encoding="utf-8") as _f:
    APP_BUILDER_SKILL_DEFAULT = _f.read()


def load_app_builder_skill() -> str:
    """Return the live App Builder skill content. Prefers the
    user-editable copy at ~/.claude/skills/app_builder_skill.md (so a
    user's edit on the Skills page takes effect on the very next App
    Builder agent turn — no restart, no copy-on-edit dance). Falls back
    to the bundled default if the user file is somehow gone."""
    user_path = os.path.expanduser("~/.claude/skills/app_builder_skill.md")
    if os.path.exists(user_path):
        try:
            with open(user_path, encoding="utf-8") as f:
                return f.read()
        except Exception:
            pass
    return APP_BUILDER_SKILL_DEFAULT


# Backward-compat alias. Older callers import VIEW_BUILDER_SKILL directly —
# point them at the same content as the user-editable version so a "frozen
# at import" stale copy can't drift from what the skills page shows.
VIEW_BUILDER_SKILL = APP_BUILDER_SKILL_DEFAULT

VIEW_TEMPLATE_INDEX = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>App</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .container {
      background: #1a1d27;
      border: 1px solid #2e3248;
      border-radius: 12px;
      padding: 32px;
      max-width: 600px;
      width: 100%;
      text-align: center;
    }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 8px; }
    p { color: #8892a4; font-size: 0.95rem; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="container">
    <h1 id="title">Ready</h1>
    <p id="desc">Describe what you want to build and the agent will update this app.</p>
  </div>
  <script>
    const input = window.OUTPUT_INPUT || {};
    const result = window.OUTPUT_BACKEND_RESULT || null;
  </script>
</body>
</html>
"""

VIEW_TEMPLATE_SCHEMA = """\
{
  "type": "object",
  "properties": {},
  "required": []
}
"""

VIEW_TEMPLATE_META = """\
{
  "name": "",
  "description": ""
}
"""

VIEW_TEMPLATE_FILES = {
    "index.html": VIEW_TEMPLATE_INDEX,
    "schema.json": VIEW_TEMPLATE_SCHEMA,
    "meta.json": VIEW_TEMPLATE_META,
}
