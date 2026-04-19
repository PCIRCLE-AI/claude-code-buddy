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
  </p>
</p>

---

## 문제의 본질

AI는 세션이 끝날 때마다 모든 것을 잊어버립니다. 모든 결정, 모든 버그 수정, 모든 교훈——사라집니다. 같은 맥락을 반복해서 설명하고, Claude는 같은 패턴을 다시 발견하며, 팀의 AI 지식은 매번 제로로 초기화됩니다.

**MeMesh는 모든 AI에게 지속적이고, 검색 가능하며, 진화하는 메모리를 제공합니다.**

---

## 60초 만에 시작하기

### 1단계: 설치

```bash
npm install -g @pcircle/memesh
```

### 2단계: AI가 기억하기

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### 3단계: AI가 떠올리기

```bash
memesh recall "login security"
# → 다른 단어로 검색해도 "OAuth 2.0 with PKCE"를 찾아냅니다
```

**끝입니다.** MeMesh가 세션을 넘나들며 기억하고 떠올리기 시작했습니다.

대시보드를 열어 메모리를 탐색해보세요:

```bash
memesh
```

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh Search — 어떤 메모리도 즉시 검색" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics — AI의 지식을 한눈에 파악" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-graph.png" alt="MeMesh Graph — 타입 필터와 에고 모드가 있는 인터랙티브 지식 그래프" width="100%" />
</p>

---

## 누구를 위한 도구인가?

| 당신이…라면 | MeMesh가 이렇게 도와줍니다 |
|---------------|---------------------|
| **Claude Code를 사용하는 개발자** | 결정, 패턴, 교훈을 세션을 넘나들며 자동으로 기억 |
| **LLM으로 제품을 만드는 팀** | 내보내기/가져오기로 팀 지식을 공유하고 모두의 AI 맥락을 정렬 |
| **AI 에이전트 개발자** | MCP, HTTP API, Python SDK를 통해 에이전트에 지속 메모리 부여 |
| **여러 AI 도구를 쓰는 파워 유저** | Claude, GPT, LLaMA, Ollama 또는 모든 MCP 클라이언트와 작동하는 단일 메모리 레이어 |

---

## 모든 것과 연동

<table>
<tr>
<td width="33%" align="center">

**Claude Code / Desktop**
```bash
memesh-mcp
```
MCP 프로토콜 (자동 설정)

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

**모든 LLM (OpenAI 형식)**
```bash
memesh export-schema \
  --format openai
```
어떤 API 호출에도 붙여넣기

</td>
</tr>
</table>

---

## 왜 Mem0 / Zep가 아닌가?

| | **MeMesh** | Mem0 | Zep |
|---|---|---|---|
| **설치 시간** | 5초 | 30~60분 | 30분 이상 |
| **설정 방법** | `npm i -g` — 완료 | Neo4j + VectorDB + API 키 | Neo4j + 설정 |
| **저장소** | SQLite 파일 하나 | Neo4j + Qdrant | Neo4j |
| **오프라인 사용** | 항상 가능 | 불가 | 불가 |
| **대시보드** | 내장 (7개 탭 + 분석) | 없음 | 없음 |
| **의존성** | 6개 | 20개 이상 | 10개 이상 |
| **가격** | 영구 무료 | 무료 티어 / 유료 | 무료 티어 / 유료 |

**MeMesh의 트레이드오프:** 엔터프라이즈급 멀티테넌트 기능을 포기하는 대신 **즉시 설치, 제로 인프라, 100% 프라이버시**를 얻습니다.

---

## 자동으로 일어나는 일들

모든 것을 직접 기억할 필요가 없습니다. MeMesh에는 **4개의 훅**이 있어 아무것도 하지 않아도 지식을 자동으로 포착합니다:

| 언제 | MeMesh가 하는 일 |
|------|------------------|
| **모든 세션 시작 시** | 스코어링 알고리즘으로 가장 관련성 높은 메모리를 로드 |
| **모든 `git commit` 후** | 변경 내용과 diff 통계를 기록 |
| **Claude 종료 시** | 편집한 파일, 수정한 오류, 내린 결정을 포착 |
| **컨텍스트 압축 전** | 컨텍스트 한계로 사라지기 전에 지식을 저장 |

> **언제든 비활성화:** `export MEMESH_AUTO_CAPTURE=false`

---

## 스마트 기능

**🧠 스마트 검색** — "login security"를 검색하면 "OAuth PKCE"에 관한 메모리를 찾아냅니다. 설정한 LLM을 이용해 쿼리를 관련 용어로 확장합니다.

**📊 점수 기반 순위** — 결과는 관련성(35%) + 최근 사용 시각(25%) + 사용 빈도(20%) + 신뢰도(15%) + 정보 유효성(5%)으로 순위를 매깁니다.

**🔄 지식 진화** — 결정은 바뀝니다. `forget`은 오래된 메모리를 아카이브합니다(절대 삭제하지 않습니다). `supersedes` 관계가 이전 것과 새 것을 연결합니다. AI는 항상 최신 버전을 참조합니다.

**⚠️ 충돌 감지** — 두 메모리가 서로 모순될 경우 MeMesh가 경고를 보냅니다.

**📦 팀 공유** — `memesh export > team-knowledge.json` → 팀과 공유 → `memesh import team-knowledge.json`

---

## 스마트 모드 활성화 (선택 사항)

MeMesh는 기본적으로 완전히 오프라인으로 동작합니다. LLM API 키를 추가하면 더 스마트한 검색을 사용할 수 있습니다:

```bash
memesh config set llm.provider anthropic
memesh config set llm.api-key sk-ant-...
```

또는 대시보드 설정 탭에서 시각적으로 설정:

```bash
memesh  # 대시보드 열기 → 설정 탭
```

| | 레벨 0 (기본값) | 레벨 1 (스마트 모드) |
|---|---|---|
| **검색** | FTS5 키워드 매칭 | + LLM 쿼리 확장 (~97% 재현율) |
| **자동 포착** | 규칙 기반 패턴 | + LLM이 결정 & 교훈 추출 |
| **압축** | 사용 불가 | `consolidate`로 장황한 메모리 압축 |
| **비용** | 무료, API 키 불필요 | 검색당 ~$0.0001 (Haiku) |

---

## 전체 6가지 메모리 도구

| 도구 | 기능 |
|------|-------------|
| `remember` | 관찰 기록, 관계, 태그와 함께 지식 저장 |
| `recall` | 다중 요소 스코어링과 LLM 쿼리 확장을 활용한 스마트 검색 |
| `forget` | 소프트 아카이브(절대 삭제 없음) 또는 특정 관찰 기록 제거 |
| `consolidate` | LLM 기반 장황한 메모리 압축 |
| `export` | 메모리를 JSON으로 프로젝트 또는 팀원과 공유 |
| `import` | 병합 전략(건너뛰기 / 덮어쓰기 / 추가)을 선택해 메모리 가져오기 |

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

코어는 프레임워크 독립적. 터미널, HTTP, MCP 어디서 호출해도 동일한 로직이 실행됩니다.

---

## 기여하기

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory && npm install && npm run build
npm test -- --run    # 289 tests
```

대시보드: `cd dashboard && npm install && npm run dev`

---

<p align="center">
  <strong>MIT</strong> — <a href="https://pcircle.ai">PCIRCLE AI</a> 제작
</p>
