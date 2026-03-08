#!/usr/bin/env python3
"""
Backfill relations for existing entities in the MeMesh knowledge graph.

Creates three layers of relations:
  1. Topic/Project clustering -> similar_to
  2. Cross-type semantic relations (bug_fix->solves->feature, etc.)
  3. Tag-based similarity -> similar_to

Usage:
  python backfill_relations.py [--dry-run] [--db-path PATH]
"""

import argparse
import json
import re
import sqlite3
from collections import defaultdict
from pathlib import Path

# --- Constants ---

SKIP_TYPES = {"session_keypoint", "session_identity", "task_start", "session_summary"}

NOISE_TAGS = {"auto_saved", "session_end", "scope:project"}
DATE_TAG_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Project/topic prefixes to detect clusters
PROJECT_PREFIXES = [
    "MeMesh", "A2A", "AgentGigDAO", "AgentGigPlatform", "AgentGig",
    "NBA", "Polytrador", "Stripe", "Railway", "Vercel",
    "NestJS", "Prisma", "Supabase", "Claude", "MCP",
    "AI-nEOS", "DGX", "SDK", "VPC", "Obsidian", "GitHub", "Git",
]

# Cross-type relation rules: (from_type, relation, to_type)
CROSS_TYPE_RULES = [
    ("bug_fix", "solves", "feature"),
    ("decision", "enabled_by", "feature"),
    ("lesson_learned", "caused_by", "bug_fix"),
    ("lesson_learned", "follows_pattern", "best_practice"),
    ("mistake", "caused_by", "bug_fix"),
    ("feature", "depends_on", "architecture"),
]

# Also treat these as equivalent to bug_fix for matching
BUG_FIX_ALIASES = {"bug_fix", "fix"}

MAX_CLUSTER_PAIRS = 20  # Max relations per large cluster before content filtering


def parse_args():
    parser = argparse.ArgumentParser(description="Backfill MeMesh knowledge graph relations")
    parser.add_argument("--dry-run", action="store_true", help="Preview without inserting")
    parser.add_argument(
        "--db-path",
        default=str(Path.home() / ".memesh" / "knowledge-graph.db"),
        help="Path to SQLite database (default: ~/.memesh/knowledge-graph.db)",
    )
    return parser.parse_args()


def load_entities(conn):
    """Load all non-auto entities."""
    rows = conn.execute(
        "SELECT id, name, type FROM entities WHERE type NOT IN (?, ?, ?, ?)",
        tuple(SKIP_TYPES),
    ).fetchall()
    return [{"id": r[0], "name": r[1], "type": r[2]} for r in rows]


def load_tags(conn):
    """Load tags per entity, skipping noise tags."""
    rows = conn.execute(
        """
        SELECT t.entity_id, t.tag
        FROM tags t
        JOIN entities e ON e.id = t.entity_id
        WHERE e.type NOT IN (?, ?, ?, ?)
        """,
        tuple(SKIP_TYPES),
    ).fetchall()

    tags_by_entity = defaultdict(set)
    for entity_id, tag in rows:
        if tag in NOISE_TAGS or DATE_TAG_RE.match(tag):
            continue
        tags_by_entity[entity_id].add(tag)
    return tags_by_entity


def load_observations(conn, entity_ids):
    """Load observation content for entities (for content overlap in large clusters)."""
    if not entity_ids:
        return {}
    placeholders = ",".join("?" * len(entity_ids))
    rows = conn.execute(
        f"SELECT entity_id, content FROM observations WHERE entity_id IN ({placeholders})",
        list(entity_ids),
    ).fetchall()
    obs_by_entity = defaultdict(str)
    for eid, content in rows:
        obs_by_entity[eid] += " " + content
    return obs_by_entity


def extract_topic(name):
    """Extract topic/project cluster key from entity name."""
    # Check known project prefixes (longest match first)
    for prefix in sorted(PROJECT_PREFIXES, key=len, reverse=True):
        if name.startswith(prefix):
            # Normalize AgentGig* to AgentGig
            if prefix.startswith("AgentGig"):
                return "AgentGig"
            return prefix

    # Fall back to first significant word (skip common leading words)
    skip_words = {"feature", "phase", "mistake:", "bug", "fix", "the", "a", "an"}
    words = re.split(r"[\s:\-/]+", name)
    for w in words:
        if w.lower() not in skip_words and len(w) > 2:
            return w
    return None


