"""KG Explorer page — interactive graph with streamlit-agraph."""

import html
import sqlite3
import streamlit as st
from streamlit_agraph import agraph, Node, Edge, Config
from db import (
    search_entities, get_graph_data,
    get_all_types, get_all_tags_with_counts, is_fts5_available,
)


# --- Type → Color mapping for graph nodes ---
TYPE_COLORS = {
    "decision": "#FF6B6B",
    "feature": "#4ECDC4",
    "bug_fix": "#FFE66D",
    "lesson_learned": "#A8E6CF",
    "pattern": "#DDA0DD",
    "note": "#87CEEB",
    "best_practice": "#98D8C8",
    "architecture": "#F7DC6F",
    "mistake": "#E74C3C",
    "technical_pattern": "#BB8FCE",
    "deployment": "#85C1E9",
    "improvement": "#F8C471",
    "refactoring": "#AED6F1",
    "test_result": "#D5DBDB",
}
DEFAULT_COLOR = "#C0C0C0"

# --- Relation type → Edge color ---
EDGE_COLORS = {
    "similar_to": "#6C757D",
    "solves": "#28A745",
    "caused_by": "#DC3545",
    "enabled_by": "#007BFF",
    "depends_on": "#FFC107",
    "follows_pattern": "#17A2B8",
    "replaced_by": "#6F42C1",
    "evolved_from": "#FD7E14",
}
DEFAULT_EDGE_COLOR = "#888888"


def render_explorer(conn: sqlite3.Connection):
    try:
        _render_content(conn)
    except sqlite3.Error as e:
        st.error(f"**Database error:** {e}")
        st.info("Check that the database file exists and is not corrupted. Try restarting the application.")


def _render_content(conn: sqlite3.Connection):
    # --- Sidebar Filters ---
    with st.sidebar:
        st.subheader("Filters")

        search_query = st.text_input(
            "Search",
            placeholder="Search entities...",
            help="FTS5 full-text search" if is_fts5_available(conn) else "Basic text search",
        )

        all_types = get_all_types(conn)
        auto_types = {"session_keypoint", "session_identity", "task_start", "session_summary"}
        meaningful_types = [t for t in all_types if t not in auto_types]
        default_types = meaningful_types
        selected_types = st.multiselect("Entity Type", all_types, default=default_types)

        # Color legend matching graph node colors
        if selected_types:
            legend_html = " ".join(
                f'<span style="display:inline-block;width:12px;height:12px;'
                f'border-radius:50%;background:{TYPE_COLORS.get(t, DEFAULT_COLOR)};'
                f'margin-right:4px;vertical-align:middle;"></span>'
                f'<span style="vertical-align:middle;margin-right:10px;font-size:0.85em;">{html.escape(t)}</span>'
                for t in selected_types
            )
            st.markdown(legend_html, unsafe_allow_html=True)

        st.divider()

        # Edge color legend
        st.caption("Relation colors:")
        edge_legend_html = " ".join(
            f'<span style="display:inline-block;width:20px;height:3px;'
            f'background:{color};margin-right:4px;vertical-align:middle;"></span>'
            f'<span style="vertical-align:middle;margin-right:8px;font-size:0.8em;">{html.escape(rtype)}</span>'
            for rtype, color in EDGE_COLORS.items()
        )
        st.markdown(edge_legend_html, unsafe_allow_html=True)

        st.divider()

        tags_with_counts = get_all_tags_with_counts(conn, limit=30)
        tag_map = {tag: count for tag, count in tags_with_counts}
        selected_tags = st.multiselect(
            "Tags",
            list(tag_map.keys()),
            format_func=lambda t: f"{t} ({tag_map[t]})",
        )

        date_col1, date_col2 = st.columns(2)
        with date_col1:
            date_from = st.date_input("From", value=None)
        with date_col2:
            date_to = st.date_input("To", value=None)

    # --- Search with filters ---
    results_df = search_entities(
        conn,
        query=search_query,
        types=selected_types or None,
        tags=selected_tags or None,
        date_from=date_from,
        date_to=date_to,
        limit=300,
    )

    total_results = len(results_df)

    # --- Graph controls ---
    max_nodes = st.slider("Max nodes", 10, 300, 50)

    if total_results > max_nodes:
        st.caption(f"Showing {max_nodes} of {total_results} entities")

    display_df = results_df.head(max_nodes)

    if display_df.empty:
        st.info("No entities match the current filters.")
        return

    entity_ids = display_df["id"].tolist()
    graph_data = get_graph_data(conn, entity_ids)

    node_count = len(graph_data["nodes"])
    edge_count = len(graph_data["edges"])
    st.caption(f"{node_count} nodes, {edge_count} relations")

    # --- Build agraph nodes and edges ---
    nodes = []
    for node in graph_data["nodes"]:
        color = TYPE_COLORS.get(node["type"], DEFAULT_COLOR)
        size = max(4, min(12, 4 + node["obs_count"] // 2))
        short_label = node["name"][:20] if len(node["name"]) > 20 else node["name"]
        nodes.append(Node(
            id=str(node["id"]),
            label=short_label,
            size=size,
            color=color,
            title=f"{node['name']}\nType: {node['type']}\nObservations: {node['obs_count']}",
            font={"size": 8, "color": "#cccccc"},
        ))

    edges = []
    for edge in graph_data["edges"]:
        color = EDGE_COLORS.get(edge["relation_type"], DEFAULT_EDGE_COLOR)
        edges.append(Edge(
            source=str(edge["from_entity_id"]),
            target=str(edge["to_entity_id"]),
            title=edge["relation_type"],
            color=color,
            width=1,
        ))

    # --- Graph config ---
    config = Config(
        width="100%",
        height=900,
        directed=True,
        physics={
            "enabled": True,
            "barnesHut": {
                "gravitationalConstant": -50000,
                "centralGravity": 0.03,
                "springLength": 500,
                "springConstant": 0.001,
                "damping": 0.09,
                "avoidOverlap": 1.0,
            },
            "minVelocity": 0.75,
            "stabilization": {"iterations": 200},
        },
        hierarchical=False,
        nodeHighlightBehavior=True,
        highlightColor="#F7A7A6",
        collapsible=False,
        node={"labelProperty": "label", "renderLabel": True},
        link={"labelProperty": "label", "renderLabel": False},
    )

    # --- Render graph (full width) ---
    agraph(nodes=nodes, edges=edges, config=config)
