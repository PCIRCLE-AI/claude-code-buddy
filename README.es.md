<div align="center">

# 🧠 MeMesh Plugin

### Plugin de productividad para Claude Code

Memoria, análisis inteligente de tareas y automatización — todo en un plugin.

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io)

[Instalación](#instalación) • [Uso](#uso) • [Solución de problemas](#solución-de-problemas)

[English](README.md) • [繁體中文](README.zh-TW.md) • [简体中文](README.zh-CN.md) • [日本語](README.ja.md) • [한국어](README.ko.md) • [Français](README.fr.md) • [Deutsch](README.de.md) • **Español** • [Tiếng Việt](README.vi.md) • [ภาษาไทย](README.th.md) • [Bahasa Indonesia](README.id.md)

</div>

---

## Por qué existe este proyecto

Este proyecto nació porque quería ayudar a más personas — especialmente a quienes están empezando a programar — a sacar el máximo provecho de Claude Code para vibe coding. Algo que noté: cuando los proyectos crecen, se vuelve difícil llevar un registro de todas las decisiones tomadas entre sesiones. Así que construí un plugin (con Claude Code, por supuesto) que recuerda por ti.

> **Nota**: Este proyecto se llamaba originalmente "Claude Code Buddy" y fue renombrado a MeMesh Plugin para evitar posibles problemas de marca registrada.

## ¿Qué hace?

MeMesh Plugin hace Claude Code más inteligente y productivo. No es solo memoria — es un kit de herramientas completo:

**Memoria de proyecto consultable** — Guarda automáticamente decisiones, patrones y lecciones. Busca por significado, no solo por palabras clave. Pregunta "¿qué decidimos sobre la auth?" y obtén respuesta inmediata.

**Análisis inteligente de tareas** — Cuando dices `buddy-do "añadir auth"`, MeMesh analiza la tarea, trae contexto relevante del trabajo pasado y proporciona un plan enriquecido antes de ejecutar.

**Automatización del flujo de trabajo** — MeMesh trabaja en segundo plano para:
- Mostrar un resumen de tu última sesión al iniciar
- Rastrear archivos modificados y probados
- Recordar la revisión de código antes del commit
- Enrutar tareas al modelo óptimo

**Aprender de los errores** — Registra errores y correcciones para construir una base de conocimiento y evitar repetir los mismos errores.

**¿En qué se diferencia de la memoria integrada de Claude?**

Claude Code ya tiene auto memory y CLAUDE.md — genial para preferencias generales. MeMesh añade **herramientas dedicadas al proyecto**: memoria consultable por significado, análisis de tareas con contexto pasado y flujos de trabajo automatizados que hacen cada sesión más productiva.

Piénsalo así:
- **CLAUDE.md** = tu manual de instrucciones para Claude
- **MeMesh** = un cuaderno consultable + asistente inteligente que crece con tu proyecto

---

## Instalación

**Necesitas**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) y Node.js 20+

```bash
npm install -g @pcircle/memesh
```

Reinicia Claude Code. Listo.

**Verificar que funciona** — escribe esto en Claude Code:

```
buddy-help
```

Deberías ver una lista de comandos.

<details>
<summary>Instalar desde el código fuente (para contribuidores)</summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

</details>

---

## Uso

MeMesh añade 3 comandos a Claude Code:

| Comando | Qué hace |
|---------|----------|
| `buddy-do "tarea"` | Ejecutar una tarea con contexto de memoria |
| `buddy-remember "tema"` | Buscar decisiones y contexto anteriores |
| `buddy-help` | Mostrar comandos disponibles |

**Ejemplos:**

```bash
buddy-do "explica este codebase"
buddy-do "añade autenticación de usuario"
buddy-remember "decisiones de diseño de API"
buddy-remember "por qué elegimos PostgreSQL"
```

Todos los datos se almacenan localmente en tu máquina. Las decisiones se guardan 90 días, las notas de sesión 30 días.

---

## Plataformas soportadas

| Plataforma | Estado |
|-----------|--------|
| **macOS** | ✅ Funciona |
| **Linux** | ✅ Funciona |
| **Windows** | ✅ Funciona (WSL2 recomendado) |

**Compatible con:**
- Claude Code CLI (terminal)
- Claude Code VS Code Extension
- Cursor (vía MCP)
- Otros editores compatibles con MCP

**Claude Desktop (Cowork)**: Los comandos básicos funcionan, pero las funciones de memoria necesitan la versión CLI. Ver [detalles de Cowork](docs/COWORK_SUPPORT.md).

---

## Solución de problemas

**¿MeMesh no aparece?**

```bash
# Verificar instalación
npm list -g @pcircle/memesh

# Verificar versión de Node.js (necesita 20+)
node --version

# Volver a ejecutar el setup
memesh setup
```

Luego reinicia Claude Code completamente.

Más ayuda: [Guía de solución de problemas](docs/TROUBLESHOOTING.md)

---

## Más información

- **[Primeros pasos](docs/GETTING_STARTED.md)** — Configuración paso a paso
- **[Guía de usuario](docs/USER_GUIDE.md)** — Guía completa con ejemplos
- **[Comandos](docs/COMMANDS.md)** — Todos los comandos disponibles
- **[Arquitectura](docs/ARCHITECTURE.md)** — Cómo funciona internamente
- **[Contribuir](CONTRIBUTING.md)** — ¿Quieres ayudar? Empieza aquí
- **[Guía de desarrollo](docs/DEVELOPMENT.md)** — Para contribuidores

---

## Licencia

MIT — Ver [LICENSE](LICENSE)

---

<div align="center">

¿Algo no funciona? [Abre un issue](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new) — respondemos rápido.

[Reportar bug](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=bug&template=bug_report.yml) • [Solicitar función](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions)

</div>