def content_words(text):
    """Extract meaningful words from text for overlap scoring."""
    words = set(re.findall(r"[a-zA-Z]{4,}", text.lower()))
    # Remove very common words
    stopwords = {
        "this", "that", "with", "from", "have", "been", "were", "they",
        "their", "would", "should", "could", "when", "what", "which",
        "there", "about", "into", "each", "also", "more", "than",
        "then", "some", "only", "other", "after", "before", "first",
        "using", "used", "make", "made", "need", "does", "done",
    }
    return words - stopwords


def score_pair_overlap(obs, eid_a, eid_b):
    """Score content overlap between two entities (0.0 - 1.0)."""
    words_a = content_words(obs.get(eid_a, ""))
    words_b = content_words(obs.get(eid_b, ""))
    if not words_a or not words_b:
        return 0.0
    intersection = words_a & words_b
    smaller = min(len(words_a), len(words_b))
    return len(intersection) / smaller if smaller > 0 else 0.0


def layer1_topic_clustering(entities, conn):
    """Layer 1: Topic/Project clustering -> similar_to."""
    relations = []

    # Group entities by topic
    clusters = defaultdict(list)
    for e in entities:
        topic = extract_topic(e["name"])
        if topic:
            clusters[topic].append(e)

    # Only process clusters with 2+ entities
    for topic, members in clusters.items():
        if len(members) < 2:
            continue

        # For large clusters, use content overlap to pick best pairs
        if len(members) > MAX_CLUSTER_PAIRS:
            member_ids = [m["id"] for m in members]
            obs = load_observations(conn, member_ids)

            # Score all pairs and keep top N
            scored_pairs = []
            for i in range(len(members)):
                for j in range(i + 1, len(members)):
                    score = score_pair_overlap(obs, members[i]["id"], members[j]["id"])
                    if score > 0.15:  # Minimum overlap threshold
                        scored_pairs.append((score, members[i], members[j]))

            scored_pairs.sort(key=lambda x: x[0], reverse=True)
            for _, a, b in scored_pairs[:MAX_CLUSTER_PAIRS]:
                relations.append((a["id"], b["id"], "similar_to", topic))
        else:
            # Small cluster: connect all pairs
            for i in range(len(members)):
                for j in range(i + 1, len(members)):
                    relations.append(
                        (members[i]["id"], members[j]["id"], "similar_to", topic)
                    )

    return relations


def layer2_cross_type(entities, conn):
    """Layer 2: Cross-type semantic relations within same topic cluster."""
    relations = []

    # Group entities by topic
    clusters = defaultdict(list)
    for e in entities:
        topic = extract_topic(e["name"])
        if topic:
            clusters[topic].append(e)

    for topic, members in clusters.items():
        if len(members) < 2:
            continue

        # Index by type within cluster
        by_type = defaultdict(list)
        for m in members:
            by_type[m["type"]].append(m)
            # Add fix alias
            if m["type"] in BUG_FIX_ALIASES:
                if m["type"] != "bug_fix":
                    by_type["bug_fix"].append(m)

        # Apply cross-type rules
        for from_type, relation, to_type in CROSS_TYPE_RULES:
            from_entities = by_type.get(from_type, [])
            to_entities = by_type.get(to_type, [])
            for fe in from_entities:
                for te in to_entities:
                    if fe["id"] != te["id"]:
                        relations.append((fe["id"], te["id"], relation, topic))

    return relations


def layer3_tag_similarity(entities, tags_by_entity):
    """Layer 3: Tag-based similarity -> similar_to."""
    relations = []

    # Build inverted index: tag -> set of entity_ids
    tag_to_entities = defaultdict(set)
    for eid, tags in tags_by_entity.items():
        for tag in tags:
            tag_to_entities[tag].add(eid)

    # Find entity pairs sharing 2+ tags
    entity_ids_with_tags = [eid for eid, tags in tags_by_entity.items() if len(tags) >= 2]
    seen_pairs = set()

    for i, eid_a in enumerate(entity_ids_with_tags):
        for eid_b in entity_ids_with_tags[i + 1 :]:
            if (eid_a, eid_b) in seen_pairs:
                continue
            shared = tags_by_entity[eid_a] & tags_by_entity[eid_b]
            if len(shared) >= 2:
                relations.append(
                    (eid_a, eid_b, "similar_to", f"tags:{','.join(sorted(shared))}")
                )
                seen_pairs.add((eid_a, eid_b))

    return relations



