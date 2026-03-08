"""KG Explorer page — filter, graph, and entity detail."""

import sqlite3
import json
import streamlit as st
import streamlit.components.v1 as components
from pyvis.network import Network
from db import (
    search_entities, get_entity_detail, get_graph_data,
    get_all_types, get_all_tags_with_counts, is_fts5_available,
    delete_entity, update_observation, delete_observation, add_tag, remove_tag,
)


# --- Type → Color mapping for graph nodes ---
TYPE_COLORS = {
    "decision": "#FF6B6B",
    "feature": "#4ECDC4",
    "bug_fix": "#FFE66D",
    "lesson_learned": "#A8E6CF",
    "pattern": "#DDA0DD",
    "note": "#87CEEB",
}
DEFAULT_COLOR = "#C0C0C0"


def render_explorer(conn: sqlite3.Connection):
    try:
        _render_content(conn)
    except sqlite3.Error as e:
        st.error(f"**Database error:** {e}")


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
        selected_types = st.multiselect("Entity Type", all_types)

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

    # --- Main Layout: Graph (60%) + Detail (40%) ---
    graph_col, detail_col = st.columns([3, 2])

    with graph_col:
        st.subheader("Knowledge Graph")

        max_nodes = st.slider("Max nodes", 10, 300, 100)

        if total_results > max_nodes:
            st.caption(f"Showing {max_nodes} of {total_results} entities")

        display_df = results_df.head(max_nodes)

        if not display_df.empty:
            entity_ids = display_df["id"].tolist()
            graph_data = get_graph_data(conn, entity_ids)
            _render_graph(graph_data, conn)
        else:
            st.info("No entities match the current filters.")

    with detail_col:
        _render_entity_detail(conn)


def _render_graph(graph_data: dict, conn: sqlite3.Connection):
    """Render pyvis network graph."""
    net = Network(height="600px", width="100%", bgcolor="#222222", font_color="white")
    net.barnes_hut(gravity=-3000, central_gravity=0.3, spring_length=100)

    for node in graph_data["nodes"]:
        color = TYPE_COLORS.get(node["type"], DEFAULT_COLOR)
        size = max(10, min(50, 10 + node["obs_count"] * 3))
        net.add_node(
            node["id"],
            label=node["name"],
            color=color,
            size=size,
            title=f"{node['name']} ({node['type']})\nObservations: {node['obs_count']}",
        )

    for edge in graph_data["edges"]:
        net.add_edge(
            edge["from_entity_id"],
            edge["to_entity_id"],
            title=edge["relation_type"],
            label=edge["relation_type"],
            color="#888888",
        )

    # Generate HTML and embed
    html = net.generate_html()
    components.html(html, height=620, scrolling=False)

    # Entity selection via clickable list (pyvis can't directly update Streamlit state)
    if graph_data["nodes"]:
        st.caption("Click an entity below to view details:")
        for node in graph_data["nodes"][:20]:  # Show first 20 for selection
            if st.button(
                f"{node['name']} ({node['type']})",
                key=f"graph_node_{node['id']}",
            ):
                st.session_state["selected_entity_id"] = node["id"]
                st.rerun()


