🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>Die lokale Memory-Schicht für Claude Code und MCP-kompatible Coding Agents.</strong><br />
    Eine SQLite-Datei. Kein Docker. Keine Cloud erforderlich.
  </p>
</p>

> Dieses deutsche README ist eine kompakte Übersicht. Für die vollständige und aktuellste Dokumentation gilt das [English README](README.md) als Referenz.

## Welches Problem löst es?

Coding Agents verlieren zwischen Sessions schnell den Zusammenhang. Architekturentscheidungen, frühere Bugfixes, gewonnene Erkenntnisse und Projektrahmenbedingungen müssen deshalb immer wieder neu erklärt werden.

**MeMesh hält dieses Wissen lokal fest, macht es durchsuchbar und bringt es später wieder in den Arbeitsfluss zurück.**

Dieses npm-Paket ist die lokale Plugin- / Package-Version von MeMesh. Es ist weder das Cloud-Workspace-Produkt noch eine vollständige Enterprise-Plattform.

## In 60 Sekunden starten

### 1. Installieren

```bash
npm install -g @pcircle/memesh
```

### 2. Eine Entscheidung speichern

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### 3. Später wiederfinden

```bash
memesh recall "login security"
# → findet "OAuth 2.0 with PKCE" auch mit anderer Formulierung
```

Dashboard öffnen:

```bash
memesh
```

## Für wen ist das gedacht?

- Entwickler, die Claude Code nutzen und Projektkontext über Sessions hinweg behalten wollen
- Power-User, die dieselbe lokale Memory zwischen mehreren MCP Coding Agents nutzen möchten
- Kleine AI-native Teams, die Projektwissen per export / import teilen wollen
- Agent-Entwickler, die lokale Memory über CLI, HTTP oder MCP einbinden möchten

## Warum MeMesh?

- Local-first: die Daten liegen in deiner eigenen SQLite-Datei
- Leichte Installation: `npm install -g` und los
- Direkte Integration: CLI, HTTP und MCP werden unterstützt
- Gute Claude-Code-Passung: hooks bringen relevantes Wissen in den Workflow
- Einsehbar statt Black Box: das Dashboard macht Memory sichtbar und pflegbar
- Sicherere Import-Grenze: importierte Erinnerungen bleiben auffindbar, werden aber nicht automatisch in Claude-Hooks injiziert, solange sie nicht geprüft oder lokal neu gespeichert wurden

## Was passiert automatisch in Claude Code?

MeMesh unterstützt aktuell an 5 Stellen:

- beim Start der Session lädt es relevante Erinnerungen und bekannte Lessons
- vor Dateibearbeitungen ruft es projekt- oder dateibezogene Memory ab
- nach `git commit` protokolliert es die Änderung
- am Session-Ende fasst es Fixes, Fehler und lessons learned zusammen
- vor dem Context Compact speichert es wichtige Inhalte zurück in die lokale Memory

## Was bietet das Dashboard?

Das Dashboard hat 7 Tabs und unterstützt 11 Sprachen:

- Search: Memory durchsuchen
- Browse: alle Einträge ansehen
- Analytics: Gesundheit und Trends verstehen
- Graph: Wissensbeziehungen visualisieren
- Lessons: frühere Erkenntnisse prüfen
- Manage: archivieren und wiederherstellen
- Settings: LLM-Provider und Sprache einstellen

## Was ist Smart Mode?

MeMesh funktioniert standardmäßig offline. Mit einem LLM-API-Key lassen sich zusätzliche Fähigkeiten aktivieren, zum Beispiel:

- query expansion
- bessere automatische Extraktion
- intelligentere Verdichtung und Organisation

Auch ohne API-Key bleiben die Kernfunktionen nutzbar.

## Mehr Informationen

- Vollständige Funktionen, Vergleiche, API und Release-Details: [English README](README.md)
- Integrationsleitfaden: [docs/platforms/README.md](docs/platforms/README.md)
- API-Referenz: [docs/api/API_REFERENCE.md](docs/api/API_REFERENCE.md)

## Entwicklung und Verifikation

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory
npm install
npm run build
npm test
```
