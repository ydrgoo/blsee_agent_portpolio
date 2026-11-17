import type { EditOp, ReadBlocksArgs } from '@blog-helper/se-model';

/** 에이전트에게 넘기는 이전 대화. 도구 호출 내역은 빼고 사람이 본 말만 남긴다. */
export interface ChatTurn {
  /** 턴 ID. 사용자 턴의 TurnMeta를 찾는 키 (예전 대화에는 없을 수 있다) */
  id?: string;
  role: 'user' | 'assistant';
  /** 사용자가 쓴 말 / 에이전트의 답 그대로 */
  text: string;
}

/**
 * 입력창에서 붙인 참조. 문서 위치(doc)와 칩 미리보기(lib)를 나눈다.
 * 문단 등은 doc만, 보관본만 참조면 lib만, 글 안 이미지는 둘 다 둘 수 있다.
 * src는 모델에게 줄 파일이다. 인포그래픽이면 lib(렌더) 대신 infographics URI다.
 */
export interface RefItem {
  /** 칩·목록 라벨 (예: "문단: 그래서 그날…", "현재 위치 · 문단: …") */
  label: string;
  /** 문서 위치 URI (blsee://block/N, …/image, range…) */
  doc?: string;
  /** 칩이 보여주는 보관 이미지 URI (blsee://lib/images/…, blsee://gen/…) */
  lib?: string;
  /** 모델에게 줄 파일. 없으면 lib를 쓴다. 인포그래픽이면 blsee://lib/infographics/… */
  src?: string;
  /** @ 피커의 「현재 위치」로 붙인 칩 */
  current?: boolean;
}

/** 턴에서 가리키거나 참조하는 한 곳. 모델에게는 doc와 src만 보인다. */
export interface TurnPoint {
  /** 글 안 위치 (blsee://block/…) */
  doc?: string;
  /** 고칠 파일 하나. 사진이면 lib/images, 인포그래픽이면 lib/infographics */
  src?: string;
}

/**
 * 사용자 턴에 딸린 정보. 턴 글과 따로 저장하고, 에이전트에게 보낼 때 서버가 그 턴 글 뒤에 늘 같은 모양으로 붙인다
 * (지난 턴도 처음 보낼 때와 글자가 같아야 프롬프트 캐시가 맞는다).
 */
export interface TurnMeta {
  /** 보낸 시각 (사용자 PC 기준, 예: "2026-11-02 00:45 (월)") */
  time?: string;
  /** 첨부한 이미지 URI */
  attached?: string[];
  /** 그때 에디터에서 가리킨 곳. 이미지 묶음이면 장마다 하나 */
  pointed?: TurnPoint[];
  /** 현재 위치가 아닌 composer 참조 칩들 */
  refs?: RefItem[];
}

/**
 * 확장이 실행하는 호출. 글과 이미지는 확장에만 있고, 서버가 부르면 확장이 실행해서 결과 글을 돌려준다.
 * 앞의 셋은 에이전트 읽기 도구 그대로이고, 나머지는 서버가 편집 회차를 진행하거나 view/이미지 만들기 도구 안에서 쓴다.
 */