def _render_entity_detail(conn: sqlite3.Connection):
    """Render entity detail panel."""
    st.subheader("Entity Detail")

    entity_id = st.session_state.get("selected_entity_id")

    if entity_id is None:
        st.info("Select an entity from the graph to view details.")
        return

    detail = get_entity_detail(conn, entity_id)

    if detail is None:
        st.warning("Entity not found. It may have been deleted.")
        st.session_state.pop("selected_entity_id", None)
        return

    entity = detail["entity"]

    # --- Header ---
    st.subheader(entity['name'])
    st.caption(f"Type: `{entity['type']}` | Created: {str(entity['created_at'])[:19]}")

    # --- Metadata ---
    if entity.get("metadata"):
        with st.expander("Metadata"):
            try:
                meta = json.loads(entity["metadata"]) if isinstance(entity["metadata"], str) else entity["metadata"]
                st.json(meta)
            except (json.JSONDecodeError, TypeError):
                st.code(str(entity["metadata"]))

    # --- Relations ---
    outgoing = detail["outgoing_relations"]
    incoming = detail["incoming_relations"]

    if outgoing or incoming:
        st.markdown("**Relations**")

        if outgoing:
            st.caption("Outgoing:")
            for rel in outgoing:
                if st.button(
                    f"-> {rel['relation_type']} -> {rel['target_name']}",
                    key=f"out_{rel['id']}",
                ):
                    st.session_state["selected_entity_id"] = rel["target_id"]
                    st.rerun()

        if incoming:
            st.caption("Incoming:")
            for rel in incoming:
                if st.button(
                    f"{rel['source_name']} -> {rel['relation_type']} ->",
                    key=f"in_{rel['id']}",
                ):
                    st.session_state["selected_entity_id"] = rel["source_id"]
                    st.rerun()

    st.divider()

    # --- Observations ---
    st.markdown("**Observations**")
    observations = detail["observations"]

    if observations:
        for obs in observations:
            obs_key = f"obs_{obs['id']}"

            # Edit mode check
            editing = st.session_state.get(f"editing_{obs_key}", False)

            if editing:
                new_content = st.text_area(
                    "Edit observation",
                    value=obs["content"],
                    key=f"edit_text_{obs_key}",
                    label_visibility="collapsed",
                )
                save_col, cancel_col = st.columns(2)
                with save_col:
                    if st.button("Save", key=f"save_{obs_key}"):
                        if update_observation(conn, obs["id"], new_content):
                            st.success("Observation updated.")
                            st.session_state.pop(f"editing_{obs_key}", None)
                            st.rerun()
                        else:
                            st.error("Failed to update. Content must be non-empty and under 65536 chars.")
                with cancel_col:
                    if st.button("Cancel", key=f"cancel_{obs_key}"):
                        st.session_state.pop(f"editing_{obs_key}", None)
                        st.rerun()
            else:
                # Display mode
                content = obs["content"]
                display_text = content[:200] + "..." if len(content) > 200 else content

                with st.expander(display_text, expanded=False):
                    st.write(content)
                    st.caption(f"Created: {str(obs['created_at'])[:19]}")

                    edit_col, del_col = st.columns(2)
                    with edit_col:
                        if st.button("Edit", key=f"edit_{obs_key}"):
                            st.session_state[f"editing_{obs_key}"] = True
                            st.rerun()
                    with del_col:
                        confirm_delete = st.checkbox(
                            "Confirm delete",
                            key=f"confirm_del_{obs_key}",
                        )
                        if confirm_delete:
                            if st.button("Delete", key=f"del_{obs_key}", type="primary"):
                                if delete_observation(conn, obs["id"]):
                                    st.success("Observation deleted.")
                                    st.rerun()
                                else:
                                    st.error("Failed to delete observation.")
    else:
        st.caption("No observations.")

    st.divider()

    # --- Tags ---
    st.markdown("**Tags**")
    tags_list = detail["tags"]

    if tags_list:
        for tag_item in tags_list:
            tag_col, remove_col = st.columns([4, 1])
            tag_col.write(f"`{tag_item['tag']}`")
            with remove_col:
                if st.button("x", key=f"rmtag_{tag_item['id']}"):
                    if remove_tag(conn, tag_item["id"]):
                        st.rerun()
                    else:
                        st.error("Failed to remove tag.")
    else:
        st.caption("No tags.")

    # Add tag input
    add_col, btn_col = st.columns([3, 1])
    with add_col:
        new_tag = st.text_input("New tag", key="new_tag_input", label_visibility="collapsed", placeholder="Add tag...")
    with btn_col:
        if st.button("Add", key="add_tag_btn"):
            if new_tag.strip():
                if add_tag(conn, entity_id, new_tag):
                    st.success(f"Tag '{new_tag.strip()}' added.")
                    st.rerun()
                else:
                    st.error("Invalid tag. Must be non-empty, under 256 chars, no control characters.")

    st.divider()

    # --- Delete Entity ---
    with st.expander("Danger Zone", expanded=False):
        st.warning(f"Permanently delete entity '{entity['name']}' and all its observations, tags, and relations?")
        confirm_name = st.text_input(
            "Type entity name to confirm",
            key="delete_entity_confirm",
            placeholder=entity["name"],
        )
        if st.button("Delete Entity", type="primary", key="delete_entity_btn"):
            if confirm_name == entity["name"]:
                if delete_entity(conn, entity_id):
                    st.success(f"Entity '{entity['name']}' deleted.")
                    st.session_state.pop("selected_entity_id", None)
                    st.rerun()
                else:
                    st.error("Failed to delete entity.")
            else:
                st.error(f"Type exactly: {entity['name']}")
