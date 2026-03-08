<div align="center">

<img src="https://img.shields.io/badge/%F0%9F%A7%A0-MeMesh-blueviolet?style=for-the-badge" alt="MeMesh" />

# MeMesh Plugin

### Vos sessions de code avec l'IA méritent une mémoire.

MeMesh Plugin offre à Claude Code une mémoire persistante et consultable — chaque session s'appuie sur la précédente.

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@pcircle/memesh)
[![Downloads](https://img.shields.io/npm/dm/@pcircle/memesh?style=flat-square&color=blue)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple?style=flat-square)](https://modelcontextprotocol.io)

```bash
npm install -g @pcircle/memesh
```

[Démarrage](#démarrage) · [Fonctionnement](#fonctionnement) · [Commandes](#commandes) · [Documentation](docs/USER_GUIDE.md)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Français** · [Deutsch](README.de.md) · [Español](README.es.md) · [Tiếng Việt](README.vi.md) · [ภาษาไทย](README.th.md) · [Bahasa Indonesia](README.id.md)

</div>

> **Note** : Ce projet s'appelait à l'origine « Claude Code Buddy » et a été renommé MeMesh Plugin pour éviter d'éventuels problèmes de marque.

---

## Le problème

Vous travaillez sur un projet avec Claude Code. Vous avez pris des décisions importantes il y a trois sessions — quelle bibliothèque d'authentification utiliser, pourquoi ce schéma de base de données, quels patterns suivre. Mais Claude ne s'en souvient pas. Vous vous répétez. Vous perdez le contexte. Vous perdez du temps.

**MeMesh résout ce problème.** Il offre à Claude une mémoire persistante et consultable qui grandit avec votre projet.

---

## Fonctionnement

<table>
<tr>
<td width="50%">

### Avant MeMesh
```
Session 1 : "Utiliser JWT pour l'auth"
Session 2 : "Pourquoi on avait choisi JWT déjà ?"
Session 3 : "Attends, on utilise quelle bibliothèque d'auth ?"
```
Vous répétez vos décisions. Claude oublie le contexte. La progression stagne.

</td>
<td width="50%">

### Après MeMesh
```
Session 1 : "Utiliser JWT pour l'auth" → sauvegardé
Session 2 : buddy-remember "auth" → rappel instantané
Session 3 : Contexte chargé automatiquement au démarrage
```
Chaque session reprend là où vous vous étiez arrêté.

</td>
</tr>
</table>

---

## Ce que vous obtenez

**Mémoire de projet consultable** — Demandez "qu'est-ce qu'on avait décidé pour l'auth ?" et obtenez une réponse instantanée par correspondance sémantique. Pas une recherche par mots-clés — une recherche par *sens*, propulsée par des embeddings ONNX locaux.

**Analyse intelligente des tâches** — `buddy-do "ajouter l'auth utilisateur"` ne se contente pas d'exécuter. Il récupère le contexte pertinent des sessions passées, vérifie les patterns que vous avez établis, et construit un plan enrichi avant d'écrire la moindre ligne.

**Rappel proactif** — MeMesh fait remonter automatiquement les souvenirs pertinents au démarrage d'une session, lors d'un échec de test ou d'une erreur. Aucune recherche manuelle nécessaire.

**Automatisation du workflow** — Récapitulatifs de session au démarrage. Suivi des modifications de fichiers. Rappels de revue de code avant les commits. Le tout fonctionne silencieusement en arrière-plan.

**Apprentissage des erreurs** — Enregistrez les erreurs et leurs corrections pour construire une base de connaissances. La même erreur ne se reproduit pas deux fois.

---

## Démarrage

**Prérequis** : [Claude Code](https://docs.anthropic.com/en/docs/claude-code) + Node.js 20+

```bash
npm install -g @pcircle/memesh
```

Redémarrez Claude Code. C'est tout.

**Vérification** — tapez dans Claude Code :

```
buddy-help
```

Vous devriez voir une liste des commandes disponibles.

<details>
<summary><strong>Installation depuis les sources</strong> (contributeurs)</summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

</details>

---

## Commandes

| Commande | Ce qu'elle fait |
|----------|----------------|
| `buddy-do "tâche"` | Exécuter une tâche avec le contexte mémoire complet |
| `buddy-remember "sujet"` | Rechercher les décisions et le contexte passés |
| `buddy-help` | Afficher les commandes disponibles |

**Exemples concrets :**

```bash
# Se repérer dans un nouveau codebase
buddy-do "explain this codebase"

# Développer des fonctionnalités avec le contexte du travail passé
buddy-do "add user authentication"

# Retrouver pourquoi des décisions ont été prises
buddy-remember "API design decisions"
buddy-remember "why we chose PostgreSQL"
```

Toutes les données restent sur votre machine avec une rétention automatique de 90 jours.

---

## En quoi est-ce différent de CLAUDE.md ?

| | CLAUDE.md | MeMesh |
|---|-----------|--------|
| **Objectif** | Instructions statiques pour Claude | Mémoire vivante qui grandit avec votre projet |
| **Recherche** | Recherche textuelle manuelle | Recherche sémantique par sens |
| **Mises à jour** | Vous éditez manuellement | Capture automatique des décisions en cours de travail |
| **Rappel** | Toujours chargé (peut devenir long) | Fait remonter le contexte pertinent à la demande |
| **Portée** | Préférences générales | Graphe de connaissances spécifique au projet |

**Ils fonctionnent ensemble.** CLAUDE.md indique à Claude *comment* travailler. MeMesh se souvient de *ce que* vous avez construit.

---

## Plateformes supportées

| Plateforme | Statut |
|-----------|--------|
| macOS | ✅ |
| Linux | ✅ |
| Windows | ✅ (WSL2 recommandé) |

**Compatible avec :** Claude Code CLI · VS Code Extension · Cursor (via MCP) · Tout éditeur compatible MCP

---

## Architecture

MeMesh fonctionne comme un plugin Claude Code en local, avec un composant MCP intégré :

- **Graphe de connaissances** — Stockage d'entités basé sur SQLite avec recherche plein texte FTS5
- **Embeddings vectoriels** — Runtime ONNX pour la similarité sémantique (100 % local)
- **Déduplication de contenu** — Hachage SHA-256 pour éviter les calculs d'embeddings redondants
- **Traitement par lots** — Opérations en masse efficaces pour les grandes bases de connaissances
- **Système de hooks** — Rappel proactif au démarrage de session, en cas d'échec de tests et d'erreurs

Tout fonctionne localement. Pas de cloud. Pas d'appels API. Vos données ne quittent jamais votre machine.

---

## Documentation

| Document | Description |
|----------|-------------|
| [Démarrage](docs/GETTING_STARTED.md) | Guide d'installation pas à pas |
| [Guide utilisateur](docs/USER_GUIDE.md) | Guide complet avec exemples |
| [Commandes](docs/COMMANDS.md) | Référence complète des commandes |
| [Architecture](docs/ARCHITECTURE.md) | Plongée technique approfondie |
| [Contribuer](CONTRIBUTING.md) | Guide de contribution |
| [Développement](docs/DEVELOPMENT.md) | Configuration pour les contributeurs |

---

## Contribuer

Les contributions sont les bienvenues ! Consultez [CONTRIBUTING.md](CONTRIBUTING.md) pour commencer.

---

## Licence

MIT — Voir [LICENSE](LICENSE)

---

<div align="center">

**Construit avec Claude Code, pour Claude Code.**

[Signaler un bug](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=bug&template=bug_report.yml) · [Demander une fonctionnalité](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions) · [Obtenir de l'aide](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new)

</div>