export interface DocToolArgs {
  get_outline: Record<string, never>;
  read_blocks: ReadBlocksArgs;
  find_text: { query: string };
  edit_document: { operations: EditOp[] };
  /** 편집 회차 시작: 지금 작업본을 저장해 둔다. */
  begin_round: Record<string, never>;
  /** 편집 회차 취소: begin_round 때의 작업본으로 되돌린다. */
  rollback_round: Record<string, never>;
  /** 결과: ViewImages JSON */
  /** perBlock이면 범위 안 블록을 하나씩 그린다 (이미지 블록도 원본이 아니라 글에 보이는 모습으로). 점검이 높이로 묶을 때 쓴다. */
  render_view: { targets: string[]; perBlock?: boolean };
  /** 결과: ImageInput JSON. maxSide가 있으면 긴 변을 그 픽셀 이하로 줄여 돌려준다 (작으면 그대로). */
  get_image: { uri: string; maxSide?: number };
  /**
   * 글에 있는 이미지(blsee://block/N/image…)를 원본으로 보관한다. 같은 원본을 이미 보관했으면 그 URI를 돌려준다.
   * 이미 보관된 이미지 URI(blsee://lib/images/…)는 그대로 돌려준다. 결과: 이미지 URI
   */
  import_image: { uri: string };
  /** 결과: 새 이미지 URI (blsee://lib/images/{ID}) */
  /** caption: 글에 넣을 때 반드시 달 캡션 (웹 이미지의 출처). ai: AI로 만든 이미지 (에디터의 "AI 활용" 표시) */
  /** name: 사람이 알아볼 짧은 이름 (내려받을 때 파일 이름) */
  store_image: { image: ImageInput; source: string; instruction: string; caption?: string; ai?: boolean; name?: string };
  /** SVG를 PNG로 그려 보관한다. 결과: 새 이미지 URI (blsee://lib/images/{ID}) */
  store_svg: { svg: string; instruction: string; name?: string };
  /** HTML을 width 폭으로 그려 PNG로 보관한다. HTML 원본도 함께 저장한다. 결과: 새 이미지 URI (blsee://lib/images/{ID}) */
  store_html: { html: string; width: number; instruction: string; name?: string };
  /**
   * 인포그래픽 HTML 원본을 읽는다. uri는 이미지(blsee://lib/images/…, 메타의 htmlUri) 또는 인포(blsee://lib/infographics/…, 옛 lib/html/…).
   * 결과: HTML 본문
   */
  get_html: { uri: string };
  /**
   * 쓸 수 있는 글꼴 목록 (번들 + 작업공간). 결과: 글.
   * 인포그래픽 HTML의 font-family에 family 이름을 그대로 쓴다.
   */
  list_fonts: Record<string, never>;
  /**
   * 글꼴 파일을 작업공간에 보관한다. 결과: blsee://lib/fonts/{ID}
   * (서버가 받은 뒤 넘긴다. 사용자 확인은 서버 download_font가 한다.)
   */
  store_font: { name: string; family: string; source: string; font: ImageInput };

  /* 라이브러리 (작업공간이 있을 때만. start의 library가 true일 때만 부른다) */

  /** 검색 결과를 md로 저장한다. content는 마크다운 (답과 출처). 결과: 자료 URI (blsee://lib/research/{ID}) */
  store_research: { query: string; content: string; kind: ResearchKind };
  /** 라이브러리에서 이미지와 검색 자료를 찾는다. 결과: 찾은 것 목록 (글) */
  search_library: { query: string; kind?: 'image' | 'research'; limit?: number };
  /** 검색 자료 하나를 읽는다. 결과: md 본문 */
  read_research: { uri: string };
  /** 저장 프롬프트를 md로 남긴다. 결과: 커맨드 이름 (`그림_그리기`) */
  store_prompt: {
    name: string;
    command: string;
    description?: string;
    scope: PromptScope;
    body: string;
    params: PromptParam[];
  };
}

/** 채팅에서만 보이는 프롬프트 작성 커맨드: 지금까지의 작업을 프롬프트로 만든다 */
export const PROMPT_MAKE_COMMAND = 'make-prompt';
export const PROMPT_MAKE_LABEL = '프롬프트 만들기';
/** 채팅에서만 보이는 프롬프트 저장 커맨드: 사용자가 준 프롬프트 원문을 그대로 저장한다 */
export const PROMPT_SAVE_COMMAND = 'save-prompt';
export const PROMPT_SAVE_LABEL = '프롬프트 저장';
/** 저장한 프롬프트의 명령으로 쓸 수 없는 이름 */
export const RESERVED_PROMPT_COMMANDS: readonly string[] = [PROMPT_MAKE_COMMAND, PROMPT_SAVE_COMMAND];

/** 소문자 영문, 숫자, -, _ 로 된 커맨드 이름 */
export const COMMAND_NAME_RE = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

export function isCommandName(value: string): boolean {
  return COMMAND_NAME_RE.test(value);
}

/** 커맨드 이름 규칙에 맞게 고친다. 한글처럼 남길 글자가 없으면 빈 문자열이다. */
export function commandNameOf(raw: string): string {
  const command = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/[_-]{2,}/g, '-')
    .replace(/^[_-]+|[_-]+$/g, '');
  return isCommandName(command) ? command : '';
}

