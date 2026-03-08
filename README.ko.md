<div align="center">

<img src="https://img.shields.io/badge/%F0%9F%A7%A0-MeMesh-blueviolet?style=for-the-badge" alt="MeMesh" />

# MeMesh

### AI 코딩 세션에도 기억이 필요합니다.

MeMesh는 Claude Code에 영구적이고 검색 가능한 메모리를 제공하여, 모든 세션이 이전 세션 위에 쌓이도록 합니다.

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@pcircle/memesh)
[![Downloads](https://img.shields.io/npm/dm/@pcircle/memesh?style=flat-square&color=blue)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple?style=flat-square)](https://modelcontextprotocol.io)

```bash
npm install -g @pcircle/memesh
```

[시작하기](#시작하기) · [작동 방식](#작동-방식) · [명령어](#명령어) · [문서](docs/USER_GUIDE.md)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어** · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Tiếng Việt](README.vi.md) · [ภาษาไทย](README.th.md) · [Bahasa Indonesia](README.id.md)

</div>

> **참고**: 이 프로젝트는 원래 "Claude Code Buddy"라는 이름이었으며, 잠재적인 상표 문제를 피하기 위해 MeMesh Plugin으로 이름이 변경되었습니다.

---

## 문제점

Claude Code로 프로젝트를 깊이 진행하고 있습니다. 세 번 전 세션에서 중요한 결정을 내렸습니다 — 어떤 인증 라이브러리를 쓸지, 왜 그 데이터베이스 스키마를 선택했는지, 어떤 패턴을 따를지. 하지만 Claude는 기억하지 못합니다. 같은 말을 반복하고, 컨텍스트를 잃고, 시간을 낭비합니다.

**MeMesh가 이 문제를 해결합니다.** 프로젝트와 함께 성장하는 영구적이고 검색 가능한 메모리를 Claude에게 제공합니다.

---

## 작동 방식

<table>
<tr>
<td width="50%">

### MeMesh 이전
```
Session 1: "JWT로 인증하자"
Session 2: "왜 JWT를 선택했었지?"
Session 3: "잠깐, 어떤 인증 라이브러리 쓰고 있었지?"
```
결정을 반복합니다. Claude가 컨텍스트를 잊습니다. 진행이 멈춥니다.

</td>
<td width="50%">

### MeMesh 이후
```
Session 1: "JWT로 인증하자" → 저장됨
Session 2: buddy-remember "auth" → 즉시 회상
Session 3: 시작 시 컨텍스트 자동 로드
```
모든 세션이 이전에 멈춘 곳에서 이어집니다.

</td>
</tr>
</table>

---

## 제공하는 기능

**검색 가능한 프로젝트 메모리** — "auth에 대해 뭘 결정했지?"라고 물으면 의미 기반으로 즉시 매칭된 답변을 받습니다. 키워드 검색이 아닌 *의미* 검색이며, 로컬 ONNX 임베딩으로 작동합니다.

**스마트 작업 분석** — `buddy-do "add user auth"`는 단순히 실행만 하지 않습니다. 과거 세션에서 관련 컨텍스트를 가져오고, 수립된 패턴을 확인하고, 코드를 한 줄이라도 작성하기 전에 풍부한 계획을 세웁니다.

**선제적 회상** — MeMesh는 세션 시작 시, 테스트 실패 시, 오류 발생 시 관련 기억을 자동으로 표시합니다. 수동 검색이 필요 없습니다.

**워크플로우 자동화** — 시작 시 세션 요약. 파일 변경 추적. 커밋 전 코드 리뷰 알림. 모두 백그라운드에서 조용히 실행됩니다.

**실수 학습** — 오류와 수정 사항을 기록하여 지식 베이스를 구축합니다. 같은 실수는 두 번 일어나지 않습니다.

---

## 시작하기

**필요 조건**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) + Node.js 20+

```bash
npm install -g @pcircle/memesh
```

Claude Code를 재시작하면 끝입니다.

**확인** — Claude Code에서 입력:

```
buddy-help
```

사용 가능한 명령어 목록이 표시되어야 합니다.

<details>
<summary><strong>소스에서 설치</strong> (기여자용)</summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

</details>

---

## 명령어

| 명령어 | 기능 |
|---------|------|
| `buddy-do "작업"` | 전체 메모리 컨텍스트와 함께 작업 실행 |
| `buddy-remember "주제"` | 과거 결정과 컨텍스트 검색 |
| `buddy-help` | 사용 가능한 명령어 표시 |

**실제 사용 예시:**

```bash
# 처음 접하는 코드베이스 파악하기
buddy-do "explain this codebase"

# 과거 작업의 컨텍스트로 기능 구현하기
buddy-do "add user authentication"

# 결정 이유 회상하기
buddy-remember "API design decisions"
buddy-remember "why we chose PostgreSQL"
```

모든 데이터는 로컬 머신에 저장됩니다. 결정사항은 90일, 세션 노트는 30일간 보관됩니다.

---

## CLAUDE.md와 어떻게 다른가요?

| | CLAUDE.md | MeMesh |
|---|-----------|--------|
| **목적** | Claude를 위한 고정된 지시사항 | 프로젝트와 함께 성장하는 살아있는 메모리 |
| **검색** | 수동 텍스트 검색 | 의미 기반 검색 |
| **업데이트** | 수동 편집 | 작업하면서 결정사항을 자동 캡처 |
| **회상** | 항상 로드됨 (길어질 수 있음) | 필요할 때 관련 컨텍스트를 표시 |
| **범위** | 일반적인 설정 | 프로젝트별 지식 그래프 |

**함께 사용하는 것입니다.** CLAUDE.md는 Claude에게 *어떻게* 작업할지 알려줍니다. MeMesh는 *무엇을* 만들었는지 기억합니다.

---

## 플랫폼 지원

| 플랫폼 | 상태 |
|--------|------|
| macOS | ✅ |
| Linux | ✅ |
| Windows | ✅ (WSL2 권장) |

**호환 환경:** Claude Code CLI · VS Code Extension · Cursor (MCP 경유) · 기타 MCP 호환 에디터

---

## 아키텍처

MeMesh는 Claude Code와 함께 로컬 MCP 서버로 실행됩니다:

- **Knowledge Graph** — FTS5 전문 검색을 갖춘 SQLite 기반 엔티티 저장소
- **Vector Embeddings** — 의미 유사도를 위한 ONNX 런타임 (100% 로컬 실행)
- **Content Dedup** — SHA-256 해싱으로 중복 임베딩 연산 건너뛰기
- **Batch Processing** — 대규모 지식 베이스를 위한 효율적인 일괄 처리
- **Hook System** — 세션 시작, 테스트 실패, 오류 시 선제적 회상

모든 것이 로컬에서 실행됩니다. 클라우드 없음. API 호출 없음. 데이터는 절대 머신 밖으로 나가지 않습니다.

---

## 문서

| 문서 | 설명 |
|------|------|
| [시작하기](docs/GETTING_STARTED.md) | 단계별 설정 가이드 |
| [사용자 가이드](docs/USER_GUIDE.md) | 예제 포함 전체 사용 가이드 |
| [명령어](docs/COMMANDS.md) | 전체 명령어 레퍼런스 |
| [아키텍처](docs/ARCHITECTURE.md) | 기술 심층 분석 |
| [기여하기](CONTRIBUTING.md) | 기여 가이드라인 |
| [개발](docs/DEVELOPMENT.md) | 기여자를 위한 개발 환경 설정 |

---

## 기여하기

기여를 환영합니다! 시작하려면 [CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요.

---

## 라이선스

MIT — [LICENSE](LICENSE) 참조

---

<div align="center">

**Claude Code를 위해, Claude Code와 함께 만들었습니다.**

[버그 리포트](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=bug&template=bug_report.yml) · [기능 요청](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions) · [도움 받기](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new)

</div>
