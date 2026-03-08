<div align="center">

# 🧠 MeMesh Plugin

### Plugin de productivité pour Claude Code

Mémoire, analyse intelligente des tâches et automatisation — dans un seul plugin.

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io)

[Installation](#installation) • [Utilisation](#utilisation) • [Dépannage](#dépannage)

[English](README.md) • [繁體中文](README.zh-TW.md) • [简体中文](README.zh-CN.md) • [日本語](README.ja.md) • [한국어](README.ko.md) • **Français** • [Deutsch](README.de.md) • [Español](README.es.md) • [Tiếng Việt](README.vi.md) • [ภาษาไทย](README.th.md) • [Bahasa Indonesia](README.id.md)

</div>

---

## Pourquoi ce projet existe

Ce projet est né de mon envie d'aider plus de gens — en particulier les débutants en programmation — à tirer le meilleur parti de Claude Code pour le vibe coding. J'ai remarqué que quand les projets grandissent, il devient difficile de suivre toutes les décisions prises entre les sessions. Alors j'ai créé un plugin (avec Claude Code, bien sûr) qui s'en souvient pour vous.

> **Note** : Ce projet s'appelait à l'origine « Claude Code Buddy » et a été renommé MeMesh Plugin pour éviter d'éventuels problèmes de marque.

## Qu'est-ce que ça fait ?

MeMesh Plugin rend Claude Code plus intelligent et productif. Ce n'est pas qu'une mémoire — c'est une boîte à outils complète :

**Mémoire de projet consultable** — Sauvegarde automatique des décisions, patterns et leçons. Recherche par sens, pas seulement par mots-clés. Demandez « qu'est-ce qu'on avait décidé pour l'auth ? » et obtenez une réponse immédiate.

**Analyse intelligente des tâches** — Quand vous dites `buddy-do "ajouter l'auth"`, MeMesh analyse la tâche, récupère le contexte pertinent du travail passé, et fournit un plan enrichi avant exécution.

**Automatisation du workflow** — MeMesh travaille en arrière-plan pour :
- Afficher un récapitulatif de votre dernière session au démarrage
- Suivre les fichiers modifiés et testés
- Rappeler la revue de code avant le commit
- Router les tâches vers le modèle optimal

**Apprendre des erreurs** — Enregistrez les erreurs et leurs corrections pour construire une base de connaissances et éviter de répéter les mêmes erreurs.

**En quoi c'est différent de la mémoire intégrée de Claude ?**

Claude Code dispose déjà de l'auto memory et de CLAUDE.md — parfaits pour les préférences générales. MeMesh ajoute des **outils dédiés au projet** : mémoire consultable par sens, analyse de tâches avec contexte passé, et workflows automatisés qui rendent chaque session plus productive.

Pensez-y comme ça :
- **CLAUDE.md** = votre manuel d'instructions pour Claude
- **MeMesh** = un carnet consultable + un assistant intelligent qui apprend avec votre projet

---

## Installation

**Prérequis** : [Claude Code](https://docs.anthropic.com/en/docs/claude-code) et Node.js 20+

```bash
npm install -g @pcircle/memesh
```

Redémarrez Claude Code. C'est tout.

**Vérification** — tapez ceci dans Claude Code :

```
buddy-help
```

Vous devriez voir une liste de commandes.

<details>
<summary>Installation depuis les sources (pour les contributeurs)</summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

</details>

---

## Utilisation

MeMesh ajoute 3 commandes à Claude Code :

| Commande | Fonction |
|----------|----------|
| `buddy-do "tâche"` | Exécuter une tâche avec le contexte mémoire |
| `buddy-remember "sujet"` | Rechercher les décisions et le contexte passés |
| `buddy-help` | Afficher les commandes disponibles |

**Exemples :**

```bash
buddy-do "explique ce codebase"
buddy-do "ajoute l'authentification utilisateur"
buddy-remember "décisions de conception API"
buddy-remember "pourquoi on a choisi PostgreSQL"
```

Toutes les données sont stockées localement sur votre machine. Les décisions sont conservées 90 jours, les notes de session 30 jours.

---

## Plateformes supportées

| Plateforme | Statut |
|-----------|--------|
| **macOS** | ✅ Fonctionne |
| **Linux** | ✅ Fonctionne |
| **Windows** | ✅ Fonctionne (WSL2 recommandé) |

**Compatible avec :**
- Claude Code CLI (terminal)
- Claude Code VS Code Extension
- Cursor (via MCP)
- Autres éditeurs compatibles MCP

**Claude Desktop (Cowork)** : Les commandes de base fonctionnent, mais les fonctionnalités mémoire nécessitent la version CLI. Voir [détails Cowork](docs/COWORK_SUPPORT.md).

---

## Dépannage

**MeMesh n'apparaît pas ?**

```bash
# Vérifier l'installation
npm list -g @pcircle/memesh

# Vérifier la version de Node.js (20+ requis)
node --version

# Relancer la configuration
memesh setup
```

Puis redémarrez complètement Claude Code.

Plus d'aide : [Guide de dépannage](docs/TROUBLESHOOTING.md)

---

## En savoir plus

- **[Démarrage](docs/GETTING_STARTED.md)** — Installation pas à pas
- **[Guide utilisateur](docs/USER_GUIDE.md)** — Guide complet avec exemples
- **[Commandes](docs/COMMANDS.md)** — Toutes les commandes disponibles
- **[Architecture](docs/ARCHITECTURE.md)** — Comment ça fonctionne en interne
- **[Contribuer](CONTRIBUTING.md)** — Envie d'aider ? Commencez ici
- **[Guide de développement](docs/DEVELOPMENT.md)** — Pour les contributeurs

---

## Licence

MIT — Voir [LICENSE](LICENSE)

---

<div align="center">

Quelque chose ne fonctionne pas ? [Ouvrir une issue](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new) — nous répondons rapidement.

[Signaler un bug](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=bug&template=bug_report.yml) • [Demander une fonctionnalité](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions)

</div>