/** 검색어가 커맨드 앞부분 또는 별칭에 맞는지. 별칭은 공백, -, _ 를 빼고 비교한다. */
export function commandQueryMatch(query: string, command: string, label: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (command.toLowerCase().startsWith(q)) return true;
  const fold = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, '');
  return fold(label).includes(fold(q));
}

export type PromptScope = 'post' | 'all';
/** 저장 프롬프트의 칸. 모두 글로 받는다 (참조도 URI 글이다). 본문에는 {{name}}으로 들어간다. */
export interface PromptParam {
  /** 칸 이름: 소문자 영문·숫자·- (예: character-name) */
  name: string;
  /** 칸에 무엇을 적는지 (실행 카드에 안내로 보인다) */
  description?: string;
}

/** 칸 이름으로 쓸 수 있게 바꾼다: 소문자 영문·숫자·-. 남는 글자가 없으면 빈 글 */
export function paramNameOf(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/** `/make-prompt`·`/save-prompt`를 보낸 뒤 받는 두 칸 */
export interface PromptCreate {
  /** make: 요청사항 (없으면 대화만 보고 작성한다) / save: 저장할 프롬프트 원문 */
  instruction: string;
  scope: PromptScope;
  /** make: 지금까지의 작업으로 프롬프트를 만든다 / save: 원문을 그대로 저장한다 (없으면 make) */
  mode?: 'make' | 'save';
  /** save: 정리할 때 따를 요청사항 (어느 값을 칸으로 둘지 등). make는 instruction이 요청사항이다 */
  request?: string;
}

/** 별칭에서 커맨드 이름을 만든다. 규칙에 맞는 글자가 없으면 `prompt`다. */
export function promptCommandOf(name: string): string {
  const command = commandNameOf(name);
  return command && !RESERVED_PROMPT_COMMANDS.includes(command) ? command : 'prompt';
}

export type ResearchKind = 'web_search' | 'fact_check';

export const RESEARCH_URI_SRC = String.raw`blsee://lib/research/[a-z0-9]+`;
export const researchUri = (id: string) => `blsee://lib/research/${id}`;
/** 인포 원본 URI (새 경로 + 예전 lib/html) */
export const HTML_URI_SRC = String.raw`blsee://lib/(?:infographics|html)/[a-z0-9]+`;
/** 새로 저장할 때는 항상 lib/infographics */
export const htmlUri = (id: string) => `blsee://lib/infographics/${id}`;
export const isHtmlUri = (uri: string) => new RegExp(`^${HTML_URI_SRC}$`).test(uri);
/** 보관된 사진·일러스트 (렌더 PNG, 예전 gen). 인포그래픽 파일은 여기 아니다. */
export const isImageFileUri = (uri: string) => /^blsee:\/\/(?:lib\/images\/[a-z0-9]+|gen\/[a-z0-9]+)$/.test(uri);
/** 같은 인포의 새·옛 URI (조회 시 둘 다 시도) */
export function htmlUriVariants(uri: string): string[] {
  const m = /^blsee:\/\/lib\/(?:infographics|html)\/([a-z0-9]+)$/.exec(uri);
  if (!m) return [uri];
  return [`blsee://lib/infographics/${m[1]}`, `blsee://lib/html/${m[1]}`];
}
export const FONT_URI_SRC = String.raw`blsee://lib/fonts/[a-z0-9]+`;
export const fontUri = (id: string) => `blsee://lib/fonts/${id}`;

export type DocToolName = keyof DocToolArgs;

export const DOC_TOOL_NAMES = [
  'get_outline',
  'read_blocks',
  'find_text',
  'edit_document',
  'begin_round',
  'rollback_round',
  'render_view',
  'get_image',
  'import_image',
  'store_image',
  'store_svg',
  'store_html',
  'get_html',
  'list_fonts',
  'store_font',
  'store_research',
  'search_library',
  'read_research',
  'store_prompt',
] as const satisfies readonly DocToolName[];

export interface ViewImage extends ImageInput {
  /** 무엇을 그린 그림인지 (예: "blsee://block?from=1&to=3", "blsee://block/4/image", "blsee://block?from=5&to=20 (2/3)") */
  label: string;
}

export interface ViewImages {
  images: ViewImage[];
  /** 그리지 못한 대상 등 */
  notes: string[];
}

/** 모델 호출 사용량. 계획/실행/검토 에이전트, 보는 모델(view), 이미지 모델(edit_image), 검색(web_search)을 모두 센다. */
export type UsagePurpose = 'chat' | 'plan' | 'action' | 'view' | 'image_agent' | 'draw_agent' | 'image_edit' | 'search' | 'review';

/** 사용자 화면에 보이는 작업 하나 */
export interface PlanTaskView {
  id: string;
  /** 한 줄 설명 (한국어) */
  title: string;
}

/** cancelled: 다른 작업이 실패해 회차가 취소되면서 실행하지 않았거나 되돌린 작업 */
export type TaskState = 'running' | 'done' | 'failed' | 'cancelled';

/** 사용량 단위 "장작" 1개의 내부 환산값 (원). 사용자에게는 보이지 않는다. */
export const WOOD_KRW = 30;

export interface UsageEntry {
  model: string;
  purpose: UsagePurpose;
  calls: number;
  /** 캐시에서 읽은 입력 포함 */
  inputTokens: number;
  /** 생각 토큰 포함 */
  outputTokens: number;
  /** 입력 중 캐시에서 읽은 토큰 (입력 단가의 10%) */
  cachedTokens: number;
}

/** 점검(review) 결과 항목 하나 */
export interface ReviewItem {
  /** 항목 번호 (예: rv1-3) */
  id: string;
  /** 지적한 곳 (블록 또는 블록 이미지 URI) */
  uri: string;
  /** 몇 번째 점검 사항(notes, 1부터)에서 나왔는지 */
  note: number;
  /** 블록에 보이는 글 그대로의 원래 글 (고칠 곳이 글일 때) */
  original?: string;
  /** 고칠 글. 정해지지 않았으면 없다 (흐름·보강 등) */
  suggestion?: string;
  reason: string;
}

/** 점검 한 번의 결과. 편집이 한 번 반영되면 만료된다. */
export interface ReviewResult {
  /** 점검 번호 (예: rv1) */
  id: string;
  notes: string[];
  /** 점검한 범위 (사람이 읽는 글) */
  scope: string;
  items: ReviewItem[];
  /** 점검하지 못한 범위·이유 */
  missed?: string[];
}

/** 확장 → 서버 (WebSocket) */
export type ClientMessage =
  | {
      type: 'start';
      /** 발급받은 접근 키 (WebSocket은 헤더를 못 붙여서 메시지에 담는다) */
      key: string;
      history: ChatTurn[];
      /** history의 사용자 턴 ID → 그 턴의 정보 */
      turnMeta?: Record<string, TurnMeta>;
      /** 이번 요청의 턴 ID (대화 기록에 같은 ID로 남긴다) */
      turnId?: string;
      message: string;
      /** 이번 요청을 보낸 시각 (TurnMeta.time과 같은 모양) */
      time?: string;
      /** 이번 요청에 첨부한 이미지 URI */
      attached?: string[];
      /** 요청 시작 시점 문서 개요 (본문 전체가 아니다) */
      outline: string;
      /** 이번 요청에서 가리킨 곳 (doc / src) */
      pointed?: TurnPoint[];
      /** 현재 위치가 아닌 참조 칩. 모델에게는 doc와 src만 전달된다 */
      refs?: RefItem[];
      /** 이 대화에서 지금까지 만든 이미지 (예: "blsee://lib/images/k3x9qa2m: 배경을 수채화로") */
      images?: string[];
      /** 작업공간 라이브러리를 쓸 수 있다 (검색 자료 저장, 라이브러리 검색) */
      library?: boolean;
      /** 빠른 실행으로 보낸 요청. message는 일반 채팅처럼 PRESETS[id].message를 담는다. */
      preset?: PresetRequest;
      /** `/make-prompt`의 요청사항과 스코프. 있으면 계획 없이 프롬프트를 저장한다. */
      promptCreate?: PromptCreate;
      /** 사용자 언어·지역 (BCP 47, 예: "ko-KR"). 그림 속 사람·글자·생활 모습의 기본값이 된다. */
      locale?: string;
      /** 아직 만료되지 않은 점검 결과 (편집이 반영되면 만료된다) */
      reviews?: ReviewResult[];
    }
  | { type: 'tool_result'; callId: string; content: string }
  /** ask에 대한 사용자 답 */
  /** 에이전트 ask에 대한 답. action으로 accept/decline/cancel을 구분한다. */
  | ({ type: 'answer' } & AskAnswer);

/** 빠른 실행: 블록 하나(또는 범위)에 정해진 일을 한다. 지시와 실행 방식(검토 여부 등)은 서버가 정한다. */
export type PresetId = 'tone' | 'fact_check' | 'infographic' | 'image' | 'remove_bg' | 'tidy_table';

/** 빠른 실행을 쓸 수 있는 블록. any는 범위 선택을 포함한 어떤 블록이든 (제목 제외) */
export type PresetBlock = 'text' | 'image' | 'table' | 'any';

/** 기본 커맨드 칸. block은 현재 선택, text는 빈 글이 기본값이다. */
export interface PresetParam {
  name: string;
  kind: 'block' | 'text';
}

export const PRESET_PARAMS: PresetParam[] = [
  { name: '대상', kind: 'block' },
  { name: '지시', kind: 'text' },
];

export interface PresetInfo {
  /** 슬래시에 치는 커맨드 이름 */
  command: string;
  /** 메뉴에 보일 별칭 */
  label: string;
  /** 대화에 사용자 말로 남는 요청 */
  message: string;
  on: PresetBlock;
  params: PresetParam[];
  /** 자세히 보기에 보일 소개 */
  description: string;
  /** 자세히 보기에 보일 진행 순서 */
  steps: string[];
}

const preset = (id: PresetId, info: Omit<PresetInfo, 'params' | 'command'>): PresetInfo => ({
  ...info,
  command: id.replace(/_/g, '-'),
  params: PRESET_PARAMS,
});

export const PRESETS: Record<PresetId, PresetInfo> = {
  tone: preset('tone', {
    label: '말투 다듬기',
    message: '이 문단 말투를 글 전체와 어울리게 다듬어 줘.',
    on: 'text',
    description: '가리킨 문단의 말투(존댓말·반말, 문장 끝, 어휘)를 글 전체의 말투에 맞춰 고쳐요. 뜻과 내용은 그대로 둬요.',
    steps: ['글 전체의 말투를 읽어요', '문단에서 어긋나는 문장을 골라 고쳐요', '고친 문단을 바로 반영해요'],
  }),
  fact_check: preset('fact_check', {
    label: '사실 확인',
    message: '이 문단 내용이 사실인지 확인해 줘.',
    on: 'text',
    description: '가리킨 문단에서 숫자·날짜·이름처럼 확인할 수 있는 내용을 골라 웹에서 찾아보고, 맞는지·틀린지·확인 못 함으로 알려 줘요. 고칠 곳은 번호를 골라 바로 고칠 수 있어요.',
    steps: ['문단에서 확인할 내용을 뽑아요', '웹에서 찾아 근거와 함께 판정해요', '점검 카드로 보여 주고, 고를 번호를 고르면 고쳐요'],
  }),
  infographic: preset('infographic', {
    label: '인포그래픽 넣기',
    message: '이 부분 내용으로 인포그래픽을 만들어 바로 아래에 넣어 줘.',
    on: 'any',
    description: '가리킨 부분의 내용을 정리해 표·도표 모양의 인포그래픽 그림으로 만들고, 바로 아래에 넣어요.',
    steps: ['가리킨 부분에서 담을 내용을 골라요', 'HTML로 그리고 그림으로 바꿔 직접 확인해요', '확인한 그림을 바로 아래에 넣어요'],
  }),
  image: preset('image', {
    label: '이미지 넣기',
    message: '이 부분에 어울리는 이미지를 만들어 바로 아래에 넣어 줘.',
    on: 'any',
    description: '가리킨 부분의 내용과 글 분위기에 맞는 그림을 새로 만들어 바로 아래에 넣어요.',
    steps: ['가리킨 부분과 글 분위기를 읽어요', '그림을 만들고 내용에 맞는지 확인해요', '확인한 그림을 바로 아래에 넣어요'],
  }),
  remove_bg: preset('remove_bg', {
    label: '배경 지우기',
    message: '이 사진 배경을 지워 줘.',
    on: 'image',
    description: '가리킨 사진에서 주인공만 남기고 배경을 지운 그림으로 바꿔요.',
    steps: ['사진에서 남길 대상을 찾아요', '배경을 지운 그림을 만들고 확인해요', '원래 사진 자리에 바꿔 넣어요'],
  }),
  tidy_table: preset('tidy_table', {
    label: '표 정리',
    message: '이 표를 보기 좋게 정리해 줘.',
    on: 'table',
    description: '가리킨 표의 칸 맞춤, 머리글, 빈칸, 단위 표기를 가지런히 정리해요. 표 안의 값은 바꾸지 않아요.',
    steps: ['표의 머리글과 값을 읽어요', '어긋난 칸과 표기를 고쳐요', '정리한 표를 바로 반영해요'],
  }),
};

/** 에디터 블록 종류(@ctype)가 빠른 실행의 어느 블록인지. 제목처럼 빠른 실행을 쓰지 않는 블록은 null */
export function presetBlockOf(ctype: string): Exclude<PresetBlock, 'any'> | 'other' | null {
  if (ctype === 'documentTitle') return null;
  if (ctype === 'text' || ctype === 'image' || ctype === 'table') return ctype;
  return 'other';
}

/** 이 블록(여러 블록이면 null 대신 'other'로 본다)에서 보일 빠른 실행 */
export function presetsFor(block: ReturnType<typeof presetBlockOf>, multiple = false): PresetId[] {
  if (block === null) return [];
  return (Object.keys(PRESETS) as PresetId[]).filter((id) => {
    const on = PRESETS[id].on;
    return on === 'any' || (!multiple && on === block);
  });
}

export interface PresetRequest {
  id: PresetId;
  /** 대상: 블록 URI, 범위 URI, 또는 블록 안의 이미지 URI */
  target: string;
  /** 문단이면 커서가 있는 문단 글, 글자를 골랐으면 고른 글 */
  text?: string;
  /** 슬래시 커맨드 뒤에 이어서 쓴 글. 서버 지시에 붙인다. */
  extra?: string;
}

/**
 * 에이전트가 사용자에게 묻는 질문 (MCP form elicitation 축소판).
 * question은 카드 안 설명, requestedSchema로 받을 입력을 선언한다.
 * 스키마는 flat object + 원시 타입만 (중첩·객체 배열 없음).
 */
export interface AskRequest {
  /** 카드 안에 보일 설명 (마크다운) */
  question: string;
  /** 수락 시 받을 입력 구조 */
  requestedSchema: AskRequestedSchema;
  /**
   * 「다시 묻지 않기」 키. 있으면 카드에 체크를 보여 주고,
   * 켠 뒤에는 같은 키 ask는 클라이언트가 바로 accept(빈 content)로 넘긴다.
   */
  dontAskKey?: string;
}

/** elicitation 응답 행동: 수락 / 거절 / 중지(cancel≈중지) */
export type AskAction = 'accept' | 'decline' | 'cancel';

/** 이미지 픽셀 생성(generate_image·edit_image) 확인용 dontAskKey */
export const ASK_DONT_ASK_IMAGE_GEN = 'image-gen';

/** 만든 이미지·인포그래픽을 이대로 쓸지 묻는 확인용 dontAskKey (켜면 평가가 애매할 때 묻지 않고 그대로 쓴다) */
export const ASK_DONT_ASK_IMAGE_REVIEW = 'image-review';

/** 만든 프롬프트를 저장하기 전 확인용 dontAskKey */
export const ASK_DONT_ASK_PROMPT_SAVE = 'prompt-save';

/** string / number / integer / boolean. enum은 string에만. */
export type AskPropertySchema =
  | {
      type: 'string';
      title?: string;
      description?: string;
      enum?: string[];
      default?: string;
      minLength?: number;
      maxLength?: number;
    }
  | {
      type: 'number' | 'integer';
      title?: string;
      description?: string;
      minimum?: number;
      maximum?: number;
      default?: number;
    }
  | {
      type: 'boolean';
      title?: string;
      description?: string;
      default?: boolean;
    };

export interface AskRequestedSchema {
  type: 'object';
  properties: Record<string, AskPropertySchema>;
  required?: string[];
}

/** 사용자의 ask 응답. accept는 content 필수, decline은 content 선택(쓰는 쪽만 읽으면 됨). */
export type AskAnswer =
  | { action: 'accept'; content: Record<string, unknown> }
  | { action: 'decline'; content?: Record<string, unknown> }
  | { action: 'cancel' };

/** 한 줄 선택지 → answer enum 스키마. 자유 입력만이면 enum 없는 answer 문자열. */
export function askAnswerSchema(options?: string[]): AskRequestedSchema {
  return {
    type: 'object',
    properties: {
      answer: {
        type: 'string',
        title: '답',
        ...(options?.length ? { enum: options } : {}),
      },
    },
    required: ['answer'],
  };
}

/** 추가 의견만 받는 스키마 (이미지 생성 확인 등). required 없음. */
export function askNoteSchema(title = '추가 의견'): AskRequestedSchema {
  return {
    type: 'object',
    properties: {
      note: {
        type: 'string',
        title,
        description: '이대로면 비워 두세요. 수정·보완할 점이 있으면 적으세요.',
      },
    },
  };
}

/** 빈 값을 뺀 content. 비어 있으면 undefined. */
export function askPackedContent(values: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(values).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** 스키마 default로 폼 초기값. */
export function askDefaults(schema: AskRequestedSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.default !== undefined) out[key] = prop.default;
  }
  return out;
}

