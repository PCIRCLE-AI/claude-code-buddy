🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>La couche mémoire IA universelle la plus légère.</strong><br />
    Un seul fichier SQLite. N'importe quel LLM. Zéro cloud.
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

Votre IA oublie tout entre les sessions. **MeMesh règle ce problème.**

Installez une fois, configurez en 30 secondes, et chaque outil IA que vous utilisez — Claude, GPT, LLaMA, ou n'importe quel client MCP — bénéficie d'une mémoire persistante, consultable et en constante évolution. Sans cloud. Sans Neo4j. Sans base de données vectorielle. Juste un fichier SQLite.

```bash
npm install -g @pcircle/memesh
```

---

## Tableau de bord

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh Search" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-browse.png" alt="MeMesh Browse" width="100%" />
</p>

Lancez `memesh` pour ouvrir le tableau de bord interactif avec Recherche, Navigation, Analytique, Gestion et Paramètres.

---

## Démarrage rapide

```bash
# Stocker un souvenir
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"

# Rechercher des souvenirs (en Mode Intelligent, "login security" trouve "OAuth")
memesh recall "login security"

# Archiver les souvenirs obsolètes (suppression douce — rien n'est jamais perdu)
memesh forget --name "old-auth-design"

# Ouvrir le tableau de bord
memesh

# Démarrer l'HTTP API (pour le SDK Python et les intégrations)
memesh serve
```

### Python

```python
from memesh import MeMesh

m = MeMesh()  # connects to localhost:3737
m.remember("auth", "decision", observations=["Use OAuth 2.0 with PKCE"])
results = m.recall("auth")
```

### N'importe quel LLM (format OpenAI function calling)

```bash
memesh export-schema --format openai
# → JSON array of tools, paste into your OpenAI/Claude/Gemini API call
```

---

## Pourquoi MeMesh ?

La plupart des solutions de mémoire IA nécessitent Neo4j, des bases vectorielles, des clés API et plus de 30 minutes de configuration. MeMesh n'a besoin que d'**une seule commande**.

| | **MeMesh** | Mem0 | Zep | Anthropic Memory |
|---|---|---|---|---|
| **Installation** | `npm i -g` (5 sec) | pip + Neo4j + VectorDB | pip + Neo4j | Intégré (cloud) |
| **Stockage** | Fichier SQLite unique | Neo4j + Qdrant | Neo4j | Cloud |
| **Recherche** | FTS5 + scoring + expansion LLM | Sémantique + BM25 | Graphe temporel | Recherche par clé |
| **Vie privée** | 100% local, toujours | Option cloud | Auto-hébergé | Cloud |
| **Dépendances** | 6 | 20+ | 10+ | 0 (mais dépendant du cloud) |
| **Hors ligne** | Oui | Non | Non | Non |
| **Tableau de bord** | Intégré (5 onglets) | Aucun | Aucun | Aucun |
| **Prix** | Gratuit | Gratuit/Payant | Gratuit/Payant | Inclus avec l'API |

---

## Fonctionnalités

### 6 outils mémoire

| Outil | Ce qu'il fait |
|------|-------------|
| **remember** | Stocke les connaissances avec observations, relations et tags |
| **recall** | Recherche intelligente avec scoring multi-facteurs et expansion de requête par LLM |
| **forget** | Archivage doux (sans suppression) ou suppression d'observations spécifiques |
| **consolidate** | Compression de souvenirs verbeux assistée par LLM |
| **export** | Partage les souvenirs en JSON entre projets ou membres d'équipe |
| **import** | Importe des souvenirs avec des stratégies de fusion (ignorer / écraser / ajouter) |

### 3 méthodes d'accès

| Méthode | Commande | Idéal pour |
|--------|---------|----------|
| **CLI** | `memesh` | Terminal, scripts, CI/CD |
| **HTTP API** | `memesh serve` | SDK Python, tableau de bord, intégrations |
| **MCP** | `memesh-mcp` | Claude Code, Claude Desktop, tout client MCP |

### 4 hooks de capture automatique

| Hook | Déclencheur | Ce qu'il capture |
|------|---------|-----------------|
| **Session Start** | Chaque session | Charge vos meilleurs souvenirs par pertinence |
| **Post Commit** | Après `git commit` | Enregistre le commit avec les stats de diff |
| **Session Summary** | Quand Claude s'arrête | Fichiers édités, erreurs corrigées, décisions prises |
| **Pre-Compact** | Avant compaction | Sauvegarde les connaissances avant la perte de contexte |

### Fonctionnalités intelligentes

- **Évolution des connaissances** — `forget` archive, ne supprime pas. Les relations `supersedes` remplacent les anciennes décisions par les nouvelles. L'historique est préservé.
- **Rappel intelligent** — Le LLM enrichit votre requête avec des termes connexes. "login security" trouve "OAuth PKCE".
- **Scoring multi-facteurs** — Résultats classés par pertinence (35%) + récence (25%) + fréquence (20%) + confiance (15%) + validité temporelle (5%).
- **Détection de conflits** — Avertit quand des souvenirs se contredisent.
- **Dégradation automatique** — Les souvenirs obsolètes (30+ jours sans utilisation) descendent progressivement dans le classement. Jamais supprimés.
- **Espaces de noms** — Portées `personal`, `team`, `global` pour organiser et partager.

---

## Architecture

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

Le **cœur** est indépendant du framework — la même logique `remember`/`recall`/`forget` s'exécute de manière identique qu'elle soit invoquée depuis le terminal, HTTP ou MCP.

**Dépendances** : `better-sqlite3`, `sqlite-vec`, `@modelcontextprotocol/sdk`, `zod`, `express`, `commander`

---

## Développement

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory
npm install
npm run build
npm test -- --run    # 289 tests
```

Développement du tableau de bord :
```bash
cd dashboard
npm install
npm run dev          # Vite dev server with hot reload
npm run build        # Build to single HTML file
```

---

## Licence

MIT — [PCIRCLE AI](https://pcircle.ai)
