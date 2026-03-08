import sqlite3
import pandas as pd
import streamlit as st
from typing import Optional
from datetime import date

# --- Connection ---


@st.cache_resource
def get_connection(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def is_fts5_available(conn: sqlite3.Connection) -> bool:
    """Check if FTS5 table exists. Cheap query, safe to call per-request."""
    try:
        conn.execute("SELECT * FROM entities_fts LIMIT 0")
        return True
    except sqlite3.OperationalError:
        return False


# --- LIKE Fallback Helper ---


def _like_condition(query: str) -> tuple[str, list[str]]:
    """Return (sql_fragment, params_list) for a LIKE-based text search fallback.

    Escapes '%' and '_' wildcards in the user query.
    """
    escaped = query.strip().replace('%', '\\%').replace('_', '\\_')
    like_param = f"%{escaped}%"
    sql = """
        (e.name LIKE ? ESCAPE '\\' OR EXISTS (
            SELECT 1 FROM observations WHERE entity_id = e.id AND content LIKE ? ESCAPE '\\'
        ))
    """
    return sql, [like_param, like_param]


# --- FTS5 Safety ---


def escape_fts5_query(user_input: str) -> str:
    """Escape FTS5 special characters for safe MATCH queries."""
    # Remove characters that are special in FTS5 query syntax
    special_chars = set('*+-"()^{}[]|\\:')
    escaped = ''.join(c for c in user_input if c not in special_chars)
    escaped = escaped.strip()
    if not escaped:
        return '""'  # empty query after escaping
    # Wrap each word in double quotes to treat as literal
    words = escaped.split()
    return ' '.join(f'"{w}"' for w in words if w)


# --- Count Operations ---


def get_entity_count(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM entities").fetchone()[0]


def get_relation_count(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM relations").fetchone()[0]


def get_observation_count(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM observations").fetchone()[0]


def get_tag_count(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM tags").fetchone()[0]


# --- Dashboard Operations ---


def get_entity_type_distribution(conn: sqlite3.Connection) -> pd.DataFrame:
    return pd.read_sql_query(
        "SELECT type, COUNT(*) as count FROM entities GROUP BY type ORDER BY count DESC",
        conn
    )


def get_top_tags(conn: sqlite3.Connection, limit: int = 15, exclude_prefix: str = "scope:") -> pd.DataFrame:
    return pd.read_sql_query(
        "SELECT tag, COUNT(*) as count FROM tags WHERE tag NOT LIKE ? GROUP BY tag ORDER BY count DESC LIMIT ?",
        conn,
        params=(f"{exclude_prefix}%", limit)
    )


_GRANULARITY_EXPRS = {
    "day": "DATE(created_at)",
    "week": "strftime('%Y-%W', created_at)",
    "month": "strftime('%Y-%m', created_at)",
}


def get_entity_growth(conn: sqlite3.Connection, granularity: str = "day") -> pd.DataFrame:
    """Get cumulative entity count over time.

    Args:
        conn: Database connection
        granularity: 'day', 'week', or 'month'
    """
    date_expr = _GRANULARITY_EXPRS.get(granularity)
    if date_expr is None:
        raise ValueError(f"Invalid granularity: {granularity!r}. Must be one of: {list(_GRANULARITY_EXPRS)}")

    query = f"""
        SELECT period, SUM(cnt) OVER (ORDER BY period) as cumulative_count
        FROM (
            SELECT {date_expr} as period, COUNT(*) as cnt
            FROM entities
            GROUP BY period
        )
        ORDER BY period
    """
    return pd.read_sql_query(query, conn)


def get_recent_entities(conn: sqlite3.Connection, limit: int = 20) -> pd.DataFrame:
    return pd.read_sql_query("""
        SELECT
            e.id, e.name, e.type, e.created_at,
            COUNT(DISTINCT t.id) as tag_count,
            COUNT(DISTINCT o.id) as observation_count
        FROM entities e
        LEFT JOIN tags t ON t.entity_id = e.id
        LEFT JOIN observations o ON o.entity_id = e.id
        GROUP BY e.id
        ORDER BY e.created_at DESC
        LIMIT ?
    """, conn, params=(limit,))


# --- Explorer Search ---


def search_entities(
    conn: sqlite3.Connection,
    query: str = "",
    types: Optional[list[str]] = None,
    tags: Optional[list[str]] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    limit: int = 100,
) -> pd.DataFrame:
    """Search entities with filters. Uses FTS5 MATCH with LIKE fallback."""
    conditions = []
    params = []

    # Text search
    if query.strip():
        if is_fts5_available(conn):
            safe_query = escape_fts5_query(query)
            if safe_query and safe_query != '""':
                conditions.append("""
                    e.id IN (
                        SELECT rowid FROM entities_fts WHERE entities_fts MATCH ?
                    )
                """)
                params.append(safe_query)
            else:
                # Fallback for empty escaped query
                like_sql, like_params = _like_condition(query)
                conditions.append(like_sql)
                params.extend(like_params)
        else:
            # FTS5 not available
            like_sql, like_params = _like_condition(query)
            conditions.append(like_sql)
            params.extend(like_params)

    # Type filter
    if types:
        placeholders = ",".join("?" * len(types))
        conditions.append(f"e.type IN ({placeholders})")
        params.extend(types)

    # Tag filter
    if tags:
        placeholders = ",".join("?" * len(tags))
        conditions.append(f"""
            e.id IN (SELECT entity_id FROM tags WHERE tag IN ({placeholders}))
        """)
        params.extend(tags)

    # Date range
    if date_from:
        conditions.append("DATE(e.created_at) >= ?")
        params.append(date_from.isoformat())
    if date_to:
        conditions.append("DATE(e.created_at) <= ?")
        params.append(date_to.isoformat())

    where_clause = " AND ".join(conditions) if conditions else "1=1"

    return pd.read_sql_query(f"""
        SELECT
            e.id, e.name, e.type, e.created_at,
            COUNT(DISTINCT t.id) as tag_count,
            COUNT(DISTINCT o.id) as observation_count
        FROM entities e
        LEFT JOIN tags t ON t.entity_id = e.id
        LEFT JOIN observations o ON o.entity_id = e.id
        WHERE {where_clause}
        GROUP BY e.id
        ORDER BY e.created_at DESC
        LIMIT ?
    """, conn, params=(*params, limit))


# --- Entity Detail ---


def get_entity_detail(conn: sqlite3.Connection, entity_id: int) -> Optional[dict]:
    """Get full entity detail including observations, tags, and relations."""
    with conn:
        entity = conn.execute(
            "SELECT id, name, type, created_at, metadata FROM entities WHERE id = ?",
            (entity_id,)
        ).fetchone()

        if not entity:
            return None

        observations = conn.execute(
            "SELECT id, content, created_at FROM observations WHERE entity_id = ? ORDER BY created_at DESC",
            (entity_id,)
        ).fetchall()

        tags_rows = conn.execute(
            "SELECT id, tag FROM tags WHERE entity_id = ?",
            (entity_id,)
        ).fetchall()

        outgoing = conn.execute("""
            SELECT r.id, r.relation_type, e.id as target_id, e.name as target_name
            FROM relations r
            JOIN entities e ON e.id = r.to_entity_id
            WHERE r.from_entity_id = ?
        """, (entity_id,)).fetchall()

        incoming = conn.execute("""
            SELECT r.id, r.relation_type, e.id as source_id, e.name as source_name
            FROM relations r
            JOIN entities e ON e.id = r.from_entity_id
            WHERE r.to_entity_id = ?
        """, (entity_id,)).fetchall()

    return {
        "entity": dict(entity),
        "observations": [dict(o) for o in observations],
        "tags": [dict(t) for t in tags_rows],
        "outgoing_relations": [dict(r) for r in outgoing],
        "incoming_relations": [dict(r) for r in incoming],
    }


# --- Graph Data ---


def get_graph_data(conn: sqlite3.Connection, entity_ids: list[int]) -> dict:
    """Get nodes and edges for pyvis graph visualization."""
    if not entity_ids:
        return {"nodes": [], "edges": []}

    placeholders = ",".join("?" * len(entity_ids))

    nodes = conn.execute(f"""
        SELECT e.id, e.name, e.type, COUNT(o.id) as obs_count
        FROM entities e
        LEFT JOIN observations o ON o.entity_id = e.id
        WHERE e.id IN ({placeholders})
        GROUP BY e.id
    """, entity_ids).fetchall()

    edges = conn.execute(f"""
        SELECT r.from_entity_id, r.to_entity_id, r.relation_type
        FROM relations r
        WHERE r.from_entity_id IN ({placeholders})
          AND r.to_entity_id IN ({placeholders})
    """, (*entity_ids, *entity_ids)).fetchall()

    return {
        "nodes": [dict(n) for n in nodes],
        "edges": [dict(e) for e in edges],
    }


# --- Write Operations ---


def delete_entity(conn: sqlite3.Connection, entity_id: int) -> bool:
    """Delete entity with FTS5 cleanup. Returns True if deleted."""
    with conn:
        row = conn.execute("SELECT name FROM entities WHERE id = ?", (entity_id,)).fetchone()
        if not row:
            return False
        # Clean FTS5 index (contentless table requires manual delete)
        if is_fts5_available(conn):
            try:
                conn.execute(
                    "INSERT INTO entities_fts(entities_fts, rowid, name, observations) VALUES('delete', ?, ?, '')",
                    (entity_id, row[0])
                )
            except sqlite3.OperationalError:
                pass  # FTS5 entry may not exist
        # CASCADE handles observations, tags, relations
        conn.execute("DELETE FROM entities WHERE id = ?", (entity_id,))
    return True


def update_observation(conn: sqlite3.Connection, obs_id: int, content: str) -> bool:
    """Update observation content. Validates input."""
    content = content.strip()
    if not content or len(content) > 65536:
        return False
    with conn:
        cursor = conn.execute("UPDATE observations SET content = ? WHERE id = ?", (content, obs_id))
        return cursor.rowcount > 0


def delete_observation(conn: sqlite3.Connection, obs_id: int) -> bool:
    """Delete an observation."""
    with conn:
        cursor = conn.execute("DELETE FROM observations WHERE id = ?", (obs_id,))
        return cursor.rowcount > 0


def add_tag(conn: sqlite3.Connection, entity_id: int, tag: str) -> bool:
    """Add a tag to an entity. Validates input."""
    tag = tag.strip()
    if not tag or len(tag) > 256 or any(c < ' ' for c in tag):
        return False
    with conn:
        cursor = conn.execute("INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)", (entity_id, tag))
    return cursor.rowcount > 0


def remove_tag(conn: sqlite3.Connection, tag_id: int) -> bool:
    """Remove a tag by ID."""
    with conn:
        cursor = conn.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
        return cursor.rowcount > 0


# --- Utility ---


def get_all_types(conn: sqlite3.Connection) -> list[str]:
    """Get all distinct entity types for filter dropdowns."""
    rows = conn.execute("SELECT DISTINCT type FROM entities ORDER BY type").fetchall()
    return [r[0] for r in rows]


def get_all_tags_with_counts(conn: sqlite3.Connection, limit: int = 30) -> list[tuple[str, int]]:
    """Get tags with counts for filter dropdown. Format: [('tag_name', count), ...]"""
    rows = conn.execute(
        "SELECT tag, COUNT(*) as cnt FROM tags GROUP BY tag ORDER BY cnt DESC LIMIT ?",
        (limit,)
    ).fetchall()
    return [(r[0], r[1]) for r in rows]
