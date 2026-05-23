import json
import logging
import os
import re

from backend.config.paths import SESSIONS_DIR

logger = logging.getLogger(__name__)


def _get_branch_messages(session) -> list:
    """Return the linear message list for the active branch, walking the branch tree."""
    branch_id = session.active_branch_id or "main"
    branch = session.branches.get(branch_id)

    if not branch or not branch.fork_point_message_id:
        return [m for m in session.messages if m.branch_id == "main" or m.branch_id == branch_id]

    segments = []
    cur = branch
    cur_id = branch_id
    visited = set()
    while cur and cur.fork_point_message_id:
        if cur_id in visited:
            break
        visited.add(cur_id)
        segments.insert(0, {"branch_id": cur_id, "up_to": cur.fork_point_message_id})
        cur_id = cur.parent_branch_id or "main"
        cur = session.branches.get(cur_id)
    segments.insert(0, {"branch_id": cur_id, "up_to": None})

    result = []
    for i, seg in enumerate(segments):
        fork_msg_id = seg["up_to"]
        if fork_msg_id:
            fork_idx = next((j for j, m in enumerate(session.messages) if m.id == fork_msg_id), len(session.messages))
            result.extend(m for m in session.messages[:fork_idx] if m.branch_id == seg["branch_id"])
        else:
            next_fork = segments[i + 1]["up_to"] if i + 1 < len(segments) else None
            if next_fork:
                fork_idx = next((j for j, m in enumerate(session.messages) if m.id == next_fork), len(session.messages))
                result.extend(m for m in session.messages[:fork_idx] if m.branch_id == seg["branch_id"])
            else:
                result.extend(m for m in session.messages if m.branch_id == seg["branch_id"])

    if not any(m.branch_id == branch_id for m in result):
        result.extend(m for m in session.messages if m.branch_id == branch_id)
    return result


def _build_history_prefix(messages) -> str:
    """Format branch messages into a conversation summary for context injection."""
    lines = []
    for m in messages:
        if m.role not in ("user", "assistant") or getattr(m, "hidden", False):
            continue
        text = m.content if isinstance(m.content, str) else str(m.content)
        label = "User" if m.role == "user" else "Assistant"
        lines.append(f"{label}: {text}")
    if not lines:
        return ""
    return "<prior_conversation>\n" + "\n".join(lines) + "\n</prior_conversation>"


def _summarize_message_block(messages: list) -> str:
    """Programmatic, no-LLM summary of a message slice. Mirrors the
    shape of browser_agent._summarize_messages: extracts the original
    user task, counts tool calls, captures the last assistant text.
    Cheap, deterministic, and never makes a network call, so
    compaction itself adds zero latency to the user's turn.
    """
    if not messages:
        return ""

    initial_task = ""
    for m in messages:
        if getattr(m, "role", "") == "user":
            content = getattr(m, "content", "")
            txt = content if isinstance(content, str) else str(content)
            if txt.strip():
                initial_task = txt.strip()[:400]
                break

    tool_calls_by_name: dict[str, int] = {}
    last_tool_results = 0
    last_assistant_text = ""
    for m in messages:
        role = getattr(m, "role", "")
        if role == "tool_call":
            content = getattr(m, "content", {}) or {}
            name = (content.get("tool") if isinstance(content, dict) else None) or "unknown"
            tool_calls_by_name[name] = tool_calls_by_name.get(name, 0) + 1
        elif role == "tool_result":
            last_tool_results += 1
        elif role == "assistant":
            content = getattr(m, "content", "")
            if isinstance(content, str) and content.strip():
                last_assistant_text = content.strip()
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        txt = (block.get("text") or "").strip()
                        if txt:
                            last_assistant_text = txt

    parts = ["<compacted_history>"]
    parts.append("[The following is a programmatic summary of earlier turns in this session. Originals are preserved on disk and viewable via the chat UI's compaction drawer.]")
    if initial_task:
        parts.append(f'Initial user request: "{initial_task}"')
    if tool_calls_by_name:
        total = sum(tool_calls_by_name.values())
        top = sorted(tool_calls_by_name.items(), key=lambda kv: -kv[1])[:8]
        parts.append(f"Tool calls so far ({total} total): " + ", ".join(f"{n}×{c}" for n, c in top))
    if last_tool_results:
        parts.append(f"Tool results received: {last_tool_results}")
    if last_assistant_text:
        parts.append("Last assistant message:")
        parts.append(last_assistant_text[:1200])
    parts.append("</compacted_history>")
    return "\n".join(parts)


def _truncate_large_tool_result(content: object, session_id: str, msg_id: str, max_bytes: int = 50_000) -> tuple[object, str | None]:
    """Spill a large tool_result body to disk, return a truncated
    inline replacement plus the on-disk path (or None if untouched).

    Storage is session-scoped under data/sessions/<session_id>/blobs/,
    never honors caller-supplied paths (defense against path
    traversal). The inline replacement keeps the first 4KB so the
    model retains some signal about what was returned.
    """
    if not isinstance(content, str):
        try:
            serialized = json.dumps(content) if not isinstance(content, str) else content
        except Exception:
            serialized = str(content)
    else:
        serialized = content
    if len(serialized.encode("utf-8")) <= max_bytes:
        return content, None
    blobs_dir = os.path.join(SESSIONS_DIR, session_id, "blobs")
    os.makedirs(blobs_dir, exist_ok=True)
    # Sanitize msg_id (it's UUID hex, but be defensive).
    safe_msg_id = re.sub(r"[^a-zA-Z0-9_-]", "", str(msg_id))[:64] or "blob"
    blob_path = os.path.join(blobs_dir, f"{safe_msg_id}.txt")
    try:
        with open(blob_path, "w", encoding="utf-8") as f:
            f.write(serialized)
    except Exception as e:
        logger.warning(f"Failed to spill tool result to {blob_path}: {e}")
        return content, None
    head = serialized[:4_000]
    replacement = (
        f"{head}\n\n"
        f"[truncated, full output ({len(serialized)} chars) saved to {blob_path}. "
        f"Ask the user or run a follow-up tool call if you need the rest.]"
    )
    return replacement, blob_path
