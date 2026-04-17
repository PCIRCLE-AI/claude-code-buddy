🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>A camada de memória de IA universal mais leve.</strong><br />
    Um único arquivo SQLite. Qualquer LLM. Zero nuvem.
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

Seu AI esquece tudo entre sessões. **O MeMesh resolve isso.**

Instale uma vez, configure em 30 segundos, e toda ferramenta de IA que você usa — Claude, GPT, LLaMA, ou qualquer cliente MCP — ganha memória persistente, pesquisável e que evolui ao longo do tempo. Sem nuvem. Sem Neo4j. Sem banco de dados vetorial. Apenas um arquivo SQLite.

```bash
npm install -g @pcircle/memesh
```

---

## Painel de Controle

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh Search" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-browse.png" alt="MeMesh Browse" width="100%" />
</p>

Execute `memesh` para abrir o painel interativo com Pesquisa, Navegação, Análise, Gerenciamento e Configurações.

---

## Início Rápido

```bash
# Armazenar uma memória
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"

# Pesquisar memórias (no Modo Inteligente, "login security" encontra "OAuth")
memesh recall "login security"

# Arquivar memórias desatualizadas (exclusão suave — nada se perde para sempre)
memesh forget --name "old-auth-design"

# Abrir o painel
memesh

# Iniciar a HTTP API (para o Python SDK e integrações)
memesh serve
```

### Python

```python
from memesh import MeMesh

m = MeMesh()  # connects to localhost:3737
m.remember("auth", "decision", observations=["Use OAuth 2.0 with PKCE"])
results = m.recall("auth")
```

### Qualquer LLM (formato OpenAI function calling)

```bash
memesh export-schema --format openai
# → JSON array of tools, paste into your OpenAI/Claude/Gemini API call
```

---

## Por que o MeMesh?

A maioria das soluções de memória para IA exige Neo4j, bancos de dados vetoriais, chaves de API e mais de 30 minutos de configuração. O MeMesh precisa de **um único comando**.

| | **MeMesh** | Mem0 | Zep | Anthropic Memory |
|---|---|---|---|---|
| **Instalação** | `npm i -g` (5 seg) | pip + Neo4j + VectorDB | pip + Neo4j | Integrado (nuvem) |
| **Armazenamento** | Arquivo SQLite único | Neo4j + Qdrant | Neo4j | Nuvem |
| **Pesquisa** | FTS5 + pontuação + expansão LLM | Semântica + BM25 | Grafo temporal | Busca por chave |
| **Privacidade** | 100% local, sempre | Opção na nuvem | Auto-hospedado | Nuvem |
| **Dependências** | 6 | 20+ | 10+ | 0 (mas preso à nuvem) |
| **Offline** | Sim | Não | Não | Não |
| **Painel** | Integrado (5 abas) | Nenhum | Nenhum | Nenhum |
| **Preço** | Gratuito | Gratuito/Pago | Gratuito/Pago | Incluído na API |

---

## Funcionalidades

### 6 Ferramentas de Memória

| Ferramenta | O que faz |
|------|-------------|
| **remember** | Armazena conhecimento com observações, relações e tags |
| **recall** | Pesquisa inteligente com pontuação multifatorial e expansão de consulta via LLM |
| **forget** | Arquivamento suave (nunca deleta) ou remoção de observações específicas |
| **consolidate** | Compressão de memórias verbosas com auxílio de LLM |
| **export** | Compartilha memórias como JSON entre projetos ou membros da equipe |
| **import** | Importa memórias com estratégias de mesclagem (pular / sobrescrever / anexar) |

### 3 Métodos de Acesso

| Método | Comando | Ideal para |
|--------|---------|----------|
| **CLI** | `memesh` | Terminal, scripts, CI/CD |
| **HTTP API** | `memesh serve` | Python SDK, painel, integrações |
| **MCP** | `memesh-mcp` | Claude Code, Claude Desktop, qualquer cliente MCP |

### 4 Hooks de Captura Automática

| Hook | Gatilho | O que captura |
|------|---------|-----------------|
| **Session Start** | Cada sessão | Carrega suas melhores memórias por relevância |
| **Post Commit** | Após `git commit` | Registra o commit com estatísticas de diff |
| **Session Summary** | Quando o Claude para | Arquivos editados, erros corrigidos, decisões tomadas |
| **Pre-Compact** | Antes da compactação | Salva conhecimento antes do contexto ser perdido |

### Recursos Inteligentes

- **Evolução do Conhecimento** — `forget` arquiva, não deleta. Relações `supersedes` substituem decisões antigas por novas. O histórico é preservado.
- **Recall Inteligente** — O LLM expande sua consulta de pesquisa em termos relacionados. "login security" encontra "OAuth PKCE".
- **Pontuação Multifatorial** — Resultados classificados por relevância (35%) + recência (25%) + frequência (20%) + confiança (15%) + validade temporal (5%).
- **Detecção de Conflitos** — Avisa quando memórias se contradizem.
- **Decaimento Automático** — Memórias obsoletas (30+ dias sem uso) diminuem gradualmente no ranking. Nunca são deletadas.
- **Namespaces** — Escopos `personal`, `team`, `global` para organizar e compartilhar.

---

## Arquitetura

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

O **núcleo** é independente de framework — a mesma lógica de `remember`/`recall`/`forget` executa de forma idêntica, seja invocada pelo terminal, HTTP ou MCP.

**Dependências**: `better-sqlite3`, `sqlite-vec`, `@modelcontextprotocol/sdk`, `zod`, `express`, `commander`

---

## Desenvolvimento

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory
npm install
npm run build
npm test -- --run    # 289 tests
```

Desenvolvimento do painel:
```bash
cd dashboard
npm install
npm run dev          # Vite dev server with hot reload
npm run build        # Build to single HTML file
```

---

## Licença

MIT — [PCIRCLE AI](https://pcircle.ai)
