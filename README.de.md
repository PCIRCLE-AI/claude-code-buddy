🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>Die leichteste universelle KI-Gedächtnisschicht.</strong><br />
    Eine SQLite-Datei. Jedes LLM. Kein Cloud-Dienst.
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@pcircle/memesh"><img src="https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=3b82f6&label=npm" alt="npm" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="MIT" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-22c55e?style=flat-square" alt="Node" /></a>
    <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-a855f7?style=flat-square" alt="MCP" /></a>
    <a href="https://pypi.org/project/memesh/"><img src="https://img.shields.io/badge/pip-memesh-3b82f6?style=flat-square" alt="PyPI" /></a>
  </p>
</p>

---

Deine KI vergisst zwischen Sessions alles. **MeMesh löst dieses Problem.**

Einmal installieren, in 30 Sekunden konfigurieren, und jedes KI-Tool das du verwendest — Claude, GPT, LLaMA oder ein beliebiger MCP-Client — erhält dauerhaftes, durchsuchbares und sich weiterentwickelndes Gedächtnis. Kein Cloud-Dienst. Kein Neo4j. Keine Vektordatenbank. Nur eine SQLite-Datei.

```bash
npm install -g @pcircle/memesh
```

---

## Dashboard

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh Search" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-browse.png" alt="MeMesh Browse" width="100%" />
</p>

Starte `memesh`, um das interaktive Dashboard mit Suche, Durchsuchen, Analyse, Verwaltung und Einstellungen zu öffnen.

---

## Schnellstart

```bash
# Eine Erinnerung speichern
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"

# Erinnerungen suchen (im Smart-Modus findet "login security" auch "OAuth")
memesh recall "login security"

# Veraltete Erinnerungen archivieren (Soft-Delete — nichts geht verloren)
memesh forget --name "old-auth-design"

# Dashboard öffnen
memesh

# HTTP API starten (für Python SDK und Integrationen)
memesh serve
```

### Python

```python
from memesh import MeMesh

m = MeMesh()  # connects to localhost:3737
m.remember("auth", "decision", observations=["Use OAuth 2.0 with PKCE"])
results = m.recall("auth")
```

### Beliebige LLMs (OpenAI function calling Format)

```bash
memesh export-schema --format openai
# → JSON array of tools, paste into your OpenAI/Claude/Gemini API call
```

---

## Warum MeMesh?

Die meisten KI-Gedächtnislösungen benötigen Neo4j, Vektordatenbanken, API-Schlüssel und mehr als 30 Minuten Einrichtungszeit. MeMesh braucht **einen einzigen Befehl**.

| | **MeMesh** | Mem0 | Zep | Anthropic Memory |
|---|---|---|---|---|
| **Installation** | `npm i -g` (5 Sek.) | pip + Neo4j + VectorDB | pip + Neo4j | Integriert (Cloud) |
| **Speicherung** | Einzelne SQLite-Datei | Neo4j + Qdrant | Neo4j | Cloud |
| **Suche** | FTS5 + Scoring + LLM-Erweiterung | Semantisch + BM25 | Temporaler Graph | Schlüsselsuche |
| **Datenschutz** | 100% lokal, immer | Cloud-Option | Self-Hosting | Cloud |
| **Abhängigkeiten** | 6 | 20+ | 10+ | 0 (aber Cloud-gebunden) |
| **Offline** | Ja | Nein | Nein | Nein |
| **Dashboard** | Integriert (5 Tabs) | Keins | Keins | Keins |
| **Preis** | Kostenlos | Kostenlos/Kostenpflichtig | Kostenlos/Kostenpflichtig | In API enthalten |

---

## Funktionen

### 6 Gedächtnistools

| Tool | Funktion |
|------|-------------|
| **remember** | Speichert Wissen mit Beobachtungen, Beziehungen und Tags |
| **recall** | Intelligente Suche mit Multi-Faktor-Scoring und LLM-Anfrageerweiterung |
| **forget** | Soft-Archivierung (kein Löschen) oder Entfernen spezifischer Beobachtungen |
| **consolidate** | LLM-gestützte Komprimierung ausführlicher Erinnerungen |
| **export** | Teilt Erinnerungen als JSON zwischen Projekten oder Teammitgliedern |
| **import** | Importiert Erinnerungen mit Zusammenführungsstrategien (überspringen / überschreiben / anhängen) |

### 3 Zugriffsmethoden

| Methode | Befehl | Am besten für |
|--------|---------|----------|
| **CLI** | `memesh` | Terminal, Scripting, CI/CD |
| **HTTP API** | `memesh serve` | Python SDK, Dashboard, Integrationen |
| **MCP** | `memesh-mcp` | Claude Code, Claude Desktop, beliebige MCP-Clients |

### 4 automatische Erfassungs-Hooks

| Hook | Auslöser | Was erfasst wird |
|------|---------|-----------------|
| **Session Start** | Jede Session | Lädt die relevantesten Erinnerungen |
| **Post Commit** | Nach `git commit` | Speichert Commit mit Diff-Statistiken |
| **Session Summary** | Wenn Claude beendet | Bearbeitete Dateien, behobene Fehler, getroffene Entscheidungen |
| **Pre-Compact** | Vor der Kompaktierung | Sichert Wissen bevor der Kontext verloren geht |

### Intelligente Funktionen

- **Wissensentwicklung** — `forget` archiviert, löscht nicht. `supersedes`-Beziehungen ersetzen alte Entscheidungen durch neue. Die Geschichte bleibt erhalten.
- **Intelligentes Abrufen** — LLM erweitert deine Suchanfrage um verwandte Begriffe. "login security" findet "OAuth PKCE".
- **Multi-Faktor-Scoring** — Ergebnisse werden nach Relevanz (35%) + Aktualität (25%) + Häufigkeit (20%) + Vertrauen (15%) + zeitlicher Gültigkeit (5%) sortiert.
- **Konflikterkennnung** — Warnt, wenn Erinnerungen sich widersprechen.
- **Automatischer Verfall** — Veraltete Erinnerungen (30+ Tage ungenutzt) sinken langsam im Ranking. Niemals gelöscht.
- **Namensräume** — `personal`, `team`, `global` Bereiche zum Organisieren und Teilen.

---

## Architektur

```
                    ┌─────────────────┐
                    │   Core Engine   │
                    │  (6 operations) │
                    └────────┬────────┘
           ┌─────────────────┼─────────────────┐
           │                 │                 │
     CLI (memesh)    HTTP API (serve)    MCP (memesh-mcp)
           │                 │                 │
           └─────────────────┼─────────────────┘
                             │
                    SQLite + FTS5 + sqlite-vec
                    (~/.memesh/knowledge-graph.db)
```

Der **Kern** ist framework-unabhängig — dieselbe `remember`/`recall`/`forget`-Logik läuft identisch, egal ob sie vom Terminal, HTTP oder MCP aufgerufen wird.

**Abhängigkeiten**: `better-sqlite3`, `sqlite-vec`, `@modelcontextprotocol/sdk`, `zod`, `express`, `commander`

---

## Entwicklung

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory
npm install
npm run build
npm test -- --run    # 289 tests
```

Dashboard-Entwicklung:
```bash
cd dashboard
npm install
npm run dev          # Vite dev server with hot reload
npm run build        # Build to single HTML file
```

---

## Lizenz

MIT — [PCIRCLE AI](https://pcircle.ai)
