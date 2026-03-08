"""
Path Resolver — Database path discovery for MeMesh Streamlit UI.

Mirrors the TypeScript PathResolver logic but read-only:
does NOT create directories (that's the main app's job).
"""

import os
from dataclasses import dataclass

DB_FILENAME = "knowledge-graph.db"
NEW_DIR_NAME = ".memesh"
LEGACY_DIR_NAME = ".claude-code-buddy"


@dataclass(frozen=True)
class ResolvedPath:
    """Result of database path resolution."""
    db_path: str
    is_legacy: bool


def resolve_db_path() -> ResolvedPath | None:
    """
    Resolve the MeMesh database path.

    Priority:
    1. ~/.memesh/knowledge-graph.db — if exists
    2. ~/.claude-code-buddy/knowledge-graph.db — if exists (legacy, migration needed)
    3. None — database not found

    Returns:
        ResolvedPath with db_path and is_legacy flag, or None if not found.
    """
    home = os.path.expanduser("~")

    # Case 1: New directory
    new_path = os.path.join(home, NEW_DIR_NAME, DB_FILENAME)
    if os.path.isfile(new_path):
        return ResolvedPath(db_path=new_path, is_legacy=False)

    # Case 2: Legacy directory
    legacy_path = os.path.join(home, LEGACY_DIR_NAME, DB_FILENAME)
    if os.path.isfile(legacy_path):
        return ResolvedPath(db_path=legacy_path, is_legacy=True)

    # Case 3: Not found
    return None
