"""Tests for streamlit/backfill_relations.py relation backfill logic."""

import sqlite3
from collections import defaultdict

import pytest
import sys

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
from backfill_relations import (
    extract_topic,
    content_words,
    score_pair_overlap,
    layer1_topic_clustering,
    layer2_cross_type,
    layer3_tag_similarity,
    CROSS_TYPE_RULES,
    SKIP_TYPES,
)


# ---------- Schema helpers ----------


def _create_schema(conn: sqlite3.Connection):
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


def _make_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys=ON")
    _create_schema(conn)
    return conn


# ================================================================
# extract_topic
# ================================================================


class TestExtractTopic:
    def test_known_prefix_memesh(self):
        assert extract_topic("MeMesh Plugin Feature") == "MeMesh"

    def test_known_prefix_nba(self):
        assert extract_topic("NBA Stats Dashboard") == "NBA"

    def test_agentgig_normalization(self):
        """All AgentGig* prefixes normalize to 'AgentGig'."""
        assert extract_topic("AgentGigDAO Contracts") == "AgentGig"
        assert extract_topic("AgentGigPlatform Backend") == "AgentGig"
        assert extract_topic("AgentGig Core") == "AgentGig"

    def test_longest_prefix_match(self):
        """AgentGigPlatform should match AgentGigPlatform (longer) before AgentGig."""
        # Both should normalize to AgentGig, but the longer prefix is matched first
        result = extract_topic("AgentGigPlatform API")
        assert result == "AgentGig"

    def test_fallback_first_significant_word(self):
        """When no prefix matches, use first significant word."""
        assert extract_topic("Kubernetes Deployment Config") == "Kubernetes"

    def test_skip_common_leading_words(self):
        """Leading common words like 'feature', 'bug' should be skipped."""
        result = extract_topic("feature: Authentication Flow")
        assert result == "Authentication"

    def test_skip_short_words(self):
        """Words <= 2 chars should be skipped."""
        result = extract_topic("a b c DataModel")
        assert result == "DataModel"

    def test_returns_none_for_empty(self):
        assert extract_topic("") is None

    def test_returns_none_for_only_skip_words(self):
        assert extract_topic("bug fix the") is None

    def test_known_prefix_claude(self):
        assert extract_topic("Claude Code Integration") == "Claude"

    def test_known_prefix_dgx(self):
        assert extract_topic("DGX Spark Setup") == "DGX"


# ================================================================
# content_words
# ================================================================


class TestContentWords:
    def test_extracts_words_4plus_chars(self):
        words = content_words("The quick brown fox jumps")
        assert "quick" in words
        assert "brown" in words
        assert "jumps" in words
        # "The" and "fox" are < 4 chars
        assert "the" not in words
        assert "fox" not in words

    def test_removes_stopwords(self):
        words = content_words("this would have been using these features")
        assert "this" not in words
        assert "would" not in words
        assert "have" not in words
        assert "been" not in words
        assert "using" not in words
        assert "features" in words

    def test_lowercase(self):
        words = content_words("Hello WORLD Testing")
        assert "hello" in words
        assert "world" in words
        assert "testing" in words

    def test_empty_string(self):
        assert content_words("") == set()

    def test_only_short_words(self):
        assert content_words("a b c de hi") == set()

    def test_deduplicates(self):
        words = content_words("test test test test")
        assert words == {"test"}


# ================================================================
# score_pair_overlap
# ================================================================


class TestScorePairOverlap:
    def test_identical_content(self):
        obs = {1: "authentication login security", 2: "authentication login security"}
        score = score_pair_overlap(obs, 1, 2)
        assert score == 1.0

    def test_no_overlap(self):
        obs = {1: "authentication login security", 2: "kubernetes deployment containers"}
        score = score_pair_overlap(obs, 1, 2)
        assert score == 0.0

    def test_partial_overlap(self):
        obs = {
            1: "authentication login security feature",
            2: "authentication security token refresh",
        }
        score = score_pair_overlap(obs, 1, 2)
        assert 0.0 < score < 1.0

    def test_empty_content(self):
        obs = {1: "hello world testing", 2: ""}
        assert score_pair_overlap(obs, 1, 2) == 0.0

    def test_missing_entity(self):
        obs = {1: "hello world testing"}
        assert score_pair_overlap(obs, 1, 999) == 0.0

    def test_both_empty(self):
        obs = {}
        assert score_pair_overlap(obs, 1, 2) == 0.0

    def test_score_uses_smaller_set(self):
        """Score is intersection / min(len(a), len(b))."""
        obs = {
            1: "alpha bravo charlie delta echo foxtrot",  # 6 words (all >= 4 chars)
            2: "alpha bravo",  # 2 words matching
        }
        score = score_pair_overlap(obs, 1, 2)
        # 2 overlap / min(6, 2) = 2/2 = 1.0
        assert score == 1.0


# ================================================================
# layer2_cross_type: enabled_by direction
# ================================================================