/** accept content 검증. 문제 있으면 한국어 이유, 없으면 null. */
export function validateAskContent(schema: AskRequestedSchema, content: Record<string, unknown>): string | null {
  for (const key of schema.required ?? []) {
    if (!schema.properties[key]) continue;
    const v = content[key];
    if (v === undefined || v === null || v === '') return `${schema.properties[key].title ?? key}이(가) 필요합니다.`;
  }
  for (const [key, prop] of Object.entries(schema.properties)) {
    const v = content[key];
    if (v === undefined || v === null || v === '') continue;
    if (prop.type === 'string') {
      if (typeof v !== 'string') return `${prop.title ?? key}은(는) 글이어야 합니다.`;
      if (prop.enum && !prop.enum.includes(v)) return `${prop.title ?? key} 값이 선택지에 없습니다.`;
      if (prop.minLength != null && v.length < prop.minLength) return `${prop.title ?? key}이(가) 너무 짧습니다.`;
      if (prop.maxLength != null && v.length > prop.maxLength) return `${prop.title ?? key}이(가) 너무 깁니다.`;
    } else if (prop.type === 'number' || prop.type === 'integer') {
      if (typeof v !== 'number' || (prop.type === 'integer' && !Number.isInteger(v))) {
        return `${prop.title ?? key}은(는) 숫자여야 합니다.`;
      }
      if (prop.minimum != null && v < prop.minimum) return `${prop.title ?? key}이(가) 너무 작습니다.`;
      if (prop.maximum != null && v > prop.maximum) return `${prop.title ?? key}이(가) 너무 큽니다.`;
    } else if (prop.type === 'boolean' && typeof v !== 'boolean') {
      return `${prop.title ?? key}은(는) 예/아니어야 합니다.`;
    }
  }
  return null;
}

