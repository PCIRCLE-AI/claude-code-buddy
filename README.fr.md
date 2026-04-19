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
  </p>
</p>

---

## Le Problème

Votre IA oublie tout entre les sessions. Chaque décision, chaque correction de bug, chaque leçon apprise — effacées. Vous réexpliquez le même contexte en boucle, Claude redécouvre les mêmes patterns, et les connaissances IA de votre équipe repartent à zéro à chaque fois.

**MeMesh donne à chaque IA une mémoire persistante, consultable et en constante évolution.**

---

## Démarrez en 60 Secondes

### Étape 1 : Installez

```bash
npm install -g @pcircle/memesh
```

### Étape 2 : Votre IA se souvient

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### Étape 3 : Votre IA retrouve

```bash
memesh recall "login security"
# → Trouve "OAuth 2.0 with PKCE" même avec des mots différents
```

**C'est tout.** MeMesh mémorise et rappelle désormais d'une session à l'autre.

Ouvrez le tableau de bord pour explorer votre mémoire :

```bash
memesh
```

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh Search — retrouvez n'importe quel souvenir instantanément" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics — visualisez les connaissances de votre IA" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-graph.png" alt="MeMesh Graph — graphe de connaissances interactif avec filtres de type et mode ego" width="100%" />
</p>

---

## Pour Qui Est-ce Fait ?

| Si vous êtes... | MeMesh vous aide à... |
|---------------|---------------------|
| **Un développeur utilisant Claude Code** | Mémoriser décisions, patterns et leçons entre sessions automatiquement |
| **Une équipe qui construit avec des LLMs** | Partager les connaissances de l'équipe via export/import, garder le contexte IA de tous aligné |
| **Un développeur d'agents IA** | Donner à vos agents une mémoire persistante via MCP, HTTP API ou Python SDK |
| **Un utilisateur avancé avec plusieurs outils IA** | Une couche mémoire qui fonctionne avec Claude, GPT, LLaMA, Ollama ou n'importe quel client MCP |

---

## Compatible avec Tout

<table>
<tr>
<td width="33%" align="center">

**Claude Code / Desktop**
```bash
memesh-mcp
```
Protocole MCP (configuré automatiquement)

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

**N'importe quel LLM (format OpenAI)**
```bash
memesh export-schema \
  --format openai
```
Collez les outils dans n'importe quel appel API

</td>
</tr>
</table>

---

## Pourquoi Pas Mem0 / Zep ?

| | **MeMesh** | Mem0 | Zep |
|---|---|---|---|
| **Temps d'installation** | 5 secondes | 30–60 minutes | 30+ minutes |
| **Configuration** | `npm i -g` — terminé | Neo4j + VectorDB + clés API | Neo4j + config |
| **Stockage** | Fichier SQLite unique | Neo4j + Qdrant | Neo4j |
| **Fonctionne hors ligne** | Oui, toujours | Non | Non |
| **Tableau de bord** | Intégré (7 onglets + analytiques) | Aucun | Aucun |
| **Dépendances** | 6 | 20+ | 10+ |
| **Prix** | Gratuit à vie | Offre gratuite / Payant | Offre gratuite / Payant |

**MeMesh échange :** les fonctionnalités multi-tenant enterprise contre **une installation instantanée, zéro infrastructure et 100 % de confidentialité**.

---

## Ce qui Se Passe Automatiquement

Inutile de tout mémoriser manuellement. MeMesh dispose de **4 hooks** qui capturent les connaissances sans que vous ayez à faire quoi que ce soit :

| Quand | Ce que fait MeMesh |
|------|------------------|
| **Au démarrage de chaque session** | Charge vos souvenirs les plus pertinents (classés par algorithme de scoring) |
| **Après chaque `git commit`** | Enregistre ce que vous avez modifié, avec les statistiques de diff |
| **Quand Claude s'arrête** | Capture les fichiers édités, les erreurs corrigées et les décisions prises |
| **Avant la compaction du contexte** | Sauvegarde les connaissances avant qu'elles se perdent dans les limites du contexte |

> **Désactivez à tout moment :** `export MEMESH_AUTO_CAPTURE=false`

---

## Fonctionnalités Intelligentes

**🧠 Recherche Intelligente** — Cherchez « login security » et trouvez des souvenirs sur « OAuth PKCE ». MeMesh élargit les requêtes avec des termes connexes via le LLM configuré.

**📊 Classement par Score** — Résultats classés par pertinence (35 %) + date de dernière utilisation (25 %) + fréquence (20 %) + confiance (15 %) + si l'info est toujours d'actualité (5 %).

**🔄 Évolution des Connaissances** — Les décisions changent. `forget` archive les anciens souvenirs (ne supprime jamais). Les relations `supersedes` relient l'ancien au nouveau. Votre IA voit toujours la dernière version.

**⚠️ Détection de Conflits** — Si deux souvenirs se contredisent, MeMesh vous avertit.

**📦 Partage en Équipe** — `memesh export > team-knowledge.json` → partagez avec votre équipe → `memesh import team-knowledge.json`

---

## Activez le Mode Intelligent (Optionnel)

MeMesh fonctionne entièrement hors ligne par défaut. Ajoutez une clé API LLM pour débloquer une recherche plus intelligente :

```bash
memesh config set llm.provider anthropic
memesh config set llm.api-key sk-ant-...
```

Ou utilisez l'onglet Paramètres du tableau de bord (configuration visuelle) :

```bash
memesh  # ouvre le tableau de bord → onglet Paramètres
```

| | Niveau 0 (par défaut) | Niveau 1 (Mode Intelligent) |
|---|---|---|
| **Recherche** | Correspondance de mots-clés FTS5 | + Expansion de requête par LLM (~97 % de rappel) |
| **Capture automatique** | Patterns basés sur des règles | + LLM extrait décisions et leçons |
| **Compression** | Non disponible | `consolidate` compresse les souvenirs verbeux |
| **Coût** | Gratuit, sans clé API | ~0,0001 $ par recherche (Haiku) |

---

## Les 6 Outils Mémoire

| Outil | Ce qu'il fait |
|------|-------------|
| `remember` | Stocke les connaissances avec observations, relations et tags |
| `recall` | Recherche intelligente avec scoring multi-facteurs et expansion de requête par LLM |
| `forget` | Archivage doux (ne supprime jamais) ou suppression d'observations spécifiques |
| `consolidate` | Compression de souvenirs verbeux assistée par LLM |
| `export` | Partage les souvenirs en JSON entre projets ou membres d'équipe |
| `import` | Importe des souvenirs avec des stratégies de fusion (ignorer / écraser / ajouter) |

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

Le cœur est indépendant du framework. La même logique s'exécute depuis le terminal, HTTP ou MCP.

---

## Contribuer

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory && npm install && npm run build
npm test -- --run    # 289 tests
```

Tableau de bord : `cd dashboard && npm install && npm run dev`

---

<p align="center">
  <strong>MIT</strong> — Fait par <a href="https://pcircle.ai">PCIRCLE AI</a>
</p>
