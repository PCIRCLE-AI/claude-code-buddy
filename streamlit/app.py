"""
MeMesh Streamlit UI — Main Entry Point

Launch: streamlit run streamlit/app.py
"""

import streamlit as st
from path_resolver import resolve_db_path
from db import get_connection, is_fts5_available


def main():
    st.set_page_config(
        page_title="MeMesh Explorer",
        page_icon="🧠",
        layout="wide",
    )

    # --- DB Path Resolution ---
    resolved = resolve_db_path()

    if resolved is None:
        st.error(
            "**Database not found.**\n\n"
            "MeMesh database was not found at:\n"
            "- `~/.memesh/knowledge-graph.db`\n"
            "- `~/.claude-code-buddy/knowledge-graph.db`\n\n"
            "**Setup:** Install and run MeMesh first:\n"
            "```bash\n"
            "npm install -g @pcircle/memesh\n"
            "memesh setup\n"
            "```"
        )
        st.stop()

    if resolved.is_legacy:
        st.info(
            "📦 Using legacy path `~/.claude-code-buddy/`. "
            "Run `./scripts/migrate-from-ccb.sh` to migrate to `~/.memesh/`."
        )

    # --- Get DB Connection ---
    try:
        conn = get_connection(resolved.db_path)
    except Exception as e:
        st.error(
            f"**Failed to connect to database.**\n\n"
            f"`{resolved.db_path}`\n\nError: {e}"
        )
        st.stop()

    # FTS5 availability notice
    if not is_fts5_available(conn):
        st.sidebar.info("ℹ️ FTS5 not available. Using basic text search.")

    # --- Sidebar Navigation ---
    st.sidebar.title("🧠 MeMesh")
    page = st.sidebar.radio(
        "Navigation",
        ["Dashboard", "KG Explorer"],
        label_visibility="collapsed",
    )

    # --- Page Routing ---
    if page == "Dashboard":
        from pages.dashboard import render_dashboard
        render_dashboard(conn)
    else:
        from pages.explorer import render_explorer
        render_explorer(conn)


if __name__ == "__main__":
    main()
