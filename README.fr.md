🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>La couche mémoire locale pour Claude Code et les coding agents compatibles MCP.</strong><br />
    Un seul fichier SQLite. Sans Docker. Sans dépendance au cloud.
  </p>
</p>

> Ce README en français est une version condensée. Pour la documentation complète et la version la plus à jour, utilisez le [English README](README.md).

## Quel problème cela résout-il ?

Les coding agents perdent facilement le contexte d'une session à l'autre. Les décisions d'architecture, les bugs déjà corrigés, les leçons apprises et les contraintes du projet doivent alors être réexpliqués sans cesse.

**MeMesh conserve ces connaissances en local, les rend consultables, et permet de les réutiliser au bon moment.**

Ce package npm correspond à la version plugin / package locale de MeMesh. Il ne représente ni le workspace cloud ni une plateforme enterprise complète.

## Démarrage en 60 secondes

### 1. Installer

```bash
npm install -g @pcircle/memesh
```

### 2. Enregistrer une décision

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### 3. La retrouver plus tard

```bash
memesh recall "login security"
# → retrouve "OAuth 2.0 with PKCE" même avec une autre formulation
```

Ouvrir le dashboard :

```bash
memesh
```

## Pour qui ?

- Les développeurs qui utilisent Claude Code et veulent garder le contexte entre les sessions
- Les utilisateurs avancés qui souhaitent partager la même mémoire locale entre plusieurs agents MCP
- Les petites équipes AI-native qui veulent partager leur connaissance projet via export / import
- Les développeurs d'agents qui veulent brancher une mémoire locale via CLI, HTTP ou MCP

## Pourquoi choisir MeMesh ?

- Local-first : les données restent dans votre propre fichier SQLite
- Installation légère : `npm install -g` et c'est parti
- Intégration directe : CLI, HTTP et MCP sont pris en charge
- Bien adapté à Claude Code : les hooks ramènent le bon contexte dans le flux de travail
- Inspectable : le dashboard permet de voir et nettoyer la mémoire
- Frontière de confiance plus sûre : les mémoires importées restent consultables, mais ne sont pas injectées automatiquement dans les hooks Claude tant qu'elles n'ont pas été revues ou resauvegardées localement

## Que fait-il automatiquement dans Claude Code ?

Aujourd'hui, MeMesh intervient à 5 moments :

- au démarrage de session, il charge les mémoires pertinentes et les leçons connues
- avant l'édition d'un fichier, il rappelle ce qui est lié au fichier ou au projet
- après un `git commit`, il enregistre les changements effectués
- à la fin de session, il résume les corrections, erreurs et lessons learned
- avant la compaction du contexte, il sauvegarde ce qui ne doit pas être perdu

## Que contient le dashboard ?

Le dashboard propose 7 onglets et prend en charge 11 langues :

- Search : rechercher dans la mémoire
- Browse : parcourir toutes les mémoires
- Analytics : suivre la santé et les tendances
- Graph : visualiser les relations de connaissance
- Lessons : revoir les leçons apprises
- Manage : archiver et restaurer
- Settings : configurer le provider LLM et la langue

## Qu'est-ce que le Smart Mode ?

MeMesh fonctionne hors ligne par défaut. Si vous configurez une API key LLM, vous pouvez activer des capacités supplémentaires, par exemple :

- query expansion
- une extraction automatique plus utile
- une organisation et une compression plus intelligentes

Sans API key, le cœur du produit reste totalement utilisable.

## Aller plus loin

- Fonctionnalités complètes, comparaisons, API et notes de release : [English README](README.md)
- Guide d'intégration : [docs/platforms/README.md](docs/platforms/README.md)
- Référence API : [docs/api/API_REFERENCE.md](docs/api/API_REFERENCE.md)

## Développement et vérification

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory
npm install
npm run build
npm test
```
