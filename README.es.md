<div align="center">

<img src="https://img.shields.io/badge/%F0%9F%A7%A0-MeMesh-blueviolet?style=for-the-badge" alt="MeMesh" />

# MeMesh

### Tus sesiones de programación con IA merecen memoria.

MeMesh le da a Claude Code una memoria persistente y consultable — para que cada sesión se base en la anterior.

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@pcircle/memesh)
[![Downloads](https://img.shields.io/npm/dm/@pcircle/memesh?style=flat-square&color=blue)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple?style=flat-square)](https://modelcontextprotocol.io)

```bash
npm install -g @pcircle/memesh
```

[Comenzar](#comenzar) · [Cómo funciona](#cómo-funciona) · [Comandos](#comandos) · [Docs](docs/USER_GUIDE.md)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · **Español** · [Tiếng Việt](README.vi.md) · [ภาษาไทย](README.th.md) · [Bahasa Indonesia](README.id.md)

</div>

> **Nota**: Este proyecto se llamaba originalmente "Claude Code Buddy" y fue renombrado a MeMesh Plugin para evitar posibles problemas de marca registrada.

---

## El problema

Estás metido de lleno en un proyecto con Claude Code. Tomaste decisiones importantes hace tres sesiones — qué biblioteca de autenticación usar, por qué elegiste ese esquema de base de datos, qué patrones seguir. Pero Claude no recuerda. Te repites. Pierdes contexto. Pierdes tiempo.

**MeMesh soluciona esto.** Le da a Claude una memoria persistente y consultable que crece con tu proyecto.

---

## Cómo funciona

<table>
<tr>
<td width="50%">

### Antes de MeMesh
```
Session 1: "Use JWT for auth"
Session 2: "Why did we pick JWT again?"
Session 3: "Wait, what auth library are we using?"
```
Repites decisiones. Claude olvida el contexto. El progreso se detiene.

</td>
<td width="50%">

### Después de MeMesh
```
Session 1: "Use JWT for auth" → saved
Session 2: buddy-remember "auth" → instant recall
Session 3: Context auto-loaded on start
```
Cada sesión continúa donde lo dejaste.

</td>
</tr>
</table>

---

## Lo que obtienes

**Memoria de proyecto consultable** — Pregunta "¿qué decidimos sobre la auth?" y obtén una respuesta instantánea con coincidencia semántica. No es búsqueda por palabras clave — es búsqueda por *significado*, impulsada por embeddings ONNX locales.

**Análisis inteligente de tareas** — `buddy-do "add user auth"` no solo ejecuta. Extrae contexto relevante de sesiones anteriores, verifica qué patrones has establecido y construye un plan enriquecido antes de escribir una sola línea.

**Recuperación proactiva** — MeMesh muestra automáticamente memorias relevantes cuando inicias una sesión, cuando falla un test o cuando encuentras un error. Sin búsqueda manual necesaria.

**Automatización del flujo de trabajo** — Resúmenes de sesión al iniciar. Seguimiento de cambios en archivos. Recordatorios de revisión de código antes de commits. Todo ejecutándose silenciosamente en segundo plano.

**Aprendizaje de errores** — Registra errores y correcciones para construir una base de conocimiento. El mismo error no ocurre dos veces.

---

## Comenzar

**Requisitos previos**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) + Node.js 20+

```bash
npm install -g @pcircle/memesh
```

Reinicia Claude Code. Eso es todo.

**Verificar** — escribe en Claude Code:

```
buddy-help
```

Deberías ver una lista de comandos disponibles.

<details>
<summary><strong>Instalar desde el código fuente</strong> (contribuidores)</summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

</details>

---

## Comandos

| Comando | Qué hace |
|---------|----------|
| `buddy-do "tarea"` | Ejecutar una tarea con contexto de memoria completo |
| `buddy-remember "tema"` | Buscar decisiones y contexto anteriores |
| `buddy-help` | Mostrar comandos disponibles |

**Ejemplos reales:**

```bash
# Orientarte en un codebase nuevo para ti
buddy-do "explain this codebase"

# Construir funcionalidades con contexto de trabajo anterior
buddy-do "add user authentication"

# Recordar por qué se tomaron decisiones
buddy-remember "API design decisions"
buddy-remember "why we chose PostgreSQL"
```

Todos los datos permanecen en tu máquina con retención automática de 90 días.

---

## ¿En qué se diferencia de CLAUDE.md?

| | CLAUDE.md | MeMesh |
|---|-----------|--------|
| **Propósito** | Instrucciones estáticas para Claude | Memoria viva que crece con tu proyecto |
| **Búsqueda** | Búsqueda manual de texto | Búsqueda semántica por significado |
| **Actualizaciones** | Las editas manualmente | Captura decisiones automáticamente mientras trabajas |
| **Recuperación** | Siempre cargado (puede volverse extenso) | Muestra contexto relevante bajo demanda |
| **Alcance** | Preferencias generales | Grafo de conocimiento específico del proyecto |

**Funcionan juntos.** CLAUDE.md le dice a Claude *cómo* trabajar. MeMesh recuerda *qué* has construido.

---

## Plataformas soportadas

| Plataforma | Estado |
|------------|--------|
| macOS | ✅ |
| Linux | ✅ |
| Windows | ✅ (WSL2 recomendado) |

**Compatible con:** Claude Code CLI · VS Code Extension · Cursor (vía MCP) · Cualquier editor compatible con MCP

---

## Arquitectura

MeMesh funciona como un plugin de Claude Code en local, con un componente MCP integrado:

- **Grafo de conocimiento** — Almacén de entidades respaldado por SQLite con búsqueda de texto completo FTS5
- **Embeddings vectoriales** — Runtime ONNX para similitud semántica (se ejecuta 100% localmente)
- **Deduplicación de contenido** — Hashing SHA-256 omite cálculos de embedding redundantes
- **Procesamiento por lotes** — Operaciones masivas eficientes para grandes bases de conocimiento
- **Sistema de hooks** — Recuperación proactiva al iniciar sesión, fallos de tests y errores

Todo se ejecuta localmente. Sin nube. Sin llamadas API. Tus datos nunca salen de tu máquina.

---

## Documentación

| Documento | Descripción |
|-----------|-------------|
| [Primeros pasos](docs/GETTING_STARTED.md) | Guía de configuración paso a paso |
| [Guía de usuario](docs/USER_GUIDE.md) | Guía completa de uso con ejemplos |
| [Comandos](docs/COMMANDS.md) | Referencia completa de comandos |
| [Arquitectura](docs/ARCHITECTURE.md) | Análisis técnico en profundidad |
| [Contribuir](CONTRIBUTING.md) | Directrices para contribuir |
| [Desarrollo](docs/DEVELOPMENT.md) | Configuración de desarrollo para contribuidores |

---

## Contribuir

¡Las contribuciones son bienvenidas! Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para comenzar.

---

## Licencia

MIT — Ver [LICENSE](LICENSE)

---

<div align="center">

**Construido con Claude Code, para Claude Code.**

[Reportar bug](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=bug&template=bug_report.yml) · [Solicitar función](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions) · [Obtener ayuda](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new)

</div>
