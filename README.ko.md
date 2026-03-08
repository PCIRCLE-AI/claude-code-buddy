<div align="center">

# 🧠 MeMesh Plugin

### Claude Code 생산성 플러그인

메모리, 스마트 작업 분석, 워크플로우 자동화 — 하나의 플러그인으로.

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io)

[설치](#설치) • [사용법](#사용법) • [문제 해결](#문제-해결)

[English](README.md) • [繁體中文](README.zh-TW.md) • [简体中文](README.zh-CN.md) • [日本語](README.ja.md) • **한국어** • [Français](README.fr.md) • [Deutsch](README.de.md) • [Español](README.es.md) • [Tiếng Việt](README.vi.md) • [ภาษาไทย](README.th.md) • [Bahasa Indonesia](README.id.md)

</div>

---

## 왜 이 프로젝트를 만들었나

이 프로젝트는 더 많은 사람들 — 특히 코딩을 처음 접하는 분들 — 이 Claude Code로 vibe coding을 더 잘 활용할 수 있도록 돕고 싶어서 시작했습니다. 프로젝트가 커지면 세션을 넘나드는 모든 결정을 추적하기 어려워진다는 걸 깨달았습니다. 그래서 (당연히 Claude Code와 함께) 여러분을 위해 기억해주는 플러그인을 만들었습니다.

> **참고**: 이 프로젝트는 원래 "Claude Code Buddy"라는 이름이었으며, 상표 문제를 피하기 위해 MeMesh Plugin으로 이름을 변경했습니다.

## 무엇을 할 수 있나요?

MeMesh Plugin은 Claude Code를 더 똑똑하고 생산적으로 만듭니다. 단순한 메모리가 아닌 풀 툴킷입니다:

**검색 가능한 프로젝트 메모리** — 작업 중 결정, 패턴, 교훈을 자동 저장. 의미로 검색 가능. "auth에 대해 뭘 결정했지?"라고 물으면 즉시 답변.

**스마트 작업 분석** — `buddy-do "사용자 인증 추가"` 라고 하면, MeMesh가 작업을 분석하고 과거 작업에서 컨텍스트를 가져와 실행 전에 풍부한 계획을 제공합니다.

**워크플로우 자동화** — MeMesh가 백그라운드에서 자동으로:
- 세션 시작 시 지난 작업 요약 표시
- 변경/테스트한 파일 추적
- 커밋 전 코드 리뷰 알림
- 작업을 최적의 모델로 라우팅

**실수에서 배우기** — 오류와 수정 사항을 기록하여 같은 실수를 반복하지 않는 지식 베이스 구축.

**Claude 내장 메모리와 뭐가 다른가요?**

Claude Code에는 이미 auto memory와 CLAUDE.md가 있습니다 — 일반적인 설정과 지시에 적합합니다. MeMesh는 여기에 프로젝트 수준의 **전용 도구**를 추가합니다: 의미로 검색할 수 있는 메모리, 과거 컨텍스트를 활용하는 작업 분석, 매 세션을 더 생산적으로 만드는 자동화 워크플로우.

이렇게 생각하세요:
- **CLAUDE.md** = Claude를 위한 사용 설명서
- **MeMesh** = 검색 가능한 노트북 + 프로젝트와 함께 성장하는 스마트 어시스턴트

---

## 설치

**필요한 것**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code)와 Node.js 20+

```bash
npm install -g @pcircle/memesh
```

Claude Code를 재시작하면 끝.

**작동 확인** — Claude Code에서 입력:

```
buddy-help
```

명령어 목록이 보이면 성공입니다.

<details>
<summary>소스에서 설치 (기여자용)</summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

</details>

---

## 사용법

MeMesh는 Claude Code에 3개의 명령어를 추가합니다:

| 명령어 | 기능 |
|--------|------|
| `buddy-do "작업"` | 메모리 컨텍스트와 함께 작업 실행 |
| `buddy-remember "주제"` | 과거 결정과 컨텍스트 검색 |
| `buddy-help` | 사용 가능한 명령어 표시 |

**예시:**

```bash
buddy-do "이 코드베이스 설명해줘"
buddy-do "사용자 인증 추가해줘"
buddy-remember "API 설계 결정사항"
buddy-remember "왜 PostgreSQL을 선택했는지"
```

모든 데이터는 로컬 머신에 저장됩니다. 결정사항은 90일, 세션 노트는 30일간 보관됩니다.

---

## 지원 환경

| 플랫폼 | 상태 |
|--------|------|
| **macOS** | ✅ 지원 |
| **Linux** | ✅ 지원 |
| **Windows** | ✅ 지원 (WSL2 권장) |

**함께 사용 가능:**
- Claude Code CLI (터미널)
- Claude Code VS Code 확장
- Cursor (MCP 경유)
- 기타 MCP 호환 에디터

**Claude Desktop (Cowork)**: 기본 명령어는 작동하지만, 메모리 기능은 CLI 버전이 필요합니다. [Cowork 상세](docs/COWORK_SUPPORT.md)를 참고하세요.

---

## 문제 해결

**MeMesh가 나타나지 않나요?**

```bash
# 설치 확인
npm list -g @pcircle/memesh

# Node.js 버전 확인 (20+ 필요)
node --version

# 설정 다시 실행
memesh setup
```

그런 다음 Claude Code를 완전히 재시작하세요.

추가 도움: [문제 해결 가이드](docs/TROUBLESHOOTING.md)

---

## 더 알아보기

- **[시작하기](docs/GETTING_STARTED.md)** — 단계별 설정
- **[사용자 가이드](docs/USER_GUIDE.md)** — 예제 포함 전체 가이드
- **[명령어](docs/COMMANDS.md)** — 모든 사용 가능한 명령어
- **[아키텍처](docs/ARCHITECTURE.md)** — 내부 작동 원리
- **[기여하기](CONTRIBUTING.md)** — 도와주고 싶다면? 여기서 시작
- **[개발 가이드](docs/DEVELOPMENT.md)** — 기여자용

---

## 라이선스

MIT — [LICENSE](LICENSE) 참조

---

<div align="center">

문제가 있나요? [이슈 열기](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new) — 빠르게 응답합니다.

[버그 리포트](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=bug&template=bug_report.yml) • [기능 요청](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions)

</div>
