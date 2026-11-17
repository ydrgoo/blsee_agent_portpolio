/**
 * 격리된 콘텐츠 스크립트 ↔ 페이지 컨텍스트(MAIN world) 스크립트 간 window.postMessage 프로토콜.
 */

export interface ExploreEntry {
  name: string;
  type: string;
  detail: string;
  /** 프로토타입 체인에서 찾은 메서드인지 */
  inherited: boolean;
}

export interface ExploreResult {
  path: string;
  type: string;
  detail: string;
  entries: ExploreEntry[];
}

export interface DocumentDataResult {
  editorKeys: string[];
  editorKey: string | null;
  data: unknown;
}

/** 지금 열린 글을 가리키는 가벼운 정보. 본문은 담지 않는다. */
export interface PostInfo {
  /** 글 식별자: 에디터 문서 ID(document.id, ULID). 글을 만들 때 정해지고 저장 후 다시 열어도 같다. */
  key: string;
  title: string;
  /** 저장된 글 번호. 저장 전 새 글은 빈 문자열. */
  documentId: string;
  blockCount: number;
}

export interface PageGlobal {
  name: string;
  type: string;
}

export interface WriteTestResult {
  marker: string;
  componentsBefore: number;
  componentsAfter: number;
  inModel: boolean;
  inDom: boolean;
}

/** 에디터 객체에서 선택·커서 관련으로 보이는 것들 */
export interface SelectionModelProbe {
  /** 이름이 선택/커서와 관련된 메서드 (경로 포함, 예: "editor.getSelection(0)") */
  methods: string[];
  /** 인자 없는 get… 메서드를 불러 본 결과 */
  calls: { path: string; ok: boolean; value: string }[];
}

/** 커서를 블록으로 옮기는 방법들을 차례로 시도한 결과 */
export interface CaretTestResult {
  /** 에디터와 하위 객체에서 찾은 커서를 바꿀 것 같은 메서드 */
  setters: string[];
  /** 시도한 방법과 그 뒤의 editor.getSelection() */
  tried: { how: string; ok: boolean; error?: string; selection: string; landed: boolean }[];
  /** 커서를 옮기는 데 성공한 방법 */
  landedBy?: string;
}

/** 붙여넣기 업로드 동안 에디터 프레임에서 본 네트워크 요청과 문서 변경. 시각은 추적 시작(t0, epoch ms)부터의 ms. */
export interface UploadTrace {
  t0: number;
  network: { start: number; end: number; url: string; initiator: string; status?: number; size?: number }[];
  doc: { t: number; summary: string; changed: string }[];
}

/** 에디터 모델의 현재 선택 (editor.getSelection()) */
export interface EditorSelection {
  anchorCompId: string;
  focusCompId: string;
  /** 선택이 걸친 블록 수 */
  blockCount: number;
  collapsed: boolean;
  /** 글자 안의 커서/선택인지. 사진·링크 카드 같은 개체를 고르면 문단이 없어 false다. */
  inText: boolean;
  /** 한 블록 안의 선택일 때 그 블록 데이터 */
  component: unknown;
  /** 그 블록이 같은 종류 중 몇 번째인지 (개요의 "인용구 2"와 같은 번호) */
  ordinal?: number;
  /** 커서(선택 시작)가 있는 문단 글 */
  paragraph?: string;
  /** 드래그해서 고른 글 */
  selectedText?: string;
}

/** 커서가 있는 블록의 화면 위치 (블씨 버튼을 붙일 곳). 위치는 이 프레임 화면 기준 px */
export interface CaretBlock {
  /** 블록 종류 (@ctype, 화면 클래스에서 읽는다) */
  ctype: string;
  /** 여러 블록에 걸친 선택 */
  multiple: boolean;
  /** 커서가 있는 문단(없으면 블록)의 위쪽 */
  top: number;
  /** 블록의 왼쪽 끝 */
  left: number;
}

export type MainRequest =
  | { type: 'probe-globals' }
  | { type: 'selection-probe' }
  | { type: 'selection' }
  | { type: 'caret' }
  | { type: 'reveal-block'; id: string }
  | { type: 'caret-test'; compId: string }
  | { type: 'trace-start' }
  | { type: 'trace-stop' }
  | { type: 'explore'; path: string }
  | { type: 'document-data' }
  | { type: 'post-info' }
  | { type: 'write-test' }
  | { type: 'write-restore' }
  | { type: 'set-document'; data: unknown };

export const ISOLATED_SOURCE = 'blog-helper/isolated';
export const MAIN_SOURCE = 'blog-helper/main';

export interface MainEnvelope {
  source: typeof ISOLATED_SOURCE;
  requestId: string;
  req: MainRequest;
}

export type MainReply = { source: typeof MAIN_SOURCE; requestId: string } & (
  | { ok: true; result: unknown }
  | { ok: false; error: string }
);

export function callMain<T>(req: MainRequest, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();

    const onMessage = (e: MessageEvent<MainReply>) => {
      if (
        e.source !== window ||
        e.data?.source !== MAIN_SOURCE ||
        e.data.requestId !== requestId
      ) {
        return;
      }
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      if (e.data.ok) resolve(e.data.result as T);
      else reject(new Error(e.data.error));
    };

    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('페이지 스크립트(MAIN world) 응답 없음'));
    }, timeoutMs);

    window.addEventListener('message', onMessage);
    window.postMessage(
      { source: ISOLATED_SOURCE, requestId, req } satisfies MainEnvelope,
      '*',
    );
  });
}
