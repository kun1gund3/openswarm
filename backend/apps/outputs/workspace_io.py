"""On-disk persistence for outputs: Output JSON records under DATA_DIR and
the workspace file-tree walk used by the polling read endpoint."""

import json
import os

from fastapi import HTTPException

from backend.apps.outputs.models import Output
from backend.config.paths import OUTPUTS_DIR as DATA_DIR


def _load_all() -> list[Output]:
    result = []
    if not os.path.exists(DATA_DIR):
        return result
    for fname in os.listdir(DATA_DIR):
        if fname.endswith(".json"):
            with open(os.path.join(DATA_DIR, fname)) as f:
                result.append(Output(**json.load(f)))
    return result


def _save(output: Output):
    with open(os.path.join(DATA_DIR, f"{output.id}.json"), "w") as f:
        json.dump(output.model_dump(), f, indent=2)


def _load(output_id: str) -> Output:
    path = os.path.join(DATA_DIR, f"{output_id}.json")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Output not found")
    with open(path) as f:
        return Output(**json.load(f))


def load_output(output_id: str) -> Output | None:
    """Public helper for other modules to resolve an output by ID."""
    path = os.path.join(DATA_DIR, f"{output_id}.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return Output(**json.load(f))


# Build/install/cache directories that the polling endpoint must never
# descend into. Without this skip-list the workspace endpoint reads
# `node_modules/` (300 MB of MUI source, when it's a real dir and not a
# symlink), `.venv/` (10k+ Python files from the hardlinked cache),
# `__pycache__/`, `dist/`, `.git/`, etc; every 2 seconds while the
# agent is active. Result: backend CPU pegged on JSON-serializing
# auto-generated chunks the frontend will then throw away. The frontend
# already filters these for display; this skip is the real fix.
_WALK_SKIP_DIRS = frozenset({
    "node_modules",
    ".vite",
    ".vite-cache",
    ".vite_cache",
    ".git",
    "dist",
    ".next",
    "__pycache__",
    ".venv",
    "venv",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
})

# Cap per-file response size at 256 KB. Hand-written source rarely
# exceeds this; auto-generated bundles routinely run into the MBs and
# they're not what the user/agent is editing. Anything over the cap
# returns a truncated stub the frontend treats as "open the file
# directly to see full contents."
_WALK_MAX_FILE_BYTES = 256 * 1024


def _walk_directory(folder: str) -> dict[str, str]:
    """Walk a directory tree and return {relative_path: content} for all
    text files the user is actually authoring. Skips build/install
    directories AND truncates oversize files; both critical for the
    polling endpoint, which is called every 2 s while the agent is
    writing code and would otherwise serialize hundreds of MB per poll."""
    files: dict[str, str] = {}
    if not os.path.isdir(folder):
        return files
    for root, dirs, filenames in os.walk(folder):
        # Mutate `dirs` in place; that's how os.walk skips a subtree.
        # Doing it here means we never even stat the children, so a
        # 10k-file `.venv/` costs ~one stat (on the dir itself) instead
        # of 10k.
        dirs[:] = [d for d in dirs if d not in _WALK_SKIP_DIRS]
        for fname in filenames:
            full_path = os.path.join(root, fname)
            # Normalize to forward-slash keys so the frontend's
            # `path.split('/')` and `.startsWith(prefix)` checks work
            # the same on Windows (where os.sep is '\\') as on macOS.
            # Without this, every workspace file came back as
            # `backend\\app.py` on Windows and the file tree silently
            # mis-parsed.
            rel_path = os.path.relpath(full_path, folder).replace(os.sep, "/")
            try:
                # Stat first; cheap, lets us skip giant files without
                # opening + reading them.
                size = os.path.getsize(full_path)
                if size > _WALK_MAX_FILE_BYTES:
                    files[rel_path] = (
                        f"// [openswarm] file truncated ({size} bytes > "
                        f"{_WALK_MAX_FILE_BYTES} byte cap). Open directly "
                        f"to view full contents."
                    )
                    continue
                with open(full_path) as f:
                    files[rel_path] = f.read()
            except Exception:
                pass
    return files
