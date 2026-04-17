"""MeMesh Python SDK — connect to MeMesh HTTP API."""

from __future__ import annotations

import json
import subprocess
from typing import Optional

import httpx

from .types import ConsolidateResult, Entity, ForgetResult, RememberResult


class MeMesh:
    """Client for MeMesh memory layer.

    Usage:
        m = MeMesh()  # connects to localhost:3737
        m.remember("auth-decision", "decision", observations=["Use OAuth"])
        results = m.recall("auth")
        m.forget("old-design")
    """

    def __init__(self, host: str = "127.0.0.1", port: int = 3737, timeout: float = 30.0):
        self.base_url = f"http://{host}:{port}"
        self.timeout = timeout
        self._client = httpx.Client(base_url=self.base_url, timeout=timeout)

    def _request(self, method: str, path: str, json_data: Optional[dict] = None) -> dict:
        """Make HTTP request, fall back to CLI if server unavailable."""
        try:
            if method == "GET":
                resp = self._client.get(path)
            else:
                resp = self._client.post(path, json=json_data or {})
            resp.raise_for_status()
            data = resp.json()
            if not data.get("success"):
                raise Exception(data.get("error", "Unknown error"))
            return data["data"]
        except httpx.ConnectError:
            # Fall back to CLI subprocess
            return self._cli_fallback(method, path, json_data)

    def _cli_fallback(self, method: str, path: str, json_data: Optional[dict]) -> dict:
        """Use memesh CLI as fallback when HTTP server is unavailable."""
        if path == "/v1/remember" and json_data:
            args = ["memesh", "remember", "--name", json_data["name"], "--type", json_data["type"], "--json"]
            if json_data.get("observations"):
                args.extend(["--obs"] + json_data["observations"])
            if json_data.get("tags"):
                args.extend(["--tags"] + json_data["tags"])
        elif path == "/v1/recall":
            args = ["memesh", "recall", "--json"]
            if json_data and json_data.get("query"):
                args.insert(2, json_data["query"])
            if json_data and json_data.get("tag"):
                args.extend(["--tag", json_data["tag"]])
        elif path == "/v1/forget" and json_data:
            args = ["memesh", "forget", "--name", json_data["name"], "--json"]
            if json_data.get("observation"):
                args.extend(["--observation", json_data["observation"]])
        elif path == "/v1/health":
            args = ["memesh", "status"]
        else:
            raise Exception(f"CLI fallback not available for {method} {path}")

        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=30)
            if result.returncode != 0:
                raise Exception(f"CLI error: {result.stderr}")
            return json.loads(result.stdout)
        except FileNotFoundError:
            raise Exception("MeMesh CLI not found. Install: npm install -g @pcircle/memesh")
        except json.JSONDecodeError:
            # CLI output might not be JSON (human-readable format)
            return {"raw": result.stdout}

    def health(self) -> dict:
        """Check server health."""
        return self._request("GET", "/v1/health")

    def remember(
        self,
        name: str,
        type: str,
        observations: Optional[list[str]] = None,
        tags: Optional[list[str]] = None,
        relations: Optional[list[dict]] = None,
    ) -> RememberResult:
        """Store knowledge."""
        body: dict = {"name": name, "type": type}
        if observations:
            body["observations"] = observations
        if tags:
            body["tags"] = tags
        if relations:
            body["relations"] = relations
        data = self._request("POST", "/v1/remember", body)
        return RememberResult(**{k: data[k] for k in RememberResult.__dataclass_fields__ if k in data})

    def recall(
        self,
        query: Optional[str] = None,
        tag: Optional[str] = None,
        limit: int = 20,
        include_archived: bool = False,
    ) -> list[Entity]:
        """Search knowledge."""
        body: dict = {}
        if query:
            body["query"] = query
        if tag:
            body["tag"] = tag
        if limit != 20:
            body["limit"] = limit
        if include_archived:
            body["include_archived"] = True
        data = self._request("POST", "/v1/recall", body)
        entities = data if isinstance(data, list) else data.get("entities", data)
        if not isinstance(entities, list):
            return []
        return [Entity(**{k: e[k] for k in Entity.__dataclass_fields__ if k in e}) for e in entities]

    def forget(
        self,
        name: str,
        observation: Optional[str] = None,
    ) -> ForgetResult:
        """Archive entity or remove observation."""
        body: dict = {"name": name}
        if observation:
            body["observation"] = observation
        data = self._request("POST", "/v1/forget", body)
        return ForgetResult(**{k: data[k] for k in ForgetResult.__dataclass_fields__ if k in data})

    def consolidate(
        self,
        name: Optional[str] = None,
        tag: Optional[str] = None,
        min_observations: int = 5,
    ) -> ConsolidateResult:
        """Compress entity observations via LLM."""
        body: dict = {}
        if name:
            body["name"] = name
        if tag:
            body["tag"] = tag
        if min_observations != 5:
            body["min_observations"] = min_observations
        data = self._request("POST", "/v1/consolidate", body)
        return ConsolidateResult(**{k: data[k] for k in ConsolidateResult.__dataclass_fields__ if k in data})

    def list_entities(self, limit: int = 20, include_archived: bool = False) -> list[Entity]:
        """List recent entities."""
        params = f"?limit={limit}"
        if include_archived:
            params += "&status=all"
        data = self._request("GET", f"/v1/entities{params}")
        if not isinstance(data, list):
            return []
        return [Entity(**{k: e[k] for k in Entity.__dataclass_fields__ if k in e}) for e in data]

    def get_entity(self, name: str) -> Optional[Entity]:
        """Get a single entity by name."""
        try:
            data = self._request("GET", f"/v1/entities/{name}")
            return Entity(**{k: data[k] for k in Entity.__dataclass_fields__ if k in data})
        except Exception:
            return None

    def close(self):
        """Close the HTTP client."""
        self._client.close()

    def __enter__(self) -> "MeMesh":
        return self

    def __exit__(self, *args) -> None:
        self.close()
