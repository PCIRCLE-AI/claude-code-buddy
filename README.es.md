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
    <a href="https://pypi.org/project/memesh/"><img src="https://img.shields.io/badge/pip-memesh-3b82f6?style=flat-square" alt="PyPI" /></a>
  </p>
</p>

---

Tu IA olvida todo entre sesiones. **MeMesh soluciona eso.**

Instala una vez, configura en 30 segundos, y cada herramienta de IA que uses — Claude, GPT, LLaMA, o cualquier cliente MCP — obtendrá memoria persistente, con búsqueda avanzada y en constante evolución. Sin nube. Sin Neo4j. Sin base de datos vectorial. Solo un archivo SQLite.

```bash
npm install -g @pcircle/memesh
```

---

## Panel de control

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh Search" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-browse.png" alt="MeMesh Browse" width="100%" />
</p>

Ejecuta `memesh` para abrir el panel interactivo con Búsqueda, Exploración, Análisis, Gestión y Configuración.

---

## Inicio rápido

```bash
# Guardar un recuerdo
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"

# Buscar recuerdos (en Modo Inteligente, "login security" encuentra "OAuth")
memesh recall "login security"

# Archivar recuerdos obsoletos (borrado suave — nunca se pierde nada)
memesh forget --name "old-auth-design"

# Abrir el panel
memesh

# Iniciar la HTTP API (para el SDK de Python e integraciones)
memesh serve
```

### Python

```python
from memesh import MeMesh

m = MeMesh()  # connects to localhost:3737
m.remember("auth", "decision", observations=["Use OAuth 2.0 with PKCE"])
results = m.recall("auth")
```

### Cualquier LLM (formato OpenAI function calling)

```bash
memesh export-schema --format openai
# → JSON array of tools, paste into your OpenAI/Claude/Gemini API call
```

---

## ¿Por qué MeMesh?

La mayoría de las soluciones de memoria para IA requieren Neo4j, bases de datos vectoriales, claves API y más de 30 minutos de configuración. MeMesh solo necesita **un comando**.

| | **MeMesh** | Mem0 | Zep | Anthropic Memory |
|---|---|---|---|---|
| **Instalación** | `npm i -g` (5 seg) | pip + Neo4j + VectorDB | pip + Neo4j | Integrado (nube) |
| **Almacenamiento** | Archivo SQLite único | Neo4j + Qdrant | Neo4j | Nube |
| **Búsqueda** | FTS5 + puntuación + expansión LLM | Semántica + BM25 | Grafo temporal | Búsqueda por clave |
| **Privacidad** | 100% local, siempre | Opción en nube | Auto-alojado | Nube |
| **Dependencias** | 6 | 20+ | 10+ | 0 (pero ligado a la nube) |
| **Sin conexión** | Sí | No | No | No |
| **Panel** | Integrado (5 pestañas) | Ninguno | Ninguno | Ninguno |
| **Precio** | Gratis | Gratis/De pago | Gratis/De pago | Incluido con la API |

---

## Características

### 6 herramientas de memoria

| Herramienta | Qué hace |
|------|-------------|
| **remember** | Guarda conocimiento con observaciones, relaciones y etiquetas |
| **recall** | Búsqueda inteligente con puntuación multifactorial y expansión de consulta por LLM |
| **forget** | Archivado suave (nunca elimina) o elimina observaciones específicas |
| **consolidate** | Compresión de memorias extensas asistida por LLM |
| **export** | Comparte memorias como JSON entre proyectos o miembros del equipo |
| **import** | Importa memorias con estrategias de fusión (omitir / sobrescribir / añadir) |

### 3 métodos de acceso

| Método | Comando | Ideal para |
|--------|---------|----------|
| **CLI** | `memesh` | Terminal, scripts, CI/CD |
| **HTTP API** | `memesh serve` | SDK de Python, panel, integraciones |
| **MCP** | `memesh-mcp` | Claude Code, Claude Desktop, cualquier cliente MCP |

### 4 hooks de captura automática

| Hook | Disparador | Qué captura |
|------|---------|-----------------|
| **Session Start** | Cada sesión | Carga tus mejores memorias por relevancia |
| **Post Commit** | Tras `git commit` | Registra el commit con estadísticas de diff |
| **Session Summary** | Cuando Claude se detiene | Archivos editados, errores corregidos, decisiones tomadas |
| **Pre-Compact** | Antes de la compactación | Guarda conocimiento antes de perder el contexto |

### Funcionalidades inteligentes

- **Evolución del conocimiento** — `forget` archiva, no borra. Las relaciones `supersedes` reemplazan decisiones antiguas con nuevas. El historial se conserva.
- **Recall inteligente** — El LLM expande tu consulta con términos relacionados. "login security" encuentra "OAuth PKCE".
- **Puntuación multifactorial** — Los resultados se clasifican por relevancia (35%) + recencia (25%) + frecuencia (20%) + confianza (15%) + validez temporal (5%).
- **Detección de conflictos** — Avisa cuando los recuerdos se contradicen.
- **Degradación automática** — Los recuerdos obsoletos (30+ días sin uso) bajan gradualmente en el ranking. Nunca se borran.
- **Espacios de nombres** — Ámbitos `personal`, `team`, `global` para organizar y compartir.

---

## Arquitectura

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

El **núcleo** es independiente del framework — la misma lógica `remember`/`recall`/`forget` se ejecuta de forma idéntica tanto desde el terminal, HTTP o MCP.

**Dependencias**: `better-sqlite3`, `sqlite-vec`, `@modelcontextprotocol/sdk`, `zod`, `express`, `commander`

---

## Desarrollo

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory
npm install
npm run build
npm test -- --run    # 289 tests
```

Desarrollo del panel:
```bash
cd dashboard
npm install
npm run dev          # Vite dev server with hot reload
npm run build        # Build to single HTML file
```

---

## Licencia

MIT — [PCIRCLE AI](https://pcircle.ai)
