<div align="center">

# 🧠 MeMesh Plugin

### Produktivitäts-Plugin für Claude Code

Speicher, intelligente Aufgabenanalyse und Workflow-Automatisierung — in einem Plugin.

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io)

[Installation](#installation) • [Verwendung](#verwendung) • [Fehlerbehebung](#fehlerbehebung)

[English](README.md) • [繁體中文](README.zh-TW.md) • [简体中文](README.zh-CN.md) • [日本語](README.ja.md) • [한국어](README.ko.md) • [Français](README.fr.md) • **Deutsch** • [Español](README.es.md) • [Tiếng Việt](README.vi.md) • [ภาษาไทย](README.th.md) • [Bahasa Indonesia](README.id.md)

</div>

---

## Warum dieses Projekt existiert

Dieses Projekt entstand, weil ich mehr Menschen helfen wollte — besonders Programmier-Einsteigern — das Beste aus Claude Code fürs Vibe Coding herauszuholen. Mir ist aufgefallen: Wenn Projekte wachsen, wird es schwer, alle Entscheidungen über Sitzungen hinweg nachzuverfolgen. Also habe ich ein Plugin gebaut (mit Claude Code natürlich), das sich für euch erinnert.

> **Hinweis**: Dieses Projekt hieß ursprünglich „Claude Code Buddy" und wurde in MeMesh Plugin umbenannt, um mögliche Markenrechtsprobleme zu vermeiden.

## Was kann es?

MeMesh Plugin macht Claude Code schlauer und produktiver. Es ist nicht nur ein Speicher — es ist ein komplettes Toolkit:

**Durchsuchbarer Projektspeicher** — Entscheidungen, Muster und Lektionen werden automatisch gespeichert. Suche nach Bedeutung, nicht nur Schlüsselwörtern. Fragt „Warum haben wir PostgreSQL gewählt?" und bekommt sofort Antworten.

**Intelligente Aufgabenanalyse** — Bei `buddy-do "Authentifizierung hinzufügen"` analysiert MeMesh die Aufgabe, zieht relevanten Kontext aus vergangener Arbeit und liefert einen angereicherten Plan vor der Ausführung.

**Workflow-Automatisierung** — MeMesh arbeitet im Hintergrund automatisch:
- Zeigt beim Sitzungsstart eine Zusammenfassung der letzten Arbeit
- Verfolgt geänderte und getestete Dateien
- Erinnert vor dem Commit an Code-Review
- Routet Aufgaben zum optimalen Modell

**Aus Fehlern lernen** — Fehler und Korrekturen aufzeichnen, um eine Wissensbasis aufzubauen und wiederholte Fehler zu vermeiden.

**Wie unterscheidet sich das vom eingebauten Gedächtnis von Claude?**

Claude Code hat bereits Auto Memory und CLAUDE.md — super für allgemeine Einstellungen. MeMesh fügt projektbezogene **dedizierte Tools** hinzu: bedeutungsbasiert durchsuchbarer Speicher, Aufgabenanalyse mit vergangenem Kontext und automatisierte Workflows, die jede Sitzung produktiver machen.

So kann man es sich vorstellen:
- **CLAUDE.md** = eure Bedienungsanleitung für Claude
- **MeMesh** = durchsuchbares Notizbuch + intelligenter Assistent, der mit eurem Projekt wächst

---

## Installation

**Ihr braucht**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) und Node.js 20+

```bash
npm install -g @pcircle/memesh
```

Claude Code neu starten. Fertig.

**Funktioniert es?** — Tippt das in Claude Code ein:

```
buddy-help
```

Ihr solltet eine Liste von Befehlen sehen.

<details>
<summary>Aus dem Quellcode installieren (für Mitwirkende)</summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

</details>

---

## Verwendung

MeMesh fügt 3 Befehle zu Claude Code hinzu:

| Befehl | Funktion |
|--------|----------|
| `buddy-do "Aufgabe"` | Aufgabe mit Speicherkontext ausführen |
| `buddy-remember "Thema"` | Vergangene Entscheidungen und Kontext suchen |
| `buddy-help` | Verfügbare Befehle anzeigen |

**Beispiele:**

```bash
buddy-do "erkläre diese Codebase"
buddy-do "füge Benutzerauthentifizierung hinzu"
buddy-remember "API-Design-Entscheidungen"
buddy-remember "warum haben wir PostgreSQL gewählt"
```

Alle Daten werden lokal auf eurem Rechner gespeichert. Entscheidungen werden 90 Tage aufbewahrt, Sitzungsnotizen 30 Tage.

---

## Unterstützte Plattformen

| Plattform | Status |
|-----------|--------|
| **macOS** | ✅ Funktioniert |
| **Linux** | ✅ Funktioniert |
| **Windows** | ✅ Funktioniert (WSL2 empfohlen) |

**Kompatibel mit:**
- Claude Code CLI (Terminal)
- Claude Code VS Code Extension
- Cursor (über MCP)
- Andere MCP-kompatible Editoren

**Claude Desktop (Cowork)**: Grundbefehle funktionieren, aber Speicherfunktionen benötigen die CLI-Version. Siehe [Cowork-Details](docs/COWORK_SUPPORT.md).

---

## Fehlerbehebung

**MeMesh erscheint nicht?**

```bash
# Installation prüfen
npm list -g @pcircle/memesh

# Node.js-Version prüfen (20+ benötigt)
node --version

# Setup erneut ausführen
memesh setup
```

Dann Claude Code vollständig neu starten.

Weitere Hilfe: [Fehlerbehebungsanleitung](docs/TROUBLESHOOTING.md)

---

## Mehr erfahren

- **[Erste Schritte](docs/GETTING_STARTED.md)** — Schritt-für-Schritt-Einrichtung
- **[Benutzerhandbuch](docs/USER_GUIDE.md)** — Vollständige Anleitung mit Beispielen
- **[Befehle](docs/COMMANDS.md)** — Alle verfügbaren Befehle
- **[Architektur](docs/ARCHITECTURE.md)** — Wie es unter der Haube funktioniert
- **[Mitwirken](CONTRIBUTING.md)** — Helfen? Hier starten
- **[Entwicklungsanleitung](docs/DEVELOPMENT.md)** — Für Mitwirkende

---

## Lizenz

MIT — Siehe [LICENSE](LICENSE)

---

<div align="center">

Etwas funktioniert nicht? [Issue eröffnen](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new) — wir antworten schnell.

[Bug melden](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=bug&template=bug_report.yml) • [Feature anfragen](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions)

</div>
