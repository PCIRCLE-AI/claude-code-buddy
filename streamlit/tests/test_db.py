"""Tests for streamlit/db.py database utility functions."""

import sqlite3
from datetime import date

import pandas as pd
import pytest

# We need to import db.py without triggering Streamlit decorators.
# Patch st.cache_resource to be a no-op before importing.
import sys
from unittest.mock import MagicMock

# Create a fake streamlit module so db.py can import without Streamlit installed
_fake_st = MagicMock()
_fake_st.cache_resource = lambda f: f  # Make decorator a passthrough
sys.modules.setdefault("streamlit", _fake_st)

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
from db import (
    escape_fts5_query,
    _like_condition,
    get_entity_growth,
    delete_entity,
    search_entities,
    get_entity_count,
    is_fts5_available,
)


# ---------- Schema helpers ----------


def _create_schema(conn: sqlite3.Connection, *, with_fts: bool = False):
    """Create the minimal MeMesh schema for testing."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS entities (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            metadata TEXT
        );
        CREATE TABLE IF NOT EXISTS observations (
            id INTEGER PRIMARY KEY,
            entity_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY,
            entity_id INTEGER NOT NULL,
            tag TEXT NOT NULL,
            FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
            UNIQUE(entity_id, tag)
        );
        CREATE TABLE IF NOT EXISTS relations (
            id INTEGER PRIMARY KEY,
            from_entity_id INTEGER NOT NULL,
            to_entity_id INTEGER NOT NULL,
            relation_type TEXT NOT NULL,
            metadata TEXT,
            FOREIGN KEY (from_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
            FOREIGN KEY (to_entity_id) REFERENCES entities(id) ON DELETE CASCADE
        );
    """)
    if with_fts:
        conn.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts
            USING fts5(name, observations, content='', contentless_delete=0)
        """)


def _make_conn(*, with_fts: bool = False) -> sqlite3.Connection:
    """Return an in-memory SQLite connection with MeMesh schema."""
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    _create_schema(conn, with_fts=with_fts)
    return conn


# ================================================================
# escape_fts5_query
# ================================================================


class TestEscapeFts5Query:
    def test_plain_word(self):
        assert escape_fts5_query("hello") == '"hello"'

    def test_multiple_words(self):
        assert escape_fts5_query("hello world") == '"hello" "world"'

    def test_special_chars_removed(self):
        result = escape_fts5_query('test*+-()"foo')
        # All special chars stripped; remaining chars merge into one word
        assert "*" not in result
        assert "+" not in result
        assert "(" not in result
        assert result == '"testfoo"'

    def test_special_chars_between_words(self):
        result = escape_fts5_query('test * foo')
        # With spaces, words stay separate after stripping
        assert result == '"test" "foo"'

    def test_empty_after_escape(self):
        assert escape_fts5_query("***") == '""'

    def test_whitespace_only(self):
        assert escape_fts5_query("   ") == '""'

    def test_mixed_special_and_words(self):
        result = escape_fts5_query("hello[world]")
        assert result == '"helloworld"'

    def test_colon_stripped(self):
        result = escape_fts5_query("scope:project")
        assert ":" not in result

    def test_caret_stripped(self):
        result = escape_fts5_query("test^2")
        assert "^" not in result


# ================================================================
# _like_condition
# ================================================================


class TestLikeCondition:
    def test_basic_query(self):
        sql, params = _like_condition("foo")
        assert "LIKE" in sql
        assert params == ["%foo%", "%foo%"]

    def test_escapes_percent(self):
        sql, params = _like_condition("100%")
        assert params == ["%100\\%%", "%100\\%%"]

    def test_escapes_underscore(self):
        sql, params = _like_condition("a_b")
        assert params == ["%a\\_b%", "%a\\_b%"]

    def test_strips_whitespace(self):
        sql, params = _like_condition("  hello  ")
        assert params == ["%hello%", "%hello%"]

    def test_sql_has_escape_clause(self):
        sql, _ = _like_condition("x")
        assert "ESCAPE" in sql


# ================================================================
# get_entity_growth
# ================================================================


class TestGetEntityGrowth:
    def test_invalid_granularity_raises(self):
        conn = _make_conn()
        with pytest.raises(ValueError, match="Invalid granularity"):
            get_entity_growth(conn, granularity="hour")

    def test_valid_granularities(self):
        conn = _make_conn()
        # Insert a couple of entities
        conn.execute(
            "INSERT INTO entities (name, type, created_at) VALUES (?, ?, ?)",
            ("e1", "feature", "2026-01-01 10:00:00"),
        )
        conn.execute(
            "INSERT INTO entities (name, type, created_at) VALUES (?, ?, ?)",
            ("e2", "bug_fix", "2026-01-02 12:00:00"),
        )
        conn.commit()

        for g in ("day", "week", "month"):
            df = get_entity_growth(conn, granularity=g)
            assert isinstance(df, pd.DataFrame)
            assert "cumulative_count" in df.columns
            assert len(df) >= 1

    def test_cumulative_count_is_cumulative(self):
        conn = _make_conn()
        conn.execute(
            "INSERT INTO entities (name, type, created_at) VALUES (?, ?, ?)",
            ("e1", "feature", "2026-01-01 10:00:00"),
        )
        conn.execute(
            "INSERT INTO entities (name, type, created_at) VALUES (?, ?, ?)",
            ("e2", "bug_fix", "2026-01-02 12:00:00"),
        )
        conn.execute(
            "INSERT INTO entities (name, type, created_at) VALUES (?, ?, ?)",
            ("e3", "feature", "2026-01-03 08:00:00"),
        )
        conn.commit()

        df = get_entity_growth(conn, granularity="day")
        cumulative = df["cumulative_count"].tolist()
        # Each value should be >= the previous
        for i in range(1, len(cumulative)):
            assert cumulative[i] >= cumulative[i - 1]
        # Last value should equal total count
        assert cumulative[-1] == 3


# ================================================================
# delete_entity
# ================================================================


class TestDeleteEntity:
    def test_delete_existing_entity(self):
        conn = _make_conn()
        conn.execute("INSERT INTO entities (id, name, type) VALUES (1, 'test', 'feature')")
        conn.commit()

        assert delete_entity(conn, 1) is True
        assert conn.execute("SELECT COUNT(*) FROM entities WHERE id = 1").fetchone()[0] == 0

    def test_delete_nonexistent_entity(self):
        conn = _make_conn()
        assert delete_entity(conn, 999) is False

    def test_delete_cascades_observations(self):
        conn = _make_conn()
        conn.execute("INSERT INTO entities (id, name, type) VALUES (1, 'test', 'feature')")
        conn.execute("INSERT INTO observations (entity_id, content) VALUES (1, 'obs1')")
        conn.execute("INSERT INTO observations (entity_id, content) VALUES (1, 'obs2')")
        conn.commit()

        delete_entity(conn, 1)
        assert conn.execute("SELECT COUNT(*) FROM observations WHERE entity_id = 1").fetchone()[0] == 0

    def test_delete_cascades_tags(self):
        conn = _make_conn()
        conn.execute("INSERT INTO entities (id, name, type) VALUES (1, 'test', 'feature')")
        conn.execute("INSERT INTO tags (entity_id, tag) VALUES (1, 'foo')")
        conn.commit()

        delete_entity(conn, 1)
        assert conn.execute("SELECT COUNT(*) FROM tags WHERE entity_id = 1").fetchone()[0] == 0

    def test_delete_cascades_relations(self):
        conn = _make_conn()
        conn.execute("INSERT INTO entities (id, name, type) VALUES (1, 'a', 'feature')")
        conn.execute("INSERT INTO entities (id, name, type) VALUES (2, 'b', 'feature')")
        conn.execute(
            "INSERT INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (1, 2, 'depends_on')"
        )
        conn.commit()

        delete_entity(conn, 1)
        assert conn.execute("SELECT COUNT(*) FROM relations").fetchone()[0] == 0

    def test_delete_with_fts5(self):
        conn = _make_conn(with_fts=True)
        conn.execute("INSERT INTO entities (id, name, type) VALUES (1, 'test', 'feature')")
        # Insert into FTS index
        conn.execute(
            "INSERT INTO entities_fts (rowid, name, observations) VALUES (1, 'test', 'some obs')"
        )
        conn.commit()

        result = delete_entity(conn, 1)
        assert result is True
        assert conn.execute("SELECT COUNT(*) FROM entities").fetchone()[0] == 0


# ================================================================
# search_entities
# ================================================================


class TestSearchEntities:
    def _seed(self, conn):
        """Insert test entities."""
        conn.executemany(
            "INSERT INTO entities (id, name, type, created_at) VALUES (?, ?, ?, ?)",
            [
                (1, "MeMesh Plugin", "feature", "2026-01-01 10:00:00"),
                (2, "NBA Stats API", "architecture", "2026-01-02 12:00:00"),
                (3, "MeMesh Bug", "bug_fix", "2026-01-03 08:00:00"),
            ],
        )
        conn.executemany(
            "INSERT INTO tags (entity_id, tag) VALUES (?, ?)",
            [
                (1, "memesh"),
                (1, "plugin"),
                (2, "nba"),
                (3, "memesh"),
            ],
        )
        conn.executemany(
            "INSERT INTO observations (entity_id, content) VALUES (?, ?)",
            [
                (1, "MeMesh plugin for Claude Code"),
                (2, "NBA statistics service"),
                (3, "Fixed a memory leak in MeMesh"),
            ],
        )
        conn.commit()

    def test_no_filters_returns_all(self):
        conn = _make_conn()
        self._seed(conn)
        df = search_entities(conn)
        assert len(df) == 3

    def test_filter_by_type(self):
        conn = _make_conn()
        self._seed(conn)
        df = search_entities(conn, types=["feature"])
        assert len(df) == 1
        assert df.iloc[0]["name"] == "MeMesh Plugin"

    def test_filter_by_tag(self):
        conn = _make_conn()
        self._seed(conn)
        df = search_entities(conn, tags=["memesh"])
        assert len(df) == 2

    def test_filter_by_date_range(self):
        conn = _make_conn()
        self._seed(conn)
        df = search_entities(conn, date_from=date(2026, 1, 2), date_to=date(2026, 1, 2))
        assert len(df) == 1
        assert df.iloc[0]["name"] == "NBA Stats API"

    def test_text_search_like_fallback(self):
        """When FTS5 is not available, LIKE fallback should work."""
        conn = _make_conn(with_fts=False)
        self._seed(conn)
        df = search_entities(conn, query="NBA")
        assert len(df) == 1
        assert df.iloc[0]["name"] == "NBA Stats API"

    def test_text_search_like_fallback_observation(self):
        """LIKE fallback should also search in observations."""
        conn = _make_conn(with_fts=False)
        self._seed(conn)
        df = search_entities(conn, query="memory leak")
        assert len(df) == 1
        assert df.iloc[0]["name"] == "MeMesh Bug"

    def test_limit(self):
        conn = _make_conn()
        self._seed(conn)
        df = search_entities(conn, limit=1)
        assert len(df) == 1

    def test_combined_filters(self):
        conn = _make_conn()
        self._seed(conn)
        df = search_entities(conn, types=["feature"], tags=["memesh"])
        assert len(df) == 1
        assert df.iloc[0]["name"] == "MeMesh Plugin"

    def test_empty_query_returns_all(self):
        conn = _make_conn()
        self._seed(conn)
        df = search_entities(conn, query="   ")
        assert len(df) == 3

    def test_special_chars_query_with_like_fallback(self):
        """Query with only special chars should still work via LIKE fallback."""
        conn = _make_conn(with_fts=False)
        self._seed(conn)
        # This should not crash, even if it matches nothing
        df = search_entities(conn, query="***")
        assert isinstance(df, pd.DataFrame)