/** 채팅 입력창 등 자유 글을 schema content로. answer 필드 우선, 없으면 첫 string. */
export function askContentFromText(schema: AskRequestedSchema, text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t) return null;
  if (schema.properties.answer?.type === 'string') return { answer: t };
  const key = Object.keys(schema.properties).find((k) => schema.properties[k].type === 'string');
  return key ? { [key]: t } : null;
}

function formatAskContent(content: Record<string, unknown> | undefined): string {
  if (!content) return '';
  const entries = Object.entries(content).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return '';
  if (entries.length === 1) return String(entries[0]![1]);
  return entries.map(([k, v]) => `${k}: ${v}`).join('\n');
}

/** 모델·도구·대화에 보일 한 덩어리. */
export function askAnswerText(a: AskAnswer): string {
  if (a.action === 'cancel') return '사용자가 작업을 중지했습니다.';
  if (a.action === 'decline') {
    const body = formatAskContent(a.content);
    return body ? `사용자가 거절했습니다.\n${body}` : '사용자가 거절했습니다.';
  }
  return formatAskContent(a.content) || '(빈 답)';
}

/** 서버 → 확장 (WebSocket) */
export type ServerMessage =
  | { type: 'tool_call'; callId: string; name: DocToolName; args: Record<string, unknown> }
  /** 서버에서만 도는 도구(검색 등)의 진행 표시 */
  | { type: 'step'; ok: boolean; text: string }
  /** 계획을 세웠다. round는 1부터 (다시 계획하면 늘어난다). reason: 2회차부터 다시 계획한 까닭 */
  | { type: 'plan'; round: number; reason?: 'review' | 'retry'; tasks: PlanTaskView[] }
  /** 작업 하나의 진행 상태 */
  | { type: 'task'; round: number; id: string; state: TaskState; text?: string }
  | { type: 'reply'; text: string }
  /** 점검 결과가 나왔다 (대화에 카드로 남긴다) */
  | { type: 'review'; review: ReviewResult }
  /** 편집이 반영되어 지금까지의 점검 결과가 만료됐다 */
  | { type: 'review_clear' }
  /** 에이전트가 멈추고 사용자 답을 기다린다. 확장은 answer로 답한다. */
  | ({ type: 'ask' } & AskRequest)
  /** 이 요청에서 지금까지 쓴 장작 (모델을 부를 때마다 누적값을 보낸다) */
  | { type: 'cost'; wood: number; byPurpose: Partial<Record<UsagePurpose, number>> }
  | { type: 'done'; usage: UsageEntry[] }
  /** 연결 유지용. 오가는 것이 없으면 프록시·공유기가 연결을 끊으므로 주기적으로 보낸다. 확장은 무시한다. */
  | { type: 'ping' }
  /** code: 'key' 키가 없거나 잘못됨, 'wood' 장작을 다 씀 */
  | { type: 'error'; message: string; code?: AccessError };

