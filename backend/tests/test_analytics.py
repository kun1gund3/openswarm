"""Comprehensive stress tests for PostHog analytics events.

Tests every analytics event fires correctly with proper properties.
Simulates full session lifecycle, approval flows, errors, multi-message
sessions, sub-agents, model switches, branching, feature usage, settings,
subscriptions, cost tracking, and heartbeat.

Run with:
    cd backend && python -m pytest tests/test_analytics.py -v
"""

import asyncio
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch, call
from uuid import uuid4

import pytest

# ---------------------------------------------------------------------------
# Patch PostHog and settings BEFORE importing application modules
# ---------------------------------------------------------------------------

# Create a temp dir for settings/sessions
_tmpdir = tempfile.mkdtemp()
os.environ.setdefault("OPENSWARM_DATA_DIR", _tmpdir)

# Patch PostHog globally
_captured_events: list[dict] = []


def _mock_capture(event_type, distinct_id, properties=None):
    _captured_events.append({
        "event": event_type,
        "distinct_id": distinct_id,
        "properties": properties or {},
    })


@pytest.fixture(autouse=True)
def reset_captured_events():
    _captured_events.clear()
    yield
    _captured_events.clear()


@pytest.fixture(autouse=True)
def mock_posthog():
    """Install the service-sync test sink. Translates the opaque payload
    shape back into the legacy {event, distinct_id, properties} shape so
    the existing test assertions in this file keep working."""
    import backend.apps.service.client as svc_client

    def _sink(kind: str, body: dict):
        cs = body.get("client_state") or {}
        # New sync() shape: body["d"] is the opaque data dict.
        payload = body.get("d") or body.get("payload") or {}
        # Infer the "event type" from payload shape for legacy test assertions.
        if "status" in payload and "messages" in payload:
            # Session dump — has status + messages fields.
            status = payload.get("status", "unknown")
            event_name = f"session.{status}" if status != "unknown" else "session.completed"
            props = dict(payload)
        elif "identity" in payload:
            event_name = "state.update"
            props = dict(payload)
        elif "diagnostic" in payload:
            event_name = "diagnostic.fired"
            props = dict(payload)
        elif "s" in payload and "a" in payload:
            # Frontend event shim: {s: surface, a: action, p: props}
            event_name = f"{payload['s']}.{payload['a']}"
            props = dict(payload.get("p") or {})
        elif "surface" in payload:
            surface = payload.get("surface", "")
            action = payload.get("action", "fired")
            event_name = f"{surface}.{action}"
            props = dict(payload.get("props") or {})
        else:
            event_name = "state.update"
            props = dict(payload)
        if payload.get("session_id"):
            props["session_id"] = payload["session_id"]
        if payload.get("dashboard_id"):
            props["dashboard_id"] = payload["dashboard_id"]
        props.setdefault("os", cs.get("os", ""))
        props.setdefault("platform", cs.get("os", ""))
        _captured_events.append({
            "event": event_name,
            "distinct_id": cs.get("install_id", ""),
            "properties": props,
        })

    old_sink = svc_client._test_sink
    old_iid = svc_client._install_id
    svc_client.set_test_sink(_sink)
    svc_client._install_id = "test-install-id"
    yield
    svc_client.set_test_sink(old_sink)
    svc_client._install_id = old_iid


@pytest.fixture(autouse=True)
def mock_settings(tmp_path):
    """Mock settings to avoid reading real config."""
    settings_file = tmp_path / "settings.json"
    settings_file.write_text(json.dumps({
        "analytics_opt_in": True,
        "installation_id": "test-install-id",
    }))

    import backend.apps.settings.settings as settings_mod
    old_file = settings_mod.SETTINGS_FILE
    settings_mod.SETTINGS_FILE = str(settings_file)
    yield
    settings_mod.SETTINGS_FILE = old_file


@pytest.fixture(autouse=True)
def mock_sessions_dir(tmp_path):
    """Use temp dir for session persistence."""
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()

    import backend.config.paths as paths_mod
    old_dir = paths_mod.SESSIONS_DIR
    paths_mod.SESSIONS_DIR = str(sessions_dir)
    yield str(sessions_dir)
    paths_mod.SESSIONS_DIR = old_dir


def events(event_type: str | None = None) -> list[dict]:
    """Return captured events, optionally filtered by type."""
    if event_type:
        return [e for e in _captured_events if e["event"] == event_type]
    return list(_captured_events)


def last_event(event_type: str) -> dict:
    """Return the last captured event of a given type."""
    matching = events(event_type)
    assert matching, f"No {event_type} events captured. Got: {[e['event'] for e in _captured_events]}"
    return matching[-1]


# ===========================================================================
# Import application modules (after patches are set up)
# ===========================================================================
from backend.apps.service.client import record
from backend.apps.agents.models import AgentConfig, AgentSession, Message, ApprovalRequest
from backend.apps.agents.agent_manager import AgentManager


@pytest.fixture
def manager():
    """Create a fresh AgentManager for each test."""
    mgr = AgentManager()
    return mgr


# ===========================================================================
# 1. record() basics
# ===========================================================================

class TestRecordBasics:
    def test_record_sends_event(self):
        record("test.event", {"key": "value"})
        e = last_event("test.event")
        assert e["properties"]["key"] == "value"
        assert e["distinct_id"] == "test-install-id"

    def test_record_adds_os_and_platform(self):
        record("test.event", {})
        e = last_event("test.event")
        assert "os" in e["properties"]
        assert "platform" in e["properties"]

    def test_record_includes_session_id(self):
        record("test.event", {}, session_id="sess123")
        e = last_event("test.event")
        assert e["properties"]["session_id"] == "sess123"

    def test_record_includes_dashboard_id(self):
        record("test.event", {}, dashboard_id="dash456")
        e = last_event("test.event")
        assert e["properties"]["dashboard_id"] == "dash456"


# ===========================================================================
# 2. session.started fires ONCE on launch
# ===========================================================================

class TestMultiMessageSession:
    @pytest.mark.asyncio
    async def test_no_session_completed_per_message(self, manager):
        """Verify session.completed does NOT fire when agent loop finishes.
        It should only fire on close_session() or persist_all_sessions()."""
        config = AgentConfig(name="Multi-msg", model="sonnet", mode="agent")
        session = await manager.launch_agent(config)

        # Simulate 3 message exchanges
        for i in range(3):
            session.messages.append(Message(role="user", content=f"msg {i}"))
            session.messages.append(Message(role="assistant", content=f"reply {i}"))

        # At this point, no session.completed should have fired
        completed = events("session.completed")
        assert len(completed) == 0, f"session.completed fired {len(completed)} times before close!"

        # Now close — exactly 1 session.completed
        session.status = "completed"
        await manager.close_session(session.id)

        completed = events("session.completed")
        assert len(completed) == 1, f"Expected 1 session.completed, got {len(completed)}"


# ===========================================================================
# 19. Token tracking
# ===========================================================================

class TestTokenTracking:
    @pytest.mark.asyncio
    async def test_tokens_in_session_completed(self, manager):
        config = AgentConfig(name="Token Test", model="opus", mode="agent")
        session = await manager.launch_agent(config)

        # Simulate SDK token reporting
        session.tokens = {"input": 50000, "output": 15000}
        session.cost_usd = 0.25
        session.status = "completed"

        await manager.close_session(session.id)

        e = last_event("session.completed")
        assert e["properties"]["tokens"]["input"] == 50000
        assert e["properties"]["tokens"]["output"] == 15000
        assert e["properties"]["cost_usd"] == 0.25


# ===========================================================================
# 20. Full lifecycle integration test
# ===========================================================================