class TestEnabledByDirection:
    def test_feature_enabled_by_decision(self):
        """The rule is (feature, enabled_by, decision), meaning
        feature -> enabled_by -> decision."""
        conn = _make_conn()
        entities = [
            {"id": 1, "name": "MeMesh Auth Feature", "type": "feature"},
            {"id": 2, "name": "MeMesh Auth Decision", "type": "decision"},
        ]
        # Insert entities into DB for observation loading
        for e in entities:
            conn.execute(
                "INSERT INTO entities (id, name, type) VALUES (?, ?, ?)",
                (e["id"], e["name"], e["type"]),
            )
        conn.commit()

        relations = layer2_cross_type(entities, conn)
        assert len(relations) >= 1

        enabled_by_rels = [r for r in relations if r[2] == "enabled_by"]
        assert len(enabled_by_rels) == 1

        from_id, to_id, rel_type, _ = enabled_by_rels[0]
        assert from_id == 1  # feature
        assert to_id == 2    # decision
        assert rel_type == "enabled_by"

    def test_decision_does_not_enable_feature(self):
        """Direction should NOT be decision -> enabled_by -> feature."""
        conn = _make_conn()
        entities = [
            {"id": 1, "name": "MeMesh Auth Feature", "type": "feature"},
            {"id": 2, "name": "MeMesh Auth Decision", "type": "decision"},
        ]
        for e in entities:
            conn.execute(
                "INSERT INTO entities (id, name, type) VALUES (?, ?, ?)",
                (e["id"], e["name"], e["type"]),
            )
        conn.commit()

        relations = layer2_cross_type(entities, conn)
        enabled_by_rels = [r for r in relations if r[2] == "enabled_by"]

        # No relation should have decision as from_id
        for from_id, to_id, rel_type, _ in enabled_by_rels:
            assert from_id != 2, "Decision should not be the source of 'enabled_by'"


# ================================================================
# Deduplication of symmetric relations
# ================================================================


class TestSymmetricDeduplication:
    def test_similar_to_dedup(self):
        """When we have similar_to A->B, we should NOT also have B->A."""
        conn = _make_conn()
        # Create entities in same topic cluster so layer1 generates similar_to
        entities = [
            {"id": 1, "name": "MeMesh Feature Alpha", "type": "feature"},
            {"id": 2, "name": "MeMesh Feature Beta", "type": "feature"},
        ]
        for e in entities:
            conn.execute(
                "INSERT INTO entities (id, name, type) VALUES (?, ?, ?)",
                (e["id"], e["name"], e["type"]),
            )
        conn.commit()

        relations = layer1_topic_clustering(entities, conn)
        # Should produce at most one relation between entities 1 and 2
        pairs = set()
        for from_id, to_id, rel_type, _ in relations:
            if rel_type == "similar_to":
                pair = frozenset([from_id, to_id])
                assert pair not in pairs, f"Duplicate symmetric pair: {from_id} <-> {to_id}"
                pairs.add(pair)

    def test_main_dedup_logic(self):
        """Simulate the main() dedup: seen set checks both (a,b) and (b,a) for similar_to."""
        # This tests the dedup logic from main()
        all_raw = [
            (1, 2, "similar_to", "MeMesh"),
            (2, 1, "similar_to", "tags:foo,bar"),  # Reverse duplicate
            (3, 4, "depends_on", "topic"),
        ]

        all_relations = []
        seen = set()
        for rel in all_raw:
            key = (rel[0], rel[1], rel[2])
            rev_key = (rel[1], rel[0], rel[2])
            if key not in seen and rev_key not in seen:
                all_relations.append(rel)
                seen.add(key)

        assert len(all_relations) == 2  # (1,2,similar_to) and (3,4,depends_on)
        # The reverse (2,1,similar_to) should be dropped
        ids = [(r[0], r[1]) for r in all_relations]
        assert (2, 1) not in ids


# ================================================================
# layer1_topic_clustering
# ================================================================


class TestLayer1TopicClustering:
    def test_same_topic_creates_relations(self):
        conn = _make_conn()
        entities = [
            {"id": 1, "name": "MeMesh Feature A", "type": "feature"},
            {"id": 2, "name": "MeMesh Feature B", "type": "feature"},
            {"id": 3, "name": "MeMesh Bug C", "type": "bug_fix"},
        ]
        for e in entities:
            conn.execute(
                "INSERT INTO entities (id, name, type) VALUES (?, ?, ?)",
                (e["id"], e["name"], e["type"]),
            )
        conn.commit()

        relations = layer1_topic_clustering(entities, conn)
        assert len(relations) == 3  # 3 pairs from 3 entities
        assert all(r[2] == "similar_to" for r in relations)

    def test_different_topics_no_relation(self):
        conn = _make_conn()
        entities = [
            {"id": 1, "name": "MeMesh Feature", "type": "feature"},
            {"id": 2, "name": "NBA Dashboard", "type": "feature"},
        ]
        for e in entities:
            conn.execute(
                "INSERT INTO entities (id, name, type) VALUES (?, ?, ?)",
                (e["id"], e["name"], e["type"]),
            )
        conn.commit()

        relations = layer1_topic_clustering(entities, conn)
        assert len(relations) == 0

    def test_single_entity_no_relation(self):
        conn = _make_conn()
        entities = [{"id": 1, "name": "MeMesh Feature", "type": "feature"}]
        conn.execute("INSERT INTO entities (id, name, type) VALUES (1, 'MeMesh Feature', 'feature')")
        conn.commit()

        relations = layer1_topic_clustering(entities, conn)
        assert len(relations) == 0


