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
  </p>
</p>

---

## O Problema

Seu AI esquece tudo entre sessões. Cada decisão, cada correção de bug, cada lição aprendida — tudo some. Você explica o mesmo contexto de novo e de novo, o Claude redescobre os mesmos padrões, e o conhecimento de IA da sua equipe volta ao zero toda vez.

**O MeMesh dá a cada AI uma memória persistente, pesquisável e em constante evolução.**

---

## Comece em 60 Segundos

### Passo 1: Instale

```bash
npm install -g @pcircle/memesh
```

### Passo 2: Seu AI lembra

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### Passo 3: Seu AI recupera

```bash
memesh recall "login security"
# → Encontra "OAuth 2.0 with PKCE" mesmo com palavras diferentes
```

**Pronto.** O MeMesh já está lembrando e recuperando memórias entre sessões.

Abra o painel para explorar sua memória:

```bash
memesh
```

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh Search — encontre qualquer memória instantaneamente" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics — entenda o conhecimento do seu AI" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-graph.png" alt="MeMesh Graph — grafo de conhecimento interativo com filtros de tipo e modo ego" width="100%" />
</p>

---

## Para Quem É Isso?

| Se você é... | O MeMesh ajuda você a... |
|---------------|---------------------|
| **Desenvolvedor usando Claude Code** | Lembrar decisões, padrões e lições entre sessões automaticamente |
| **Equipe construindo com LLMs** | Compartilhar conhecimento da equipe via exportação/importação, mantendo o contexto de todos alinhado |
| **Desenvolvedor de agentes de IA** | Dar aos seus agentes memória persistente via MCP, HTTP API ou Python SDK |
| **Usuário avançado com múltiplas ferramentas de IA** | Uma camada de memória que funciona com Claude, GPT, LLaMA, Ollama ou qualquer cliente MCP |

---

## Funciona com Tudo

<table>
<tr>
<td width="33%" align="center">

**Claude Code / Desktop**
```bash
memesh-mcp
```
Protocolo MCP (configurado automaticamente)

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

**Qualquer LLM (formato OpenAI)**
```bash
memesh export-schema \
  --format openai
```
Cole as ferramentas em qualquer chamada de API

</td>
</tr>
</table>

---

## Por que Não Usar Mem0 / Zep?

| | **MeMesh** | Mem0 | Zep |
|---|---|---|---|
| **Tempo de instalação** | 5 segundos | 30–60 minutos | 30+ minutos |
| **Configuração** | `npm i -g` — pronto | Neo4j + VectorDB + chaves de API | Neo4j + config |
| **Armazenamento** | Arquivo SQLite único | Neo4j + Qdrant | Neo4j |
| **Funciona offline** | Sim, sempre | Não | Não |
| **Painel** | Integrado (7 abas + analytics) | Nenhum | Nenhum |
| **Dependências** | 6 | 20+ | 10+ |
| **Preço** | Grátis para sempre | Plano gratuito / Pago | Plano gratuito / Pago |

**O MeMesh abre mão de:** recursos empresariais multi-inquilino em troca de **configuração instantânea, zero infraestrutura e 100% de privacidade**.

---

## O que Acontece Automaticamente

Você não precisa lembrar de tudo manualmente. O MeMesh possui **4 hooks** que capturam conhecimento sem que você precise fazer nada:

| Quando | O que o MeMesh faz |
|------|------------------|
| **Início de cada sessão** | Carrega suas memórias mais relevantes (classificadas por algoritmo de pontuação) |
| **Após cada `git commit`** | Registra o que você alterou, com estatísticas do diff |
| **Quando o Claude para** | Captura arquivos editados, erros corrigidos e decisões tomadas |
| **Antes da compactação de contexto** | Salva o conhecimento antes que se perca por limite de contexto |

> **Desative quando quiser:** `export MEMESH_AUTO_CAPTURE=false`

---

## Funcionalidades Inteligentes

**🧠 Busca Inteligente** — Pesquise "login security" e encontre memórias sobre "OAuth PKCE". O MeMesh expande consultas com termos relacionados usando o LLM configurado.

**📊 Classificação por Pontuação** — Resultados classificados por relevância (35%) + recência de uso (25%) + frequência (20%) + confiança (15%) + se a informação ainda é atual (5%).

**🔄 Evolução do Conhecimento** — As decisões mudam. `forget` arquiva memórias antigas (nunca deleta). Relações `supersedes` conectam o antigo ao novo. Seu AI sempre vê a versão mais recente.

**⚠️ Detecção de Conflitos** — Se você tiver duas memórias que se contradizem, o MeMesh avisa.

**📦 Compartilhamento em Equipe** — `memesh export > team-knowledge.json` → compartilhe com sua equipe → `memesh import team-knowledge.json`

---

## Ative o Modo Inteligente (Opcional)

O MeMesh funciona completamente offline por padrão. Adicione uma chave de API de LLM para desbloquear buscas mais inteligentes:

```bash
memesh config set llm.provider anthropic
memesh config set llm.api-key sk-ant-...
```

Ou use a aba Configurações do painel (configuração visual):

```bash
memesh  # abre o painel → aba Configurações
```

| | Nível 0 (padrão) | Nível 1 (Modo Inteligente) |
|---|---|---|
| **Busca** | Correspondência de palavras-chave FTS5 | + Expansão de consulta por LLM (~97% de recall) |
| **Captura automática** | Padrões baseados em regras | + LLM extrai decisões e lições |
| **Compressão** | Não disponível | `consolidate` comprime memórias longas |
| **Custo** | Grátis, sem chave de API | ~$0,0001 por busca (Haiku) |

---

## Todas as 6 Ferramentas de Memória

| Ferramenta | O que faz |
|------|-------------|
| `remember` | Armazena conhecimento com observações, relações e tags |
| `recall` | Busca inteligente com pontuação multifatorial e expansão de consulta por LLM |
| `forget` | Arquivamento suave (nunca deleta) ou remoção de observações específicas |
| `consolidate` | Compressão de memórias longas com auxílio de LLM |
| `export` | Compartilha memórias como JSON entre projetos ou membros da equipe |
| `import` | Importa memórias com estratégias de mesclagem (pular / sobrescrever / anexar) |

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

O núcleo é independente de framework. A mesma lógica é executada a partir do terminal, HTTP ou MCP.

---

## Contribuindo

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory && npm install && npm run build
npm test -- --run    # 289 tests
```

Painel: `cd dashboard && npm install && npm run dev`

---

<p align="center">
  <strong>MIT</strong> — Feito por <a href="https://pcircle.ai">PCIRCLE AI</a>
</p>
