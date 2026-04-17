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

## Das Problem

Deine KI vergisst zwischen Sessions alles. Jede Entscheidung, jeder Bugfix, jede Erkenntnis — weg. Du erklärst denselben Kontext immer wieder, Claude entdeckt dieselben Muster erneut, und das KI-Wissen deines Teams wird jedes Mal auf null zurückgesetzt.

**MeMesh gibt jeder KI ein dauerhaftes, durchsuchbares und sich weiterentwickelndes Gedächtnis.**

---

## In 60 Sekunden Loslegen

### Schritt 1: Installieren

```bash
npm install -g @pcircle/memesh
```

### Schritt 2: Deine KI erinnert sich

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### Schritt 3: Deine KI ruft ab

```bash
memesh recall "login security"
# → Findet "OAuth 2.0 with PKCE", obwohl du andere Wörter verwendet hast
```

**Das war's.** MeMesh erinnert und ruft nun über Sessions hinweg ab.

Öffne das Dashboard, um dein Gedächtnis zu erkunden:

```bash
memesh
```

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh Search — finde jede Erinnerung sofort" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics — verstehe das Wissen deiner KI" width="100%" />
</p>

---

## Für Wen ist Das?

| Wenn du... | hilft dir MeMesh... |
|---------------|---------------------|
| **Entwickler der Claude Code nutzt** | Entscheidungen, Muster und Erkenntnisse sitzungsübergreifend automatisch zu merken |
| **Team, das mit LLMs entwickelt** | Team-Wissen per Export/Import zu teilen und den KI-Kontext aller synchron zu halten |
| **KI-Agent-Entwickler** | Deinen Agenten über MCP, HTTP API oder Python SDK dauerhaftes Gedächtnis zu geben |
| **Power-User mit mehreren KI-Tools** | Eine Gedächtnisschicht für Claude, GPT, LLaMA, Ollama oder jeden MCP-Client |

---

## Funktioniert mit Allem

<table>
<tr>
<td width="33%" align="center">

**Claude Code / Desktop**
```bash
memesh-mcp
```
MCP-Protokoll (automatisch konfiguriert)

</td>
<td width="33%" align="center">

**Python / LangChain**
```python
from memesh import MeMesh
m = MeMesh()
m.recall("auth")
```
`pip install memesh`

</td>
<td width="33%" align="center">

**Beliebige LLMs (OpenAI-Format)**
```bash
memesh export-schema \
  --format openai
```
Tools in jeden API-Aufruf einfügen

</td>
</tr>
</table>

---

## Warum Nicht Einfach Mem0 / Zep?

| | **MeMesh** | Mem0 | Zep |
|---|---|---|---|
| **Installationszeit** | 5 Sekunden | 30–60 Minuten | 30+ Minuten |
| **Einrichtung** | `npm i -g` — fertig | Neo4j + VectorDB + API-Schlüssel | Neo4j + Konfiguration |
| **Speicherung** | Einzelne SQLite-Datei | Neo4j + Qdrant | Neo4j |
| **Offline nutzbar** | Ja, immer | Nein | Nein |
| **Dashboard** | Integriert (5 Tabs) | Keins | Keins |
| **Abhängigkeiten** | 6 | 20+ | 10+ |
| **Preis** | Dauerhaft kostenlos | Kostenlose Stufe / Kostenpflichtig | Kostenlose Stufe / Kostenpflichtig |

**MeMesh tauscht:** Enterprise-Multi-Tenant-Funktionen gegen **sofortige Einrichtung, kein Infrastrukturaufwand und 100 % Datenschutz**.

---

## Was Automatisch Passiert

Du musst nicht alles manuell merken. MeMesh hat **4 Hooks**, die Wissen erfassen, ohne dass du etwas tun musst:

| Wann | Was MeMesh tut |
|------|------------------|
| **Zu Beginn jeder Session** | Lädt deine relevantesten Erinnerungen (nach Scoring-Algorithmus gerankt) |
| **Nach jedem `git commit`** | Erfasst was du geändert hast, mit Diff-Statistiken |
| **Wenn Claude beendet** | Erfasst bearbeitete Dateien, behobene Fehler und getroffene Entscheidungen |
| **Vor der Kontextkomprimierung** | Sichert Wissen, bevor es durch Kontextgrenzen verloren geht |

> **Jederzeit deaktivierbar:** `export MEMESH_AUTO_CAPTURE=false`

---

## Intelligente Funktionen

**🧠 Smart Search** — Suche nach „login security" und finde Erinnerungen über „OAuth PKCE". MeMesh erweitert Suchanfragen mit verwandten Begriffen über das konfigurierte LLM.

**📊 Scored Ranking** — Ergebnisse gerankt nach Relevanz (35 %) + letzter Nutzung (25 %) + Häufigkeit (20 %) + Vertrauen (15 %) + ob die Info noch aktuell ist (5 %).

**🔄 Wissensentwicklung** — Entscheidungen ändern sich. `forget` archiviert alte Erinnerungen (löscht nie). `supersedes`-Beziehungen verknüpfen Alt mit Neu. Deine KI sieht immer die neueste Version.

**⚠️ Konflikterkennung** — Wenn zwei Erinnerungen sich widersprechen, warnt MeMesh dich.

**📦 Team-Sharing** — `memesh export > team-knowledge.json` → mit Team teilen → `memesh import team-knowledge.json`

---

## Smart Mode Freischalten (Optional)

MeMesh funktioniert standardmäßig vollständig offline. Füge einen LLM-API-Schlüssel hinzu, um intelligentere Suche zu aktivieren:

```bash
memesh config set llm.provider anthropic
memesh config set llm.api-key sk-ant-...
```

Oder verwende den Einstellungs-Tab im Dashboard (visuelle Einrichtung):

```bash
memesh  # öffnet Dashboard → Einstellungs-Tab
```

| | Level 0 (Standard) | Level 1 (Smart Mode) |
|---|---|---|
| **Suche** | FTS5 Keyword-Matching | + LLM-Anfrageerweiterung (~97 % Recall) |
| **Auto-Erfassung** — | Regelbasierte Muster | + LLM extrahiert Entscheidungen & Erkenntnisse |
| **Komprimierung** | Nicht verfügbar | `consolidate` komprimiert ausführliche Erinnerungen |
| **Kosten** | Kostenlos, kein API-Schlüssel | ~0,0001 $ pro Suche (Haiku) |

---

## Alle 6 Gedächtnis-Tools

| Tool | Funktion |
|------|-------------|
| `remember` | Speichert Wissen mit Beobachtungen, Beziehungen und Tags |
| `recall` | Intelligente Suche mit Multi-Faktor-Scoring und LLM-Anfrageerweiterung |
| `forget` | Soft-Archivierung (kein Löschen) oder Entfernen spezifischer Beobachtungen |
| `consolidate` | LLM-gestützte Komprimierung ausführlicher Erinnerungen |
| `export` | Teilt Erinnerungen als JSON zwischen Projekten oder Teammitgliedern |
| `import` | Importiert Erinnerungen mit Zusammenführungsstrategien (überspringen / überschreiben / anhängen) |

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

Der Kern ist framework-unabhängig. Dieselbe Logik läuft vom Terminal, HTTP oder MCP aus.

---

## Mitwirken

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory && npm install && npm run build
npm test -- --run    # 289 tests
```

Dashboard: `cd dashboard && npm install && npm run dev`

---

<p align="center">
  <strong>MIT</strong> — Erstellt von <a href="https://pcircle.ai">PCIRCLE AI</a>
</p>
