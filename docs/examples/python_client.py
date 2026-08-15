#!/usr/bin/env python3
"""
Minimal MeMesh HTTP client reference — copy-paste starting point for Python integrators.

NOT a maintained package. Covers recall/remember/forget/health against the documented
{success, data} / {success: false, errorCode, error} envelope. Loopback-only by default
(memesh serve on 127.0.0.1); set bearer_token for remote instances.

Requires: requests (pip install requests)
API Reference: https://github.com/PCIRCLE-AI/memesh/blob/main/docs/api/API_REFERENCE.md
"""

import requests
from typing import Optional, List, Dict, Any


class MemeshClient:
    """Thin HTTP wrapper for MeMesh API. Adapt as needed for your use case."""

    def __init__(self, base_url: str = "http://127.0.0.1:3737", bearer_token: Optional[str] = None):
        self.base_url = base_url.rstrip('/')
        self.headers = {'Content-Type': 'application/json'}
        if bearer_token:  # Remote instances require Authorization header
            self.headers['Authorization'] = f'Bearer {bearer_token}'

    def _post(self, endpoint: str, body: Dict[str, Any]) -> Dict[str, Any]:
        """POST helper with envelope unwrapping."""
        r = requests.post(f'{self.base_url}{endpoint}', json=body, headers=self.headers)
        r.raise_for_status()
        result = r.json()
        if not result.get('success'):
            raise ValueError(f"API error: {result.get('errorCode')} - {result.get('error')}")
        return result['data']

    def recall(self, query: str = "", limit: int = 10) -> Dict[str, Any]:
        """Recall memories by query. Returns {entities: [...], conflicts: [...]}."""
        return self._post('/v1/recall', {'query': query, 'limit': limit})

    def remember(self, name: str, type: str, observations: List[str],
                 title: Optional[str] = None, tags: Optional[List[str]] = None) -> Dict[str, Any]:
        """Store a memory. Returns {stored: bool, name: str}."""
        body = {'name': name, 'type': type, 'observations': observations}
        if title: body['title'] = title
        if tags: body['tags'] = tags
        return self._post('/v1/remember', body)

    def forget(self, name: str) -> Dict[str, Any]:
        """Archive a memory. Returns {archived: bool}."""
        return self._post('/v1/forget', {'name': name})

    def health(self) -> Dict[str, Any]:
        """Check server status. Returns {status: 'ok', version: str, entity_count: int}."""
        r = requests.get(f'{self.base_url}/v1/health', headers=self.headers)
        r.raise_for_status()
        return r.json()['data']


# Example usage (loopback, no auth)
if __name__ == '__main__':
    client = MemeshClient()

    # Store a memory
    client.remember(
        name='python-example',
        type='fact',
        observations=['MeMesh HTTP API works from Python'],
        title='Python Integration Test'
    )

    # Recall it back
    result = client.recall(query='Python')
    print(f"Found {len(result['entities'])} memories")

    # Health check
    health = client.health()
    print(f"MeMesh {health['version']} | {health['entity_count']} entities")
