🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [Deutsch](README.de.md)

<p align="center">
  <h1 align="center">MeMesh</h1>
  <p align="center">
    <strong>Ein Gedächtnis für deinen KI-Coding-Assistenten, das von Sitzung zu Sitzung bleibt.</strong><br />
    Eine SQLite-Datei. Kein Docker, keine Cloud.
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@pcircle/memesh"><img src="https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=3b82f6&label=npm" alt="npm" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="MIT" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.13.0-22c55e?style=flat-square" alt="Node" /></a>
    <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-a855f7?style=flat-square" alt="MCP" /></a>
  </p>
</p>

---

## Was es tut

Mit jeder neuen Sitzung fängt dein KI-Coding-Assistent (Agent) bei null an. Er schlägt wieder den Ansatz vor, den du letzten Monat verworfen hast, scheitert wieder am selben Test und lässt sich die Architektur erklären, die er selbst mit entworfen hat.

MeMesh merkt sich das für ihn. Entscheidungen, Lektionen und der letzte Arbeitsstand werden während der Arbeit festgehalten und dem Agenten im richtigen Moment wieder vorgelegt. Funktioniert mit Claude Code, Codex, Cursor und jedem lokalen Tool, das MCP spricht.

```
   du arbeitest mit dem Agenten
            |
            v
   +------------------+      +------------------+
   |  festhalten      |      |  erinnern        |
   |  Sitzungen,      | ---> |  beim Start und  |
   |  Commits, Fixes  |      |  vor jeder       |
   |  (automatisch)   |      |  Änderung        |
   +------------------+      +------------------+
            |                         ^
            v                         |
   +----------------------------------------+
   |  ~/.memesh/knowledge-graph.db           |
   |  Entscheidungen, Lektionen, Verweise    |
   +----------------------------------------+
```

- **Nichts von Hand notieren.** In Claude Code übernehmen **9 Hooks** das Festhalten und Erinnern: beim Sitzungsstart, vor Dateiänderungen, nach `git commit`, wenn Claude aufhört, vor dem Kürzen des Kontexts, wenn du „merk dir das“ sagst (in 5 Sprachen) und vor einem riskanten Befehl, der einen bekannten Fehler wiederholen würde.
- **Ein Gedächtnis für alle Tools.** Was du heute in Claude Code speicherst, findet morgen auch Codex oder Cursor.
- **Agenten können sich Nachrichten hinterlassen.** Ein Posteingang auf deinem Rechner, der auch nach einem Neustart nichts verliert.
- **Ein Dashboard** zum Stöbern: 5 Tabs, 11 Sprachen, unter `http://localhost:3737/dashboard`.

---

## Läuft mit

| Plattform | Anbindung | Hinweis |
|---|---|---|
| Claude Code | Plugin: Hooks, MCP-Tools, `/memesh`-Skill | Automatisches Festhalten und Erinnern |
| Codex CLI, Gemini CLI | MCP-Server (`memesh-mcp`) | `codex mcp add memesh -- memesh-mcp`, `gemini mcp add -s user memesh memesh-mcp` |
| Cursor, Cline und andere MCP-Clients | MCP-Server (`memesh-mcp`) | Client auf `memesh-mcp` zeigen lassen |
| Hermes Agent | Natives Memory-Provider-Plugin | [docs/platforms/hermes-agent.md](docs/platforms/hermes-agent.md) |
| OpenClaw | Natives Memory-Plugin | Nur Quellcode, noch nicht veröffentlicht: [docs/platforms/openclaw.md](docs/platforms/openclaw.md) |
| Eigene Skripte und Apps | HTTP-API aus `memesh serve` | [docs/platforms/universal.md](docs/platforms/universal.md) |
| ChatGPT, Gemini im Browser und andere gehostete Chats | HTTP-API über eine lokale Brücke, die du selbst betreibst | [docs/platforms/README.md](docs/platforms/README.md) |

Optionale KI-Modelle für die Extras (automatische Schlagwörter, Lektionen aus Fehlschlägen, Widerspruchsprüfung): Anthropic, OpenAI oder ein lokales Ollama. Optionale Suche nach Bedeutung: Embeddings von Ollama oder OpenAI. Ohne all das läuft alles oben weiterhin mit Stichwortsuche.

---

## Installation

Es gibt zwei Wege. Beide nutzen dieselbe Datenbank und kommen sich nicht in die Quere. Wer Claude Code nutzt, installiert meist beide.

```
   Claude-Code-Chat                Terminal, Codex, Cursor
         |                                  |
         v                                  v
   +-----------------+              +------------------+
   | A: Plugin       |              | B: npm global    |
   | /plugin install |              | npm install -g   |
   | Hooks + Tools   |              | memesh-Befehl    |
   | + /memesh-Skill |              | + memesh-mcp     |
   +-----------------+              +------------------+
         |                                  |
         +---------------+------------------+
                         v
            ~/.memesh/knowledge-graph.db
               (eine Datei, beide Wege)
```

**A. Direkt in Claude Code** (Hooks, Tools und der `/memesh`-Skill werden automatisch eingerichtet):

```
/plugin marketplace add PCIRCLE-AI/memesh
/plugin install memesh@pcircle-memesh
```

Claude Code neu starten. Beim nächsten Start steht `◉ MeMesh` ganz oben.

