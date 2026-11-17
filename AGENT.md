# AGENT.md

이 저장소에서 일하는 코딩 에이전트를 위한 안내입니다. 사용법과 실행 방법은 README.md를 봅니다.

## 한눈에 보는 구조

요청 하나는 이렇게 흐릅니다 (`apps/server/src/agent/run.ts` `runAgent`).

```
사용자 요청 (확장 사이드 패널 → WebSocket start)
 → 대화 담당 (chat.ts, CHAT_RULES)
     직접 답 / 도구로 확인(read·find_text·view·web_search) / 그림만 만들기(make_image·make_infographic)
     / 문서 점검(review) / 편집 넘기기(request_edit)
 → 계획 담당 (plan.ts, PLAN_RULES) — 문서를 읽고 작업 목록(구조화 출력, schemas.ts taskSchema)
 → 실행 (run.ts executeRound, waves.ts) — 작업을 차례(wave)로 나눠 병렬 실행
     write: 실행 모델이 블씨 마크다운 글 전체 / edit: str_replace 패치 / 그 밖: 고정 연산 (ops.ts OPS)
 → 확장이 문서에 반영 (se-model applyBatch → setDocumentData)
 → 대화 담당이 결과를 검토하고 답하거나 다시 넘긴다
```

- 대화·계획은 각자 LangGraph 대화를 이어 가고(MemorySaver), 마지막 사용자 메시지에만 이번 요청의 맥락을 붙입니다: `사용자 글 → [Turn] → [Context] → [Review] → [Instruction]`(계획만). 지난 턴 메시지는 바꾸지 않습니다 (캐시).
- 회차 반영: 다시 써도 안 되는 단위만 빼고 나머지를 반영합니다. 실패한 작업 뒤의 같은 블록 작업과 지우기는 건너뜁니다. 어느 단위인지 모르는 실패만 회차를 되돌립니다.

### 주요 모듈

| 위치 | 하는 일 |
|---|---|
| `packages/se-model/src/index.ts` | 문서 모델, 블록 참조(`blsee://block/N`), 편집 연산 `applyBatch`, 읽기·개요 |
| `packages/se-model/src/blsee.ts` | 블씨 마크다운 직렬화·파싱, `rebuildBlocks`(바뀐 문단만 다시 만든다) |
| `apps/server/src/agent/blsee.ts` | 패치 적용(`applyPatches`), 반영 전 검사(`checkUnits`) |
| `apps/server/src/agent/prompt.ts` | 모든 담당의 시스템 프롬프트 |
| `apps/server/src/agent/schemas.ts`, `ops.ts` | 계획 출력 스키마, 편집 명령 정의 |
| `apps/server/src/agent/review.ts` | 문서 점검 노드 (조각 나누기 → 병렬 점검 → 사실 확인 → 합치기) |
| `apps/server/src/agent/image-cycle.ts`, `image-agent.ts` | 이미지: 구체화 → 명세 → 그리기 → 판정 사이클 |
| `apps/server/src/agent/infographic-agent.ts` | 인포그래픽: HTML 쓰기·패치 → 렌더 → 판정 |
| `apps/server/src/agent/seed-input.ts` | 이미지·인포그래픽 공통 입력 `[이미지|인포그래픽] → [Original] → [Result] → [Context] → [References]` (원본·결과는 원래 크기, 참조는 768px 그림으로 넣는다) |
| `apps/extension/lib/doc-session.ts` | 확장 쪽 문서 도구 실행 (read_blocks, edit_document, render_view, get_image …) |
| `apps/extension/entrypoints/sidepanel/Chat.tsx` | 채팅 화면, 실행, 질문 카드, 점검 카드, 대화 저장 |

### 블씨 마크다운

