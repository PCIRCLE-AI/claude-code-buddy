"""MeMesh memory plugin — MemoryProvider interface.

Local-first knowledge-graph memory via the MeMesh HTTP API (`memesh serve`,
default http://localhost:3737). Loopback-only, no bearer token needed.

Configuration
-------------
Non-secret (lives in $HERMES_HOME/memesh.json, set via `hermes memory setup`):
  base_url  — MeMesh HTTP server URL (default: http://localhost:3737)

No secrets required for a local loopback deployment.
"""

from __future__ import annotations

import json
import logging
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

_PREFETCH_WAIT_SECS = 3
_SYNC_JOIN_TIMEOUT_SECS = 5.0
_DEFAULT_BASE_URL = "http://localhost:3737"
_RECALL_LIMIT = 5
_OBS_CHAR_CAP = 2000


def _load_config(hermes_home: str) -> dict:
    config_path = Path(hermes_home) / "memesh.json"
    if config_path.exists():
        try:
            return json.loads(config_path.read_text())
        except Exception:
            return {}
    return {}


class MemeshProvider(MemoryProvider):
    """Persistent knowledge-graph memory backed by a local MeMesh server."""

    @property
    def name(self) -> str:
        return "memesh"

    # -- lifecycle ------------------------------------------------------

    def is_available(self) -> bool:
        # No network calls — just check the CLI/HTTP binary is installed.
        # shutil.which() depends on PATH, which systemd user services set
        # explicitly and narrowly — check well-known npm-global locations too
        # so activation doesn't silently fail if PATH wasn't updated.
        if shutil.which("memesh") is not None or shutil.which("memesh-http") is not None:
            return True
        for candidate in (
            Path.home() / ".npm-global" / "bin" / "memesh",
            Path("/usr/local/bin/memesh"),
        ):
            if candidate.exists():
                return True
        return False

    def initialize(self, session_id: str, **kwargs) -> None:
        hermes_home = kwargs.get("hermes_home", "")
        cfg = _load_config(hermes_home)
        self._base_url = cfg.get("base_url", _DEFAULT_BASE_URL)
        self._session_id = session_id
        # cron/subagent/flush contexts should not pollute long-term memory —
        # only the primary interactive agent writes.
        self._agent_context = kwargs.get("agent_context", "primary")
        self._client = httpx.Client(base_url=self._base_url, timeout=5.0)

        self._prefetch_lock = threading.Lock()
        self._prefetch_thread: Optional[threading.Thread] = None
        self._prefetch_query: Optional[str] = None
        self._prefetch_result: Optional[str] = None
        self._sync_thread: Optional[threading.Thread] = None

    def system_prompt_block(self) -> str:
        # Deliberately minimal. Recall/storage already happen automatically
        # via prefetch()/sync_turn() on every turn — this block must not
        # read as an invitation to proactively reorganize memory (built-in
        # MEMORY.md/USER.md included). It exists only so the model knows
        # explicit memesh_* tools are available as a narrow backstop.
        return (
            "MeMesh auto-recalls relevant memory each turn; you don't need "
            "to call memesh_recall yourself for that. Only call "
            "memesh_remember/memesh_recall/memesh_forget for a specific, "
            "narrow lookup or correction the automatic recall missed — not "
            "as a cue to reorganize or rewrite existing memory files."
        )

    def shutdown(self) -> None:
        try:
            self._client.close()
        except Exception:
            pass

    # -- recall / prefetch ------------------------------------------------

    def _do_recall(self, query: str) -> str:
        try:
            resp = self._client.post(
                "/v1/recall", json={"query": query, "limit": _RECALL_LIMIT}
            )
            resp.raise_for_status()
            data = resp.json()
            if not data.get("success"):
                return ""
            # API_REFERENCE.md documents `data` as an object with an
            # `entities` array, but the live HTTP /v1/recall response (memesh
            # 4.5.1) returns `data` as a bare array of entities directly.
            # Handle both shapes defensively — see PCIRCLE-AI/memesh#159.
            payload = data.get("data")
            if isinstance(payload, list):
                entities = payload
            elif isinstance(payload, dict):
                entities = payload.get("entities", [])
            else:
                entities = []
            if not entities:
                return ""
            lines = ["[MeMesh recall]"]
            for e in entities:
                obs = "; ".join(e.get("observations", [])[:3])
                lines.append(f"- ({e.get('type')}) {e.get('name')}: {obs}")
            return "\n".join(lines)
        except Exception as exc:
            logger.warning("MeMesh recall failed: %s", exc)
            return ""

    def _start_prefetch(self, query: str) -> None:
        with self._prefetch_lock:
            if self._prefetch_thread and self._prefetch_thread.is_alive():
                return

        def _run() -> None:
            result = self._do_recall(query)
            with self._prefetch_lock:
                self._prefetch_query = query
                self._prefetch_result = result

        with self._prefetch_lock:
            self._prefetch_thread = threading.Thread(target=_run, daemon=True)
            self._prefetch_thread.start()

    def _consume_prefetch_result(self, query: str) -> Optional[str]:
        with self._prefetch_lock:
            if self._prefetch_query == query and self._prefetch_result is not None:
                result = self._prefetch_result
                self._prefetch_query = None
                self._prefetch_result = None
                return result
        return None

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        self._start_prefetch(query)

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        cached = self._consume_prefetch_result(query)
        if cached is not None:
            return cached
        self._start_prefetch(query)
        with self._prefetch_lock:
            thread = self._prefetch_thread
        if thread:
            thread.join(timeout=_PREFETCH_WAIT_SECS)
        cached = self._consume_prefetch_result(query)
        # Slow/unreachable backend: skip injection rather than block the turn.
        # memesh_recall tool remains the backstop.
        return cached or ""

    # -- sync_turn --------------------------------------------------------

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        if self._agent_context != "primary":
            return

        def _sync() -> None:
            try:
                sid = session_id or self._session_id
                name = f"hermes-turn-{sid}-{int(time.time())}"
                self._client.post(
                    "/v1/remember",
                    json={
                        "name": name,
                        "type": "conversation",
                        "observations": [
                            f"User: {user_content[:_OBS_CHAR_CAP]}",
                            f"Assistant: {assistant_content[:_OBS_CHAR_CAP]}",
                        ],
                        "tags": ["platform:hermes", f"session:{sid}"],
                    },
                )
            except Exception as exc:
                logger.warning("MeMesh sync_turn failed: %s", exc)

        if self._sync_thread and self._sync_thread.is_alive():
            self._sync_thread.join(timeout=_SYNC_JOIN_TIMEOUT_SECS)
        self._sync_thread = threading.Thread(target=_sync, daemon=True)
        self._sync_thread.start()

    # -- compression / session-end archival ----------------------------------
    #
    # sync_turn() already captures each turn as it happens, but two real gaps
    # remain without these hooks: (1) context compression can discard detail
    # sync_turn's terse per-turn summary missed (long tool-heavy turns), and
    # (2) nothing ties a session's turns together into one recallable unit
    # before /reset or gateway session expiry drops it. Both write to a
    # STABLE per-session entity name so repeated calls upsert/append instead
    # of spawning a new entity each time (see the mem-provider docs: reusing
    # `name` appends observations rather than duplicating).

    def _archive_messages(self, entity_name: str, entity_type: str, messages: Optional[List[Dict[str, Any]]], session_id: str, extra_tag: str) -> None:
        # Deliberately SYNCHRONOUS, unlike sync_turn(). Both callers
        # (on_pre_compress, on_session_end) fire once per session/compression
        # boundary, not once per turn, so blocking briefly here doesn't add
        # per-turn latency. It must NOT be a fire-and-forget background
        # thread: on_session_end runs immediately before shutdown() closes
        # self._client, and a detached thread racing that close reliably hit
        # "[Errno 9] Bad file descriptor" in testing — the archive silently
        # never landed. Running synchronously guarantees the write completes
        # (or is honestly logged as failed) before the caller moves on.
        if self._agent_context != "primary" or not messages:
            return
        try:
            lines: List[str] = []
            for m in messages[-40:]:
                role = m.get("role", "?")
                content = m.get("content", "")
                if isinstance(content, list):
                    content = " ".join(
                        part.get("text", "") for part in content if isinstance(part, dict)
                    )
                if not content:
                    continue
                lines.append(f"{role}: {str(content)[:_OBS_CHAR_CAP]}")
            if not lines:
                return
            self._client.post(
                "/v1/remember",
                json={
                    "name": entity_name,
                    "type": entity_type,
                    "observations": lines,
                    "tags": ["platform:hermes", extra_tag, f"session:{session_id}"],
                },
            )
        except Exception as exc:
            logger.warning("MeMesh %s archive failed: %s", entity_type, exc)

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        self._archive_messages(
            f"hermes-compress-{self._session_id}",
            "conversation-checkpoint",
            messages,
            self._session_id,
            "compression",
        )
        # Compression can trust MeMesh to hold the raw tail — tell the
        # compressor it doesn't need to over-preserve detail already archived.
        return (
            "Older context beyond this point is being archived to MeMesh "
            "(recall via memesh_recall if needed later) — the summary here "
            "can stay concise rather than exhaustive."
        )

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        self._archive_messages(
            f"hermes-session-{self._session_id}",
            "conversation-archive",
            messages,
            self._session_id,
            "session-end",
        )

    def on_session_switch(
        self,
        new_session_id: str,
        *,
        parent_session_id: str = "",
        reset: bool = False,
        rewound: bool = False,
        **kwargs,
    ) -> None:
        # self._session_id is cached at initialize() and read by prefetch/
        # sync_turn/archive helpers — without updating it here, a mid-process
        # /reset, /resume, or /branch would keep tagging new memories with
        # the stale pre-switch session_id.
        self._session_id = new_session_id
        if reset:
            with self._prefetch_lock:
                self._prefetch_query = None
                self._prefetch_result = None

    # -- explicit tools -----------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            {
                "name": "memesh_remember",
                "description": "Store a fact, decision, pattern, or lesson in persistent memory.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "Unique entity name"},
                        "type": {
                            "type": "string",
                            "description": "Entity type, e.g. decision, lesson, pattern, fact",
                        },
                        "observations": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Key facts or observations",
                        },
                        "tags": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["name", "type"],
                },
            },
            {
                "name": "memesh_recall",
                "description": "Search persistent memory for relevant past knowledge.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "tag": {"type": "string"},
                    },
                },
            },
            {
                "name": "memesh_forget",
                "description": "Archive or remove a memory entity by name.",
                "parameters": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}},
                    "required": ["name"],
                },
            },
        ]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        try:
            if tool_name == "memesh_remember":
                resp = self._client.post("/v1/remember", json=args)
            elif tool_name == "memesh_recall":
                resp = self._client.post("/v1/recall", json=args)
            elif tool_name == "memesh_forget":
                resp = self._client.post("/v1/forget", json=args)
            else:
                raise NotImplementedError(
                    f"memesh provider does not handle tool {tool_name}"
                )
            resp.raise_for_status()
            return json.dumps(resp.json())
        except Exception as exc:
            return json.dumps({"success": False, "error": str(exc)})

    # -- config ------------------------------------------------------------

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "base_url",
                "description": "MeMesh HTTP server URL",
                "default": _DEFAULT_BASE_URL,
            },
        ]

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        config_path = Path(hermes_home) / "memesh.json"
        config_path.write_text(json.dumps(values, indent=2))


def register(ctx) -> None:
    """Called by the memory plugin discovery system."""
    ctx.register_memory_provider(MemeshProvider())