**B. Im Terminal** (braucht [Node 22.13 oder neuer](https://nodejs.org)):

```bash
npm install -g @pcircle/memesh
memesh doctor          # prüft, ob alles richtig installiert ist
memesh install-hooks   # nur ohne A nötig: richtet Claude Code ein, deine eigenen Hooks bleiben
```

Codex: `codex mcp add memesh -- memesh-mcp`. Cursor: `{ "mcpServers": { "memesh": { "command": "memesh-mcp" } } }` in `~/.cursor/mcp.json` eintragen.

> **Das Plugin bringt keinen `memesh`-Befehl mit.** Nach `/plugin install` meldet das Terminal bei `memesh` noch `command not found`, bis du auch `npm install -g @pcircle/memesh` ausführst. Wer MeMesh nur im Claude-Code-Chat nutzt, kommt mit A aus.

**Aktualisieren:** `memesh upgrade-plugin` für das Plugin, `memesh update` für die npm-Installation. **Soll eine KI die Installation übernehmen?** Gib ihr [llms-install.md](llms-install.md).

---

## Loslegen

```bash
memesh remember "Für den neuen Login OAuth 2.0 mit PKCE verwenden"
memesh recall "Login-Sicherheit"
# -> findet die PKCE-Entscheidung, obwohl du andere Wörter benutzt hast

memesh briefing        # was der Agent über dieses Projekt weiß und wo du aufgehört hast
memesh serve           # Dashboard öffnen
```

In Claude Code brauchst du nicht einmal das Terminal: Sag im Chat „merk dir das“, und das Briefing kommt bei jedem Sitzungsstart von selbst.

Zwei Dinge, die du kennen solltest, sobald Erinnerungen da sind:

- `forget` archiviert eine Erinnerung, statt sie zu löschen. Eine neuere Erinnerung kann eine ältere ablösen.
- `memesh dream conflicts` (braucht ein KI-Modell) findet zwei Erinnerungen, die nicht beide stimmen können. Du bestätigst, und jeder spätere `recall` einer der beiden trägt eine Warnung.

Alle Befehle und Tools: [docs/api/API_REFERENCE.md](docs/api/API_REFERENCE.md). Aufbau: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Mitmachen: [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Alle 11 Memory- und Koordinations-Tools

| Tool | Was es tut |
|------|-------------|
| `remember` | Wissen mit Beobachtungen, Relationen und Tags speichern |
| `recall` | FTS5 + sqlite-vec Suche mit Multi-Faktor-Bewertung (Relevanz, Aktualität, Häufigkeit, Konfidenz, Abruf-Auswirkung) — kein LLM auf dem Hot Path |
| `forget` | Soft-Archivierung (löscht nie) oder entfernt spezifische Beobachtungen |
| `export` | Memories als JSON sichern, migrieren oder zwischen kompatiblen Agenten übertragen |
| `import` | Memories mit Merge-Strategien importieren (Skip / Overwrite / Append) |
| `learn` | Strukturierte Lektionen aus Fehlern erfassen (Fehler, Grundursache, Behebung, Prävention) |
| `task_state` | Arbeitsstand lesen oder festhalten — Ziel, nächster Schritt, Blocker, gerade Erledigtes |
| `briefing` | Die Arbeitstopologie für jeden MCP-Client; allgemeiner Kontext bleibt still, während exakte Angaben für `project` + `recipient` nur dessen noch nicht abgerufene Zustellungen anzeigen |
| `user_patterns` | Arbeitsmuster analysieren — Zeitplan, Tools, Stärken, Lernbereiche |
| `improvement` | Evidenzverknüpfte Produktverbesserung zur menschlichen Prüfung vorschlagen oder ihren Status lesen; Agenten können sie nicht selbst annehmen oder ablehnen |
| `message` | Aktive Agenten finden und nicht vertrauenswürdige Nachrichten mit exaktem Empfänger austauschen. Dauerhafter JSON-Payload: max. 64 KiB; vollständiger nativer Envelope: max. 16 KiB mit getrennten Fehlern `native_message_too_large` und `recipient_unavailable`. Native Annahme, Discovery, Poll und Fetch bedeuten weder Bestätigung noch Workflow-Status |

---

## Das Kleingedruckte

**Bewertete Reihenfolge** — Ergebnisse sortiert nach Relevanz (30%) + Aktualität (25%) + Häufigkeit (18%) + Konfidenz (17%) + Abruf-Wirkung (10%).

**Agenten-Nachrichten, die genauen Regeln** (ausführlich: [docs/platforms/agent-messaging.md](docs/platforms/agent-messaging.md)):

- Heute verfügbar: Ein Sender über MCP, HTTP oder CLI kann einen nicht vertrauenswürdigen, JSON-kodierten Payload von höchstens 65.536 UTF-8-Bytes (64 KiB) dauerhaft an genau einen lokalen Empfänger senden. Der Empfänger kann ihn getrennt abrufen, nach einem Neustart mit einem opaken Cursor fortsetzen und Intake, Bestätigung, Workflow-Status und Host-Aktivierung getrennt protokollieren.
- Mit aktiviertem MeMesh-Codex-Plugin und dem owner-private Opt-in `memesh agent setup codex-session` erhält die exakt aktive Codex-Session eine vollständige Nachricht über ihre native Queue — ohne Polling oder menschliche Erinnerung und ohne zweiten Inbox-Abruf. Der vollständige native Envelope einschließlich Routing-Metadaten und Payload ist separat auf 16.384 Bytes (16 KiB) begrenzt. Ein Exact-Session-Send ist erst erfolgreich, wenn die native Queue ihn annimmt; ein zu großer Envelope meldet `native_message_too_large`, andere nicht verfügbare oder abgelehnte Sessions melden `recipient_unavailable`. Eingegrenzte Recovery-Daten bleiben erhalten, und Principal-Ziele behalten Durable Store-and-Forward bei.
- Eine gestoppte, fehlende oder getrennte Codex-Session wird weder geweckt noch ersetzt. Ihr Posteingang bleibt bestehen; `memesh message storage report` zeigt, was gespeichert ist. Direktes Wecken gibt es nur unter macOS und Linux.

---

<p align="center"><strong>MIT-Lizenz</strong></p>