def main():
    args = parse_args()

    db_path = Path(args.db_path).expanduser()
    if not db_path.exists():
        print(f"ERROR: Database not found at {db_path}")
        return

    print(f"Database: {db_path}")
    print(f"Mode: {'DRY RUN (no changes)' if args.dry_run else 'LIVE (inserting relations)'}")
    print()

    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA foreign_keys = ON")

    # Load data
    entities = load_entities(conn)
    tags_by_entity = load_tags(conn)
    print(f"Loaded {len(entities)} entities (excluding auto types)")
    print(f"Loaded tags for {len(tags_by_entity)} entities")
    print()

    # Track relation counts before
    before_count = conn.execute("SELECT COUNT(*) FROM relations").fetchone()[0]

    # Layer 1: Topic clustering
    print("--- Layer 1: Topic/Project Clustering (similar_to) ---")
    l1_relations = layer1_topic_clustering(entities, conn)
    print(f"  Generated {len(l1_relations)} relations")

    # Layer 2: Cross-type semantic
    print("--- Layer 2: Cross-Type Semantic Relations ---")
    l2_relations = layer2_cross_type(entities, conn)
    print(f"  Generated {len(l2_relations)} relations")

    # Layer 3: Tag similarity
    print("--- Layer 3: Tag-Based Similarity (similar_to) ---")
    l3_relations = layer3_tag_similarity(entities, tags_by_entity)
    print(f"  Generated {len(l3_relations)} relations")

    # Deduplicate across layers (keep first occurrence)
    all_relations = []
    seen = set()
    for rel in l1_relations + l2_relations + l3_relations:
        key = (rel[0], rel[1], rel[2])
        # Also check reverse for similar_to (symmetric)
        rev_key = (rel[1], rel[0], rel[2])
        if key not in seen and rev_key not in seen:
            all_relations.append(rel)
            seen.add(key)

    print(f"\nTotal unique relations to insert: {len(all_relations)}")
    print()

    # Insert
    if args.dry_run:
        # Show sample relations
        print("Sample relations (first 20):")
        # Look up entity names for display
        id_to_name = {e["id"]: e["name"] for e in entities}
        for from_id, to_id, rel_type, source in all_relations[:20]:
            from_name = id_to_name.get(from_id, f"#{from_id}")
            to_name = id_to_name.get(to_id, f"#{to_id}")
            # Truncate names for readability
            from_short = from_name[:40] + ("..." if len(from_name) > 40 else "")
            to_short = to_name[:40] + ("..." if len(to_name) > 40 else "")
            print(f"  [{rel_type}] {from_short} -> {to_short}  (source: {source})")

        print(f"\nDRY RUN: Would insert {len(all_relations)} relations. No changes made.")
    else:
        # Use a single transaction for all inserts
        inserted = 0
        skipped = 0
        with conn:
            for from_id, to_id, rel_type, source in all_relations:
                metadata = json.dumps({"source": source})
                cursor = conn.execute(
                    """
                    INSERT OR IGNORE INTO relations (from_entity_id, to_entity_id, relation_type, metadata)
                    VALUES (?, ?, ?, ?)
                    """,
                    (from_id, to_id, rel_type, metadata),
                )
                if cursor.rowcount > 0:
                    inserted += 1
                else:
                    skipped += 1

        after_count = conn.execute("SELECT COUNT(*) FROM relations").fetchone()[0]
        print(f"Inserted: {inserted}")
        print(f"Skipped (duplicates): {skipped}")
        print(f"Relations before: {before_count}")
        print(f"Relations after:  {after_count}")

        # Show breakdown by relation_type
        print("\nRelations by type:")
        for row in conn.execute(
            "SELECT relation_type, COUNT(*) FROM relations GROUP BY relation_type ORDER BY COUNT(*) DESC"
        ).fetchall():
            print(f"  {row[0]}: {row[1]}")

    conn.close()
    print("\nDone.")


if __name__ == "__main__":
    main()