에이전트가 문서를 읽고 쓰는 형식입니다 (read 결과와 write·edit 입력이 같은 형식). 한 줄이 한 문단, `#` 소제목, `- ` 목록, `> ` 인용구, `---` 구분선, `$$…$$` 수식, `<table>` 표, `![캡션](URI)` 이미지, 한 줄에 이미지 2~3개면 이미지 묶음, `<!-- blsee://block/N … -->`는 글로 쓸 수 없는 블록입니다. 문단 안 꾸밈은 `<b><i><u><s><span style="color"><a href>`만 씁니다. 이미지 줄·블록 표시 줄·제목 줄을 지우는 결과는 거절됩니다 (지우기는 따로 지우는 작업으로).

## 프롬프트 쓰는 규칙

- 하지 말 것보다 할 것을 긍정형으로 씁니다.
- 시스템 프롬프트에는 행동과 판단 기준만 씁니다. 출력 칸의 뜻·필드 이름·값 설명은 zod 스키마의 `.describe()`에 둡니다.
- 상황별 동작은 few-shot 예시로 씁니다. 형식은 아래처럼, 담당마다 10개 안팎입니다.
  ```
  ## 예시 상황: …
  입력:
  …

  동작:
  - 하는 일을 말로 (도구 이름·호출 문법 대신. 도구가 필요 없으면 "없음")

  응답:
  사용자에게 보일 답, 또는 구조화 출력에 채울 내용
  ```
  예시에 `[도구(인자)]` 같은 코드 모양을 쓰면 모델이 도구를 부르지 않고 그 글을 답으로 씁니다. 그래도 그런 답이 나오면 `tool-text.ts`가 한 번 다시 시킵니다.
- 예시는 일반적인 상황으로 씁니다. 방금 겪은 사례(특정 URI, 특정 대화)를 그대로 옮기지 않습니다.
- 구조화 출력의 예시를 JSON으로 쓰지 않습니다.
- 정확한 글자를 다시 옮겨 적는 일은 모델에게 맡기지 않습니다. 예: 점검 결과에서 고칠 글이 정해진 항목은 서버가 edit 작업 지시로 만듭니다 (`run.ts` `reviewEditTasks`).

## 코드 규칙

- 주석, 오류 메시지, 사용자에게 보이는 글은 한국어로 씁니다. 오류 메시지는 모델이 읽고 고칠 수 있게 무엇을 어떻게 하라는지까지 씁니다.
- se-model은 확장과 서버가 함께 씁니다. 확장에서 도는 코드(applyBatch 등)를 바꾸면 확장도 다시 빌드해야 반영됩니다.
- `packages/se-model/src/blsee.ts`와 `index.ts`는 서로 가져옵니다. blsee.ts 모듈 최상위에서 index의 값을 쓰지 않습니다 (TDZ 오류). 함수 안에서만 씁니다.
- 시험용 연결은 상용이 아닐 때만 켭니다 (`import.meta.env.MODE !== 'production'`). 상용 빌드에 `localhost`가 남지 않는지 확인합니다.
- 확장↔서버 메시지를 바꾸면 `packages/shared`의 타입과 양쪽(`agent-socket.ts`, `apps/extension/lib/server.ts`)을 함께 바꿉니다.
- 저장소는 공개 저장소로 옮겨집니다. 상용 도메인, 서버 주소, 키, 개인 정보를 코드·문서에 넣지 않습니다 (`.env`에 둡니다).

## 바꾸기 전에 확인할 것

- `models.toml`의 모델은 사용자가 품질을 보고 직접 정합니다. 요청 없이 바꾸지 않습니다.
- `portfolio/`는 별도 작업입니다. 커밋에 섞지 않습니다.
- 커밋은 요청받았을 때만 합니다. 작업 브랜치는 `dev`입니다.

## 확인하는 법

1. `npm run compile` (전체 타입 검사)
2. `npm test -w @blog-helper/server`
3. 흐름을 바꿨으면 모의 편집기 시험(README의 "시험")으로 실제 요청을 돌리고, `.e2e-out/`의 채팅 글과 문서 전후를 비교합니다. 서버 로그(`[plan]`, `[review]`, `[image-cycle]`)에 계획과 판정이 찍힙니다 (`ACCESS_KEY_CHECK=off`일 때).
