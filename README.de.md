<div align="center">

<img src="https://img.shields.io/badge/%F0%9F%A7%A0-MeMesh-blueviolet?style=for-the-badge" alt="MeMesh" />

# MeMesh Plugin

### Deine KI-Coding-Sitzungen verdienen ein Gedächtnis.

MeMesh Plugin gibt Claude Code ein persistentes, durchsuchbares Gedächtnis — damit jede Sitzung auf der vorherigen aufbaut.

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@pcircle/memesh)
[![Downloads](https://img.shields.io/npm/dm/@pcircle/memesh?style=flat-square&color=blue)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple?style=flat-square)](https://modelcontextprotocol.io)

```bash
npm install -g @pcircle/memesh
```

[Loslegen](#loslegen) · [So funktioniert es](#so-funktioniert-es) · [Befehle](#befehle) · [Dokumentation](docs/USER_GUIDE.md)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · **Deutsch** · [Español](README.es.md) · [Tiếng Việt](README.vi.md) · [ภาษาไทย](README.th.md) · [Bahasa Indonesia](README.id.md)

</div>

> **Hinweis**: Dieses Projekt hieß ursprünglich „Claude Code Buddy" und wurde in MeMesh Plugin umbenannt, um mögliche Markenrechtsprobleme zu vermeiden.

---

## Das Problem

Du steckst mitten in einem Projekt mit Claude Code. Vor drei Sitzungen hast du wichtige Entscheidungen getroffen — welche Auth-Bibliothek, warum dieses Datenbankschema, welche Muster zu verwenden sind. Aber Claude erinnert sich nicht. Du wiederholst dich. Der Kontext geht verloren. Du verschwendest Zeit.

**MeMesh löst das.** Es gibt Claude ein persistentes, durchsuchbares Gedächtnis, das mit deinem Projekt wächst.

---

## So funktioniert es

<table>
<tr>
<td width="50%">

### Vor MeMesh
```
Sitzung 1: "Verwende JWT für Auth"
Sitzung 2: "Warum haben wir JWT gewählt?"
Sitzung 3: "Moment, welche Auth-Bibliothek nutzen wir?"
```
Du wiederholst Entscheidungen. Claude vergisst den Kontext. Der Fortschritt stockt.

</td>
<td width="50%">

### Nach MeMesh
```
Sitzung 1: "Verwende JWT für Auth" → gespeichert
Sitzung 2: buddy-remember "auth" → sofortiger Abruf
Sitzung 3: Kontext wird beim Start automatisch geladen
```
Jede Sitzung knüpft dort an, wo du aufgehört hast.

</td>
</tr>
</table>

---

## Was du bekommst

**Durchsuchbares Projektgedächtnis** — Frage „Was haben wir über Auth entschieden?" und erhalte sofort eine semantisch abgeglichene Antwort. Keine Stichwortsuche — *Bedeutungssuche*, angetrieben durch lokale ONNX-Embeddings.

**Intelligente Aufgabenanalyse** — `buddy-do "Benutzer-Auth hinzufügen"` führt nicht einfach aus. Es zieht relevanten Kontext aus vergangenen Sitzungen, prüft welche Muster du etabliert hast und erstellt einen angereicherten Plan, bevor eine einzige Zeile geschrieben wird.

**Proaktiver Abruf** — MeMesh ruft automatisch relevante Erinnerungen ab, wenn du eine Sitzung startest, ein Test fehlschlägt oder ein Fehler auftritt. Kein manuelles Suchen nötig.

**Workflow-Automatisierung** — Sitzungszusammenfassungen beim Start. Verfolgung von Dateiänderungen. Code-Review-Erinnerungen vor Commits. Alles läuft leise im Hintergrund.

**Aus Fehlern lernen** — Fehler und Korrekturen aufzeichnen, um eine Wissensbasis aufzubauen. Derselbe Fehler passiert nicht zweimal.

---

## Loslegen

**Voraussetzungen**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) + Node.js 20+

```bash
npm install -g @pcircle/memesh
```

Claude Code neu starten. Das war's.

**Überprüfen** — tippe in Claude Code:

```
buddy-help
```

Du solltest eine Liste der verfügbaren Befehle sehen.

<details>
<summary><strong>Aus dem Quellcode installieren</strong> (für Mitwirkende)</summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

</details>

---

## Befehle

| Befehl | Was er tut |
|--------|-----------|
| `buddy-do "Aufgabe"` | Aufgabe mit vollem Gedächtniskontext ausführen |
| `buddy-remember "Thema"` | Vergangene Entscheidungen und Kontext durchsuchen |
| `buddy-help` | Verfügbare Befehle anzeigen |

**Praxisbeispiele:**

```bash
# Sich in einer neuen Codebase orientieren
buddy-do "explain this codebase"

# Features mit Kontext aus vergangener Arbeit bauen
buddy-do "add user authentication"

# Nachvollziehen, warum Entscheidungen getroffen wurden
buddy-remember "API design decisions"
buddy-remember "why we chose PostgreSQL"
```

Alle Daten bleiben auf deinem Rechner mit automatischer 90-Tage-Aufbewahrung.

---

## Wie unterscheidet sich das von CLAUDE.md?

| | CLAUDE.md | MeMesh |
|---|-----------|--------|
| **Zweck** | Statische Anweisungen für Claude | Lebendiges Gedächtnis, das mit deinem Projekt wächst |
| **Suche** | Manuelle Textsuche | Semantische Suche nach Bedeutung |
| **Aktualisierung** | Du bearbeitest manuell | Erfasst Entscheidungen automatisch während der Arbeit |
| **Abruf** | Wird immer geladen (kann lang werden) | Zeigt relevanten Kontext bei Bedarf |
| **Umfang** | Allgemeine Präferenzen | Projektspezifischer Wissensgraph |

**Sie ergänzen sich.** CLAUDE.md sagt Claude, *wie* er arbeiten soll. MeMesh erinnert sich daran, *was* ihr gebaut habt.

---

## Plattformunterstützung

| Plattform | Status |
|-----------|--------|
| macOS | ✅ |
| Linux | ✅ |
| Windows | ✅ (WSL2 empfohlen) |

**Funktioniert mit:** Claude Code CLI · VS Code Extension · Cursor (via MCP) · Jeder MCP-kompatible Editor

---

## Architektur

MeMesh läuft als Claude Code Plugin lokal mit integrierter MCP-Komponente:

- **Knowledge Graph** — SQLite-basierter Entity-Speicher mit FTS5-Volltextsuche
- **Vector Embeddings** — ONNX Runtime für semantische Ähnlichkeit (läuft 100% lokal)
- **Content Dedup** — SHA-256-Hashing überspringt redundante Embedding-Berechnungen
- **Batch Processing** — Effiziente Massenoperationen für große Wissensbasen
- **Hook System** — Proaktiver Abruf bei Sitzungsstart, Testfehlern und Fehlern

Alles läuft lokal. Keine Cloud. Keine API-Aufrufe. Deine Daten verlassen nie deinen Rechner.

---

## Dokumentation

| Dokument | Beschreibung |
|----------|-------------|
| [Erste Schritte](docs/GETTING_STARTED.md) | Schritt-für-Schritt-Einrichtungsanleitung |
| [Benutzerhandbuch](docs/USER_GUIDE.md) | Vollständige Anleitung mit Beispielen |
| [Befehle](docs/COMMANDS.md) | Komplette Befehlsreferenz |
| [Architektur](docs/ARCHITECTURE.md) | Technischer Tiefgang |
| [Mitwirken](CONTRIBUTING.md) | Richtlinien für Beiträge |
| [Entwicklung](docs/DEVELOPMENT.md) | Entwicklungsumgebung für Mitwirkende |

---

## Mitwirken

Beiträge sind willkommen! Siehe [CONTRIBUTING.md](CONTRIBUTING.md) für den Einstieg.

---

## Lizenz

MIT — Siehe [LICENSE](LICENSE)

---

<div align="center">

**Gebaut mit Claude Code, für Claude Code.**

[Bug melden](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=bug&template=bug_report.yml) · [Feature anfragen](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions) · [Hilfe erhalten](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new)

</div>
