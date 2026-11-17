export interface ElementInfo {
  tag: string;
  id: string;
  className: string;
}

export interface ComponentInfo {
  index: number;
  type: string;
  className: string;
  textPreview: string;
}

import type { PageGlobal } from './main-bridge';

export interface EditorProbe {
  url: string;
  isTopFrame: boolean;
  title: string | null;
  components: ComponentInfo[];
  editables: ElementInfo[];
  activeElement: ElementInfo | null;
  pageGlobals: PageGlobal[];
}

export interface ClipboardDump {
  event: 'copy' | 'paste';
  isTrusted: boolean;
  at: string;
  frameUrl: string;
  files: number;
  data: Record<string, string>;
}

export interface PasteTestResult {
  frameUrl: string;
  target: ElementInfo | null;
  editorHandled: boolean;
  componentsBefore: number;
  componentsAfter: number;
}

export interface ImagePasteAttempt {
  where: string;
  editorHandled: boolean;
  imagesBefore: number;
  imagesAfter: number;
}

export interface SelectionDomProbe {
  /** 프레임별 브라우저 선택 영역 */
  selections: {
    frame: string;
    type: string;
    text: string;
    anchor: string;
    anchorOffset: number;
    focusOffset: number;
    /** 선택 시작이 들어 있는 블록 번호 (.se-component 순서, 0번은 제목) */
    component: number | null;
  }[];
  /** 선택/커서/활성 표시로 보이는 요소 */
  marks: { className: string; component: number | null; text: string }[];
}

export interface SelectionProbe {
  dom: SelectionDomProbe;
  model: import('./main-bridge').SelectionModelProbe | { error: string };
}

/** 사이드 패널 → 에디터 콘텐츠 스크립트 */
export type ContentRequest =
  | { type: 'probe' }
  | { type: 'explore'; path: string }
  | { type: 'document-data' }
  | { type: 'post-info' }
  | { type: 'write-test' }
  | { type: 'write-restore' }
  | { type: 'set-document'; data: unknown }
  | { type: 'image-paste-test'; dataUrl: string }
  | { type: 'selection-probe' }
  | { type: 'selection' }
  | { type: 'reveal-block'; id: string }
  | { type: 'caret-test'; compId: string }
  | { type: 'trace-start' }
  | { type: 'trace-stop' }
  | { type: 'paste-test'; data: Record<string, string> }
  /** 로그인한 사용자의 블로그 ID */
  | { type: 'my-blog-id' }
  /** 모바일 블로그 API(https://m.blog.naver.com/api/…) 호출. 블로그 페이지 출처와 로그인 상태로 보낸다. */
  | { type: 'blog-api'; path: string }
  /** 글이 아직 있는지 (지운 글이면 false) */
  | { type: 'post-exists'; blogId: string; logNo: string };

export type ContentResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error: string };

/** 콘텐츠 스크립트·사이드패널 → 백그라운드. */
export type BackgroundRequest = {
  type: 'open-panel';
  /** 주면 패널이 열리면서 그 빠른 실행을 보낸다. */
  preset?: import('@blog-helper/shared').PresetId;
};

/** 콘텐츠 스크립트 → 사이드 패널 (브로드캐스트) */
export type BroadcastMessage =
  | { type: 'clipboard-dump'; dump: ClipboardDump }
  | { type: 'paste-key'; frameUrl: string; at: string };
