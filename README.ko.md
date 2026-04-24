🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>Claude Code와 MCP coding agents를 위한 로컬 메모리 레이어.</strong><br />
    SQLite 파일 하나. Docker 불필요. 클라우드 불필요.
  </p>
</p>

> 이 한국어 README는 핵심만 정리한 안내 버전입니다. 최신의 완전한 내용은 [English README](README.md)를 기준으로 보세요.

## 어떤 문제를 해결하나?

coding agent는 세션이 바뀌면 맥락을 잃기 쉽습니다. 아키텍처 결정, 버그를 고친 과정, 이미 배운 교훈, 프로젝트 제약을 계속 다시 설명해야 합니다.

**MeMesh는 이런 지식을 로컬에 남기고, 검색 가능하게 유지하며, 나중에 다시 불러올 수 있게 해줍니다.**

이 npm package는 MeMesh의 로컬 plugin / package 버전입니다. 클라우드 워크스페이스나 엔터프라이즈 플랫폼 전체를 담은 제품은 아닙니다.

## 60초 시작

### 1. 설치

```bash
npm install -g @pcircle/memesh
```

### 2. 결정 하나 저장

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### 3. 나중에 다시 찾기

```bash
memesh recall "login security"
# → 표현이 달라도 "OAuth 2.0 with PKCE"를 찾을 수 있습니다
```

대시보드 열기:

```bash
memesh
```

## 이런 사용자에게 맞습니다

- Claude Code를 쓰면서 세션 사이에도 프로젝트 맥락을 유지하고 싶은 개발자
- 같은 로컬 메모리를 여러 MCP coding agents에서 함께 쓰고 싶은 고급 사용자
- export / import로 팀 지식을 공유하려는 소규모 AI-native 개발팀
- CLI, HTTP, MCP 흐름에 로컬 메모리를 붙이고 싶은 agent 개발자

## 왜 MeMesh인가?

- 로컬 우선: 데이터가 내 SQLite 파일에 저장됨
- 가벼운 설치: `npm install -g` 후 바로 사용 가능
- 연결 방식이 명확함: CLI, HTTP, MCP 지원
- Claude Code 친화적: hooks로 작업 중 관련 메모리를 쉽게 불러옴
- 확인과 정리가 쉬움: dashboard가 있어 블랙박스가 아님
- import 안전 경계: import한 메모리는 검색되더라도, 검토하거나 다시 저장하기 전에는 Claude hooks에 자동 주입되지 않음

## Claude Code에서 자동으로 하는 일

MeMesh는 현재 다음 5가지 시점에 도움을 줍니다.

- 세션 시작 시 관련 메모리와 이미 배운 교훈을 불러옴
- 파일 편집 전에 그 파일이나 프로젝트와 관련된 메모리를 먼저 찾음
- `git commit` 후 변경 내용을 기록함
- 세션 종료 시 이번 수정, 오류, lesson learned를 정리함
- context compact 전에 중요한 내용을 로컬 메모리에 저장함

## Dashboard에는 무엇이 있나?

Dashboard는 현재 7개 탭과 11개 언어를 지원합니다.

- Search: 메모리 검색
- Browse: 전체 메모리 보기
- Analytics: 건강도와 추세 확인
- Graph: 지식 관계 보기
- Lessons: 과거 교훈 보기
- Manage: 아카이브와 복원
- Settings: LLM provider와 언어 설정

## Smart Mode란?

MeMesh는 기본적으로 오프라인에서 사용할 수 있습니다. 여기에 LLM API key를 설정하면 다음과 같은 기능을 더 쓸 수 있습니다.

- query expansion
- 더 나은 자동 추출
- 더 똑똑한 정리와 압축

API key가 없어도 핵심 기능은 그대로 사용할 수 있습니다.

## 더 알아보기

- 전체 기능, 비교, API, release 정보: [English README](README.md)
- 플랫폼별 안내: [docs/platforms/README.md](docs/platforms/README.md)
- API 참고: [docs/api/API_REFERENCE.md](docs/api/API_REFERENCE.md)

## 개발과 검증

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory
npm install
npm run build
npm test
```