# ================================================================
# layer2_cross_type
# ================================================================


class TestLayer2CrossType:
    def test_bug_fix_solves_feature(self):
        conn = _make_conn()
        entities = [
            {"id": 1, "name": "MeMesh Login Bug", "type": "bug_fix"},
            {"id": 2, "name": "MeMesh Login Feature", "type": "feature"},
        ]
        for e in entities:
            conn.execute(
                "INSERT INTO entities (id, name, type) VALUES (?, ?, ?)",
                (e["id"], e["name"], e["type"]),
            )
        conn.commit()

        relations = layer2_cross_type(entities, conn)
        solves = [r for r in relations if r[2] == "solves"]
        assert len(solves) == 1
        assert solves[0][0] == 1  # bug_fix
        assert solves[0][1] == 2  # feature

    def test_no_cross_type_for_same_type(self):
        conn = _make_conn()
        entities = [
            {"id": 1, "name": "MeMesh Feature A", "type": "feature"},
            {"id": 2, "name": "MeMesh Feature B", "type": "feature"},
        ]
        for e in entities:
            conn.execute(
                "INSERT INTO entities (id, name, type) VALUES (?, ?, ?)",
                (e["id"], e["name"], e["type"]),
            )
        conn.commit()

        relations = layer2_cross_type(entities, conn)
        # feature->feature only has enabled_by->decision and depends_on->architecture
        # With two features and no decisions/architecture, no cross-type rules apply
        # except feature->enabled_by->decision (no decision exists)
        assert len(relations) == 0

    def test_different_topics_no_cross_type(self):
        conn = _make_conn()
        entities = [
            {"id": 1, "name": "MeMesh Bug", "type": "bug_fix"},
            {"id": 2, "name": "NBA Feature", "type": "feature"},
        ]
        for e in entities:
            conn.execute(
                "INSERT INTO entities (id, name, type) VALUES (?, ?, ?)",
                (e["id"], e["name"], e["type"]),
            )
        conn.commit()

        # Different topic clusters -> no cross-type relation
        relations = layer2_cross_type(entities, conn)
        assert len(relations) == 0


# ================================================================
# layer3_tag_similarity
# ================================================================


class TestLayer3TagSimilarity:
    def test_shared_tags_create_relation(self):
        entities = [
            {"id": 1, "name": "A", "type": "feature"},
            {"id": 2, "name": "B", "type": "feature"},
        ]
        tags_by_entity = {
            1: {"auth", "security", "backend"},
            2: {"auth", "security", "frontend"},
        }
        relations = layer3_tag_similarity(entities, tags_by_entity)
        assert len(relations) == 1
        assert relations[0][2] == "similar_to"

    def test_one_shared_tag_not_enough(self):
        entities = [
            {"id": 1, "name": "A", "type": "feature"},
            {"id": 2, "name": "B", "type": "feature"},
        ]
        tags_by_entity = {
            1: {"auth", "backend"},
            2: {"auth", "frontend"},
        }
        relations = layer3_tag_similarity(entities, tags_by_entity)
        # Only 1 shared tag ("auth"), need >= 2
        assert len(relations) == 0

    def test_no_tags_no_relation(self):
        entities = [
            {"id": 1, "name": "A", "type": "feature"},
            {"id": 2, "name": "B", "type": "feature"},
        ]
        tags_by_entity = {}
        relations = layer3_tag_similarity(entities, tags_by_entity)
        assert len(relations) == 0

    def test_tag_source_in_metadata(self):
        """Relation source should list the shared tags."""
        tags_by_entity = {
            1: {"auth", "security", "backend"},
            2: {"auth", "security", "frontend"},
        }
        relations = layer3_tag_similarity([], tags_by_entity)
        assert len(relations) == 1
        source = relations[0][3]
        assert source.startswith("tags:")
        assert "auth" in source
        assert "security" in source

    def test_entities_with_fewer_than_2_tags_skipped(self):
        """Entities with fewer than 2 tags should not participate."""
        tags_by_entity = {
            1: {"auth"},  # Only 1 tag
            2: {"auth", "security"},
        }
        relations = layer3_tag_similarity([], tags_by_entity)
        assert len(relations) == 0
