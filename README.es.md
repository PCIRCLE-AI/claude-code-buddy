🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>La capa de memoria de IA universal más ligera.</strong><br />
    Un solo archivo SQLite. Cualquier LLM. Cero nube.
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@pcircle/memesh"><img src="https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=3b82f6&label=npm" alt="npm" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="MIT" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-22c55e?style=flat-square" alt="Node" /></a>
    <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-a855f7?style=flat-square" alt="MCP" /></a>
  </p>
</p>

---

## El Problema

Tu IA olvida todo entre sesiones. Cada decisión, cada corrección de bug, cada lección aprendida — desaparecen. Vuelves a explicar el mismo contexto una y otra vez, Claude redescubre los mismos patrones, y el conocimiento de IA de tu equipo se resetea a cero cada vez.

**MeMesh da a cada IA una memoria persistente, con búsqueda inteligente y en constante evolución.**

---

## Empieza en 60 Segundos

### Paso 1: Instala

```bash
npm install -g @pcircle/memesh
```

### Paso 2: Tu IA recuerda

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### Paso 3: Tu IA recupera

```bash
memesh recall "login security"
# → Encuentra "OAuth 2.0 with PKCE" aunque busques con otras palabras
```

**Eso es todo.** MeMesh ya está recordando y recuperando entre sesiones.

Abre el panel para explorar tu memoria:

```bash
memesh
```

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh Search — encuentra cualquier recuerdo al instante" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics — comprende el conocimiento de tu IA" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-graph.png" alt="MeMesh Graph — grafo de conocimiento interactivo con filtros de tipo y modo ego" width="100%" />
</p>

---

## ¿Para Quién Es?

| Si eres... | MeMesh te ayuda a... |
|---------------|---------------------|
| **Desarrollador usando Claude Code** | Recordar decisiones, patrones y lecciones entre sesiones automáticamente |
| **Equipo construyendo con LLMs** | Compartir conocimiento del equipo mediante exportación/importación, manteniendo el contexto de IA de todos alineado |
| **Desarrollador de agentes de IA** | Dar a tus agentes memoria persistente mediante MCP, HTTP API o Python SDK |
| **Usuario avanzado con múltiples herramientas de IA** | Una capa de memoria que funciona con Claude, GPT, LLaMA, Ollama o cualquier cliente MCP |

---

## Funciona con Todo

<table>
<tr>
<td width="33%" align="center">

**Claude Code / Desktop**
```bash
memesh-mcp
```
Protocolo MCP (configurado automáticamente)

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

**Cualquier LLM (formato OpenAI)**
```bash
memesh export-schema \
  --format openai
```
Pega las herramientas en cualquier llamada a la API

</td>
</tr>
</table>

---

## ¿Por Qué No Mem0 / Zep?

| | **MeMesh** | Mem0 | Zep |
|---|---|---|---|
| **Tiempo de instalación** | 5 segundos | 30–60 minutos | 30+ minutos |
| **Configuración** | `npm i -g` — listo | Neo4j + VectorDB + claves API | Neo4j + config |
| **Almacenamiento** | Archivo SQLite único | Neo4j + Qdrant | Neo4j |
| **Funciona sin conexión** | Sí, siempre | No | No |
| **Panel** | Integrado (7 pestañas + analytics) | Ninguno | Ninguno |
| **Dependencias** | 6 | 20+ | 10+ |
| **Precio** | Gratis para siempre | Plan gratuito / De pago | Plan gratuito / De pago |

**MeMesh sacrifica:** funcionalidades enterprise multi-inquilino a cambio de **instalación instantánea, cero infraestructura y 100 % de privacidad**.

---

## Qué Ocurre Automáticamente

No necesitas recordar todo manualmente. MeMesh tiene **4 hooks** que capturan conocimiento sin que hagas nada:

| Cuándo | Qué hace MeMesh |
|------|------------------|
| **Al inicio de cada sesión** | Carga tus recuerdos más relevantes + advertencias proactivas de lecciones pasadas |
| **Tras cada `git commit`** | Registra lo que cambiaste, con estadísticas del diff |
| **Cuando Claude se detiene** | Captura archivos editados, errores corregidos y genera automáticamente lecciones estructuradas a partir de fallos |
| **Antes de la compactación de contexto** | Guarda el conocimiento antes de que se pierda por los límites del contexto |

