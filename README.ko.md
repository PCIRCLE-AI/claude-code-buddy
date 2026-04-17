🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>가장 가벼운 범용 AI 메모리 레이어.</strong><br />
    SQLite 파일 하나. 어떤 LLM이든. 클라우드 없이.
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

AI는 세션이 끝나면 모든 것을 잊어버립니다. **MeMesh가 이 문제를 해결합니다.**

한 번 설치하고 30초 만에 설정하면, 사용하는 모든 AI 도구 — Claude, GPT, LLaMA, 또는 MCP 클라이언트 — 가 영속적이고 검색 가능한, 계속 진화하는 메모리를 갖게 됩니다. 클라우드 없이. Neo4j 없이. 벡터 데이터베이스 없이. SQLite 파일 하나면 충분합니다.

```bash
npm install -g @pcircle/memesh
```

---

## 대시보드

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh Search" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-browse.png" alt="MeMesh Browse" width="100%" />
</p>

`memesh`를 실행하면 검색, 탐색, 분석, 관리, 설정 5개 탭이 있는 인터랙티브 대시보드가 열립니다.

---

## 빠른 시작

```bash
# 메모리 저장하기
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"

# 메모리 검색하기 (스마트 모드에서 "login security"로 검색해도 "OAuth"를 찾습니다)
memesh recall "login security"

# 오래된 메모리 보관하기 (소프트 삭제 — 데이터는 영원히 사라지지 않습니다)
memesh forget --name "old-auth-design"

# 대시보드 열기
memesh

# HTTP API 시작하기 (Python SDK, 외부 연동용)
memesh serve
```

### Python

```python
from memesh import MeMesh

m = MeMesh()  # connects to localhost:3737
m.remember("auth", "decision", observations=["Use OAuth 2.0 with PKCE"])
results = m.recall("auth")
```

### 모든 LLM (OpenAI function calling 형식)

```bash
memesh export-schema --format openai
# → JSON array of tools, paste into your OpenAI/Claude/Gemini API call
```

---

## 왜 MeMesh인가?

대부분의 AI 메모리 솔루션은 Neo4j, 벡터 데이터베이스, API 키, 그리고 30분 이상의 설정 시간이 필요합니다. MeMesh는 **명령어 하나**면 충분합니다.

| | **MeMesh** | Mem0 | Zep | Anthropic Memory |
|---|---|---|---|---|
| **설치** | `npm i -g` (5초) | pip + Neo4j + VectorDB | pip + Neo4j | 내장 (클라우드) |
| **저장소** | SQLite 파일 하나 | Neo4j + Qdrant | Neo4j | 클라우드 |
| **검색** | FTS5 + 스코어링 + LLM 쿼리 확장 | 시맨틱 + BM25 | 시간 그래프 | 키 검색 |
| **프라이버시** | 100% 로컬, 항상 | 클라우드 옵션 | 자체 호스팅 | 클라우드 |
| **의존성** | 6개 | 20개 이상 | 10개 이상 | 0개 (단, 클라우드 종속) |
| **오프라인** | 지원 | 미지원 | 미지원 | 미지원 |
| **대시보드** | 내장 (5개 탭) | 없음 | 없음 | 없음 |
| **가격** | 무료 | 무료/유료 | 무료/유료 | API 포함 |

---

## 기능

### 6가지 메모리 도구

| 도구 | 기능 |
|------|-------------|
| **remember** | 관찰 기록, 관계, 태그와 함께 지식 저장 |
| **recall** | 다중 요소 스코어링과 LLM 쿼리 확장을 활용한 스마트 검색 |
| **forget** | 소프트 보관 (삭제 없음) 또는 특정 관찰 기록 제거 |
| **consolidate** | LLM을 이용한 장황한 메모리 압축 |
| **export** | 메모리를 JSON으로 프로젝트 또는 팀원과 공유 |
| **import** | 병합 전략(건너뛰기 / 덮어쓰기 / 추가)을 선택해 메모리 가져오기 |

### 3가지 접근 방법

| 방법 | 명령어 | 최적 용도 |
|--------|---------|----------|
| **CLI** | `memesh` | 터미널, 스크립팅, CI/CD |
| **HTTP API** | `memesh serve` | Python SDK, 대시보드, 외부 연동 |
| **MCP** | `memesh-mcp` | Claude Code, Claude Desktop, 모든 MCP 클라이언트 |

### 4가지 자동 캡처 훅

| 훅 | 트리거 | 캡처 내용 |
|------|---------|-----------------|
| **Session Start** | 매 세션 시작 | 관련성 상위 메모리 로드 |
| **Post Commit** | `git commit` 후 | 변경 통계와 함께 커밋 기록 |
| **Session Summary** | Claude 종료 시 | 편집 파일, 수정된 오류, 결정 사항 |
| **Pre-Compact** | 컴팩션 전 | 컨텍스트 소실 전 지식 저장 |

### 스마트 기능

- **지식 진화** — `forget`은 보관이지 삭제가 아닙니다. `supersedes` 관계로 오래된 결정을 새것으로 교체하면서 역사는 고스란히 보존됩니다.
- **스마트 리콜** — LLM이 검색 쿼리를 연관 용어로 확장합니다. "login security"로 "OAuth PKCE"를 찾을 수 있습니다.
- **다중 요소 스코어링** — 결과는 관련성(35%) + 최신성(25%) + 빈도(20%) + 신뢰도(15%) + 시간적 유효성(5%)으로 순위를 매깁니다.
- **충돌 감지** — 메모리가 서로 모순될 때 경고합니다.
- **자동 감쇠** — 30일 이상 사용되지 않은 낡은 메모리는 순위가 서서히 내려갑니다. 삭제는 없습니다.
- **네임스페이스** — `personal`, `team`, `global` 범위로 정리하고 공유할 수 있습니다.

---

## 아키텍처

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

**코어 엔진**은 프레임워크에 독립적입니다 — `remember`/`recall`/`forget` 로직은 터미널, HTTP, MCP 어디서 호출하든 동일하게 작동합니다.

**의존성**: `better-sqlite3`, `sqlite-vec`, `@modelcontextprotocol/sdk`, `zod`, `express`, `commander`

---

## 개발

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory
npm install
npm run build
npm test -- --run    # 289 tests
```

대시보드 개발:
```bash
cd dashboard
npm install
npm run dev          # Vite dev server with hot reload
npm run build        # Build to single HTML file
```

---

## 라이선스

MIT — [PCIRCLE AI](https://pcircle.ai)
