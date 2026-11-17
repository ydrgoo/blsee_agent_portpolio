# 블씨 (blsee)

네이버 블로그 글쓰기 도우미입니다. 크롬 확장의 사이드 패널에서 글에 대해 묻고, 고치고, 이어 쓰고, 점검하고, 이미지·인포그래픽을 만들어 넣습니다.

- 글 다듬기·이어 쓰기·구조 바꾸기(목록 → 표 등)·서식 바꾸기
- 문서 점검: 맞춤법, 사실 확인(웹 검색), 말투 통일, 흐름 — 결과를 번호로 골라 고치기
- 이미지 만들기·고치기, 인포그래픽(HTML → PNG), 이미지 묶음(사진 2~3장 나란히)
- 글의 블록을 `@`로 참조, 보관함(작업공간 폴더)에 대화·이미지·검색 자료 저장

## 구성

```
apps/
  extension/     크롬 확장 (WXT + React). 사이드 패널, 에디터 콘텐츠 스크립트, 문서 도구 실행
  server/        에이전트 서버 (Hono + LangChain + Gemini). WebSocket으로 확장과 대화한다
  mock-editor/   시험용 모의 스마트에디터 (Vite) + Playwright 시험 스크립트 (개발 전용)
packages/
  se-model/      스마트에디터 ONE 문서 모델·편집 연산·블씨 마크다운 (확장·서버 공용)
  shared/        확장↔서버 메시지 타입, 문서 도구 이름, 공용 상수
test-data/       실제 글 문서 데이터 (시험용)
```

문서는 확장이 들고 있고, 서버는 문서 도구(`read_blocks`, `edit_document` 등)를 WebSocket으로 불러 읽고 고칩니다. 편집은 확장이 문서 데이터를 다시 쓰는 방식으로 에디터에 반영하고, 이미지는 에디터에 붙여넣기로 올린 뒤 자리를 맞춥니다.

## 준비

- Node.js 20 이상 (개발은 최신 Node에서 확인)
- 크롬

```bash
npm install
```

### 서버 설정

`apps/server/.env` (예시: `apps/server/.env.example`)

| 키 | 용도 |
|---|---|
| `GOOGLE_API_KEY` | Gemini (대화·계획·실행·이미지·보기) |
| `PERPLEXITY_API_KEY` | 웹 검색 |
| `ADMIN_TOKEN` | 관리자 화면(`/admin`) 토큰. 비우면 관리자 화면이 꺼진다 |
| `ACCESS_KEY_CHECK=off` | 개발용. 접근 키 없이 쓴다 (상용 서버에는 넣지 않는다) |

모델은 `apps/server/models.toml`에서 노드별로 고릅니다. 가격표(`src/pricing.ts`)에 없는 모델이면 서버가 뜨지 않습니다.

| 노드 | 하는 일 |
|---|---|
| `chat` | 사용자와 대화, 점검, 편집 결과 검토 |
| `plan` | 편집 계획 (작업 목록) |
| `action` / `write` | 글 고치기(패치) / 새 글 쓰기 |
| `review` | 문서 점검 (조각·사진·전체 점검, 사실 판정) |
| `image-instruction` / `image-draw` / `image-judge` | 이미지 명세 / 픽셀 그리기 / 판정 |
| `infographic-draw` / `infographic-judge` | 인포그래픽 HTML 쓰기·고치기 / 판정 |
| `prompt-make` / `prompt-normalize` / `prompt-extract` | 프롬프트 쓰기(`/make-prompt`) / 매번 바꿀 값을 칸으로 일반화 / 이름·설명·칸 설명 뽑기 |
| `view` | 그림을 보고 질문에 답하기 |
| `search` | 웹 검색 (Perplexity) |

### 확장 설정

`apps/extension/.env`의 `WXT_API_BASE_URL`에 상용 서버 주소를 넣습니다. 배포 빌드에는 꼭 필요합니다. 개발 빌드는 설정에서 로컬 서버(`http://localhost:8787`)를 고를 수 있습니다.

## 개발

```bash
npm run dev:server     # 서버 (http://localhost:8787, 파일이 바뀌면 다시 뜬다)
npm run dev:ext        # 확장 개발 빌드 + 개발용 크롬 (프로필: apps/extension/.wxt/chrome-data)
```

네이버 블로그 글쓰기 화면을 열고 툴바의 블씨 아이콘(또는 Alt+Shift+B)으로 사이드 패널을 엽니다.

### 접근 키

```bash
npm run key -- list                 # 키 목록과 장작(사용량) 현황
npm run key -- add <이름> <장작>    # 새 키 발급
npm run key -- topup <이름> <장작>  # 장작 충전
```

관리자 화면(`/admin`)에서도 할 수 있습니다.

## 시험

### 단위 시험

```bash
npm test -w @blog-helper/server     # 블씨 마크다운 왕복, 편집, 계획, 점검 도우미 등
npm run compile                     # 전체 타입 검사
```

### 모의 편집기로 확장 끝까지 시험 (실제 모델 호출)

실제 네이버 에디터 대신 모의 편집기에 시험 빌드 확장을 붙여, 사이드 패널을 Playwright로 돌립니다.

```bash
npx playwright install chromium               # 처음 한 번
npm run dev:server                            # 서버
npm run dev -w @blog-helper/mock-editor       # 모의 편집기 (http://localhost:5179)
cd apps/extension && npx wxt build --mode e2e # 시험 빌드 (로컬 서버·모의 편집기에 붙는다)
npx tsx apps/mock-editor/e2e/run.ts typo      # 시나리오: smoke, typo, fact, tone
```

결과(사이드 패널 캡처, 채팅 글, 문서 전후 JSON)는 `apps/mock-editor/.e2e-out/`에 남습니다. 시나리오는 `e2e/run.ts`의 `SCENARIOS`에 더합니다. 모의 편집기 연결(`localhost:5179`, `?editorTab=mock`)은 상용 빌드에 들어가지 않습니다.

## 빌드·배포

```bash
npm run build      # 확장 상용 빌드 → apps/extension/.output/chrome-mv3
npm run zip:ext    # 스토어용 zip → apps/extension/.output/*-chrome.zip
```

버전은 `apps/extension/package.json`의 `version`입니다.