> **Desactívalo cuando quieras:** `export MEMESH_AUTO_CAPTURE=false`

---

## Panel de Control

7 pestañas, 11 idiomas, cero dependencias externas. Accede en `http://localhost:3737/dashboard` cuando el servidor esté activo.

| Pestaña | Qué ves |
|---------|---------|
| **Search** | Búsqueda de texto completo + similitud vectorial en todas las memorias |
| **Browse** | Lista paginada de todas las entidades con archivado/restauración |
| **Analytics** | Puntuación de Salud de Memoria (0-100), timeline de 30 días, métricas de valor, cobertura de conocimiento, sugerencias de limpieza, tus patrones de trabajo |
| **Graph** | Grafo de conocimiento interactivo dirigido por fuerzas con filtros de tipo, búsqueda, modo ego, mapa de calor de recencia |
| **Lessons** | Lecciones estructuradas de fallos pasados (error, causa raíz, corrección, prevención) |
| **Manage** | Archivar y restaurar entidades |
| **Settings** | Configuración del proveedor LLM, selector de idioma |

---

## Funcionalidades Inteligentes

**🧠 Búsqueda Inteligente** — Busca "login security" y encuentra recuerdos sobre "OAuth PKCE". MeMesh expande las consultas con términos relacionados usando el LLM configurado.

**📊 Clasificación por Puntuación** — Los resultados se ordenan por relevancia (35 %) + última vez que se usó (25 %) + frecuencia (20 %) + confianza (15 %) + si la información sigue siendo actual (5 %).

**🔄 Evolución del Conocimiento** — Las decisiones cambian. `forget` archiva los recuerdos antiguos (nunca borra). Las relaciones `supersedes` conectan lo viejo con lo nuevo. Tu IA siempre ve la versión más reciente.

**⚠️ Detección de Conflictos** — Si tienes dos recuerdos que se contradicen, MeMesh te avisa.

**📦 Compartir en Equipo** — `memesh export > team-knowledge.json` → comparte con tu equipo → `memesh import team-knowledge.json`

---

## Activa el Modo Inteligente (Opcional)

MeMesh funciona completamente sin conexión por defecto. Añade una clave API de LLM para desbloquear búsquedas más inteligentes:

```bash
memesh config set llm.provider anthropic
memesh config set llm.api-key sk-ant-...
```

O usa la pestaña Configuración del panel (configuración visual):

```bash
memesh  # abre el panel → pestaña Configuración
```

| | Nivel 0 (por defecto) | Nivel 1 (Modo Inteligente) |
|---|---|---|
| **Búsqueda** | Coincidencia de palabras clave FTS5 | + Expansión de consulta por LLM (~97 % de recall) |
| **Captura automática** | Patrones basados en reglas | + LLM extrae decisiones y lecciones |
| **Compresión** | No disponible | `consolidate` comprime recuerdos extensos |
| **Coste** | Gratis, sin clave API | ~$0,0001 por búsqueda (Haiku) |

---

## Las 8 Herramientas de Memoria

| Herramienta | Qué hace |
|------|-------------|
| `remember` | Guarda conocimiento con observaciones, relaciones y etiquetas |
| `recall` | Búsqueda inteligente con puntuación multifactorial y expansión de consulta por LLM |
| `forget` | Archivado suave (nunca borra) o elimina observaciones específicas |
| `consolidate` | Compresión de memorias extensas asistida por LLM |
| `export` | Comparte memorias como JSON entre proyectos o miembros del equipo |
| `import` | Importa memorias con estrategias de fusión (omitir / sobrescribir / añadir) |
| `learn` | Registra lecciones estructuradas a partir de errores (error, causa raíz, corrección, prevención) |
| `user_patterns` | Analiza tus patrones de trabajo — horario, herramientas, fortalezas, áreas de aprendizaje |

---

## Arquitectura

```
                    ┌─────────────────┐
                    │   Core Engine   │
                    │  (8 operations) │
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

El núcleo es independiente del framework. La misma lógica se ejecuta desde el terminal, HTTP o MCP.

---

## Contribuir

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory && npm install && npm run build
npm test -- --run    # 413 tests
```

Panel: `cd dashboard && npm install && npm run dev`

---

<p align="center">
  <strong>MIT</strong> — Hecho por <a href="https://pcircle.ai">PCIRCLE AI</a>
</p>
