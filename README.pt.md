🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>Camada de memória local para Claude Code e agentes de código compatíveis com MCP.</strong><br />
    Um arquivo SQLite. Sem Docker. Sem depender de nuvem.
  </p>
</p>

> Este README em português é uma versão resumida. Para a documentação mais completa e atualizada, use o [English README](README.md).

## Qual problema ele resolve?

Agentes de código costumam perder o contexto entre sessões. Decisões de arquitetura, correções importantes, erros já resolvidos e restrições do projeto acabam sendo explicados de novo e de novo.

**O MeMesh mantém esse conhecimento no seu ambiente local, com busca, inspeção e reaproveitamento ao longo do trabalho.**

Este pacote npm é a versão local do plugin / package do MeMesh. Ele não é o produto de workspace em nuvem nem uma plataforma enterprise completa.

## Comece em 60 segundos

### 1. Instale

```bash
npm install -g @pcircle/memesh
```

### 2. Salve uma decisão

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### 3. Recupere depois

```bash
memesh recall "login security"
# → encontra "OAuth 2.0 with PKCE" mesmo com palavras diferentes
```

Abra o dashboard:

```bash
memesh
```

## Para quem ele foi feito?

- Desenvolvedores que usam Claude Code e querem manter contexto entre sessões
- Usuários avançados que querem compartilhar a mesma memória local entre agentes MCP
- Pequenas equipes AI-native que querem trocar conhecimento via export / import
- Desenvolvedores de agents que querem integrar memória local via CLI, HTTP ou MCP

## Por que usar o MeMesh?

- Local-first: os dados ficam no seu próprio arquivo SQLite
- Instalação leve: `npm install -g` e pronto
- Integração direta: suporta CLI, HTTP e MCP
- Bom encaixe com Claude Code: hooks ajudam a trazer contexto no fluxo de trabalho
- Transparência: o dashboard permite ver e organizar a memória
- Limite de confiança mais seguro: memórias importadas continuam pesquisáveis, mas não entram automaticamente nos hooks do Claude sem revisão ou novo salvamento local

## O que ele faz automaticamente no Claude Code?

Hoje o MeMesh ajuda em 5 momentos:

- no início da sessão, carrega memórias relevantes e lições já conhecidas
- antes de editar arquivos, busca memórias relacionadas ao arquivo ou ao projeto
- depois de `git commit`, registra o que foi alterado
- no fim da sessão, organiza correções, erros e lessons learned
- antes do compact de contexto, salva o que não deveria se perder

## O que existe no dashboard?

O dashboard tem 7 abas e suporte a 11 idiomas:

- Search: buscar memórias
- Browse: listar memórias
- Analytics: acompanhar saúde e tendências
- Graph: ver relações de conhecimento
- Lessons: revisar lições aprendidas
- Manage: arquivar e restaurar memórias
- Settings: configurar provedor de LLM e idioma

## O que é o Smart Mode?

O MeMesh funciona offline por padrão. Se você configurar uma API key de LLM, pode habilitar recursos extras, como:

- query expansion
- extração automática mais útil
- organização e compressão mais inteligentes

Sem API key, o núcleo do produto continua funcionando normalmente.

## Leia mais

- Funcionalidades completas, comparações, API e release notes: [English README](README.md)
- Guia de integrações: [docs/platforms/README.md](docs/platforms/README.md)
- Referência de API: [docs/api/API_REFERENCE.md](docs/api/API_REFERENCE.md)

## Desenvolvimento e verificação

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory
npm install
npm run build
npm test
```