/** 접근 키 문제로 거절한 까닭 */
export type AccessError = 'key' | 'wood';

/** HTTP 요청에 접근 키를 담는 헤더 */
export const ACCESS_KEY_HEADER = 'x-blsee-key';

/** 접근 키 하나의 장작 현황 */
export interface AccountInfo {
  name: string;
  /** 지금까지 받은 장작 */
  granted: number;
  used: number;
  remaining: number;
  /** 키 검사를 끈 개발 서버. 장작 제한이 없다. */
  unlimited?: boolean;
}

/** 요청 하나마다 연결 하나. 확장이 연결을 닫으면 서버는 그 실행을 멈춘다. */
export const AGENT_WS_PATH = '/api/agent';
export const HEALTH_PATH = '/api/health';

export interface HealthResponse {
  ok: true;
  hasApiKey: boolean;
  /** 요청에 담은 접근 키의 현황. 키가 없거나 잘못됐으면 null */
  account: AccountInfo | null;
}

/** 이미지와 지시를 Gemini에 보내 바뀐 이미지를 받는다. 이미지는 base64(접두어 없이). */
export const IMAGE_EDIT_PATH = '/api/image/edit';
export const IMAGE_DESCRIBE_PATH = '/api/image/describe';

export interface ImageInput {
  mimeType: string;
  data: string;
}

export interface ImageEditRequest {
  image: ImageInput;
  instruction: string;
}

export interface ImageEditResponse {
  model: string;
  image: ImageInput | null;
  text: string;
}

export interface ImageDescribeRequest {
  images: ImageInput[];
  question: string;
}

export interface ImageDescribeResponse {
  model: string;
  text: string;
}
