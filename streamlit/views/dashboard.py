"""Dashboard page — KPIs, charts, and recent entities."""

import sqlite3
import streamlit as st
import plotly.express as px
from db import (
    get_entity_count, get_relation_count, get_observation_count, get_tag_count,
    get_entity_type_distribution, get_top_tags, get_entity_growth, get_recent_entities,
)


def render_dashboard(conn: sqlite3.Connection):
    st.header("Dashboard")

    try:
        _render_content(conn)
    except sqlite3.Error as e:
        st.error(f"**Database error:** {e}")
        st.info("Make sure the knowledge graph database is initialized.")


def _render_content(conn: sqlite3.Connection):
    # --- KPI Cards ---
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Entities", get_entity_count(conn))
    c2.metric("Relations", get_relation_count(conn))
    c3.metric("Observations", get_observation_count(conn))
    c4.metric("Tags", get_tag_count(conn))

    st.divider()

    # --- Middle: Charts ---
    left, right = st.columns(2)

    with left:
        st.subheader("Entity Type Distribution")
        type_df = get_entity_type_distribution(conn)
        if not type_df.empty:
            fig = px.pie(type_df, names="type", values="count", hole=0.4)
            fig.update_traces(textposition="inside", textinfo="percent+label")
            fig.update_layout(margin=dict(t=20, b=20, l=20, r=20))
            st.plotly_chart(fig, use_container_width=True)
        else:
            st.info("No entities yet.")

    with right:
        st.subheader("Top 15 Tags")
        tags_df = get_top_tags(conn, limit=15)
        if not tags_df.empty:
            # Sort ascending for horizontal bar (bottom to top)
            tags_df = tags_df.sort_values("count", ascending=True)
            fig = px.bar(
                tags_df, x="count", y="tag", orientation="h",
                text="count",
            )
            fig.update_traces(textposition="outside")
            fig.update_layout(
                margin=dict(t=20, b=20, l=20, r=20),
                yaxis_title="",
                xaxis_title="Count",
            )
            st.plotly_chart(fig, use_container_width=True)
        else:
            st.info("No tags yet.")

    st.divider()

    # --- Entity Growth Timeline ---
    st.subheader("Entity Growth")
    granularity = st.selectbox(
        "Granularity",
        ["day", "week", "month"],
        index=0,
        label_visibility="collapsed",
    )
    growth_df = get_entity_growth(conn, granularity=granularity)
    if not growth_df.empty:
        fig = px.line(
            growth_df, x="period", y="cumulative_count",
            labels={"period": "Date", "cumulative_count": "Total Entities"},
        )
        fig.update_layout(margin=dict(t=20, b=20, l=20, r=20))
        st.plotly_chart(fig, use_container_width=True)
    else:
        st.info("No growth data yet.")

    st.divider()

    # --- Recent Entities ---
    st.subheader("Recent Entities")
    recent_df = get_recent_entities(conn, limit=20)
    if not recent_df.empty:
        # Header row
        h1, h2, h3, h4, h5 = st.columns([3, 2, 2, 1, 1])
        h1.write("**Name**"); h2.write("**Type**"); h3.write("**Created**")
        h4.write("**Tags**"); h5.write("**Obs**")
        # Data rows
        for _, row in recent_df.iterrows():
            col_name, col_type, col_date, col_tags, col_obs = st.columns([3, 2, 2, 1, 1])
            with col_name:
                if st.button(row["name"], key=f"recent_{row['id']}"):
                    st.session_state["selected_entity_id"] = int(row["id"])
                    st.session_state["page"] = "KG Explorer"
                    st.rerun()
            col_type.write(row["type"])
            col_date.write(str(row["created_at"])[:19])
            col_tags.write(f"\U0001f3f7 {row['tag_count']}")
            col_obs.write(f"\U0001f4dd {row['observation_count']}")
    else:
        st.info("No entities yet.")
