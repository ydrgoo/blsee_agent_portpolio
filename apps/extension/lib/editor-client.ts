import type { ContentRequest, ContentResponse } from './messages';
import type { DocumentDataResult, EditorSelection, PostInfo } from './main-bridge';
import { listConversations } from './conversations';
import { blockImages, blockText, typeLabel, type SeComponent, type SeDocumentData } from '@blog-helper/se-model';

export interface FrameTarget {
  tabId: number;
  frameId: number;
}

/**
 * 요청(에이전트 실행·적용) 동안 쓸 에디터 탭.
 * 고정해 두면 다른 탭으로 옮겨도 read/edit이 그 글 탭으로 간다.
 */
let pinnedTabId: number | undefined;

export function pinEditorTab(tabId: number | undefined): void {
  pinnedTabId = tabId;
}

export function pinnedEditorTab(): number | undefined {
  return pinnedTabId;
}

/** 모의 편집기 주소 (개발 빌드의 시험용) */
const MOCK_EDITOR_URL = 'http://localhost:5179/*';

/**
 * 시험용: 사이드 패널을 탭으로 열고 주소에 ?editorTab=mock을 붙이면, 활성 탭 대신 모의 편집기 탭을 쓴다.
 * 개발 빌드에서만 동작한다.
 */
async function testEditorTab(): Promise<number | undefined> {
  if (import.meta.env.MODE === 'production' || typeof location === 'undefined') return undefined;
  if (new URLSearchParams(location.search).get('editorTab') !== 'mock') return undefined;
  const [tab] = await browser.tabs.query({ url: MOCK_EDITOR_URL });
  return tab?.id;
}

/** 지금 활성 탭 id (없으면 undefined) */
export async function activeTabId(): Promise<number | undefined> {
  const test = await testEditorTab();
  if (test !== undefined) return test;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function resolveTabId(frame?: FrameTarget): Promise<number> {
  if (frame?.tabId !== undefined) return frame.tabId;
  if (pinnedTabId !== undefined) return pinnedTabId;
  const id = await activeTabId();
  if (id === undefined) throw new Error('활성 탭이 없습니다.');
  return id;
}

/** 해당(또는 고정) 에디터 탭이 현재 그 창에서 선택된 탭인지 */
export async function isEditorTabActive(tabId?: number): Promise<boolean> {
  const id = tabId ?? pinnedTabId;
  if (id === undefined) return true;
  try {
    const tab = await browser.tabs.get(id);
    return tab.active === true;
  } catch {
    return false;
  }
}

/** 알림 클릭 등: 글 탭을 앞으로 가져온다. */
export async function focusEditorTab(tabId: number): Promise<void> {
  const tab = await browser.tabs.get(tabId);
  if (tab.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
  await browser.tabs.update(tabId, { active: true });
}

/** 사이드 패널에서 에디터 콘텐츠 스크립트로 요청을 보낸다. frame/고정 탭이 있으면 그쪽으로. */
export async function sendToEditor<T>(req: ContentRequest, frame?: FrameTarget): Promise<T> {
  const tabId = await resolveTabId(frame);

  let res: ContentResponse<T> | undefined;
  try {
    res = frame
      ? await browser.tabs.sendMessage(tabId, req, { frameId: frame.frameId })
      : await browser.tabs.sendMessage(tabId, req);
  } catch {
    res = undefined;
  }
  if (!res) {
    throw new Error(
      '이 탭에서 네이버 블로그 에디터를 찾지 못했습니다. 글쓰기 화면인지 확인하고, 확장을 업데이트했다면 페이지를 새로고침하세요.',
    );
  }
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

export async function readDocument(): Promise<SeDocumentData> {
  const res = await sendToEditor<DocumentDataResult>({ type: 'document-data' });
  return res.data as SeDocumentData;
}

export interface CurrentPost extends PostInfo {
  /** 글쓰기 화면 탭 주소 (나중에 그 글을 다시 열 때 쓴다) */
  url?: string;
}

/**
 * 지금 보고 있는 탭의 글 정보.
 * 연결 글 확인용이라 고정 탭과 무관하게 활성 탭만 본다 (에이전트 중 App은 busy로 폴링을 건너뛴다).
 */
export async function getCurrentPost(): Promise<CurrentPost> {
  const test = await testEditorTab();
  const [tab] = test !== undefined ? [await browser.tabs.get(test)] : await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('활성 탭이 없습니다.');
  const info = await sendToTab<PostInfo>(tab.id, { type: 'post-info' });
  return { ...info, key: await conversationKey(info.key, tab.url), url: tab.url };
}

/** 고정 탭을 무시하고 지정 탭으로만 보낸다. */
async function sendToTab<T>(tabId: number, req: ContentRequest, frameId?: number): Promise<T> {
  let res: ContentResponse<T> | undefined;
  try {
    res =
      frameId !== undefined
        ? await browser.tabs.sendMessage(tabId, req, { frameId })
        : await browser.tabs.sendMessage(tabId, req);
  } catch {
    res = undefined;
  }
  if (!res) {
    throw new Error(
      '이 탭에서 네이버 블로그 에디터를 찾지 못했습니다. 글쓰기 화면인지 확인하고, 확장을 업데이트했다면 페이지를 새로고침하세요.',
    );
  }
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

/** 에디터 문서 ID → 대화 키 */
const keyCache = new Map<string, string>();

/**
 * 오래된 글은 수정 화면을 열 때마다 에디터가 문서 ID(document.id)를 새로 만든다. 그래서 주소에 글 번호(logNo)가
 * 있으면 같은 글 번호로 저장된 가장 최근 대화를 이어 쓴다. 대화 목록을 못 읽으면 (작업공간 연결 전 등) 문서 ID를 쓰고 기억하지 않는다.
 */
async function conversationKey(documentKey: string, url: string | undefined): Promise<string> {
  const cached = keyCache.get(documentKey);
  if (cached) return cached;
  const logNo = url ? logNoOf(url) : null;
  if (!logNo) return documentKey;
  let key = documentKey;
  try {
    const same = (await listConversations()).find((c) => c.key === documentKey || (c.url && logNoOf(c.url) === logNo));
    if (same) key = same.key;
  } catch {
    return documentKey;
  }
  keyCache.set(documentKey, key);
  return key;
}

function logNoOf(url: string): string | null {
  try {
    return new URL(url).searchParams.get('logNo');
  } catch {
    return null;
  }
}

/** 에디터에서 지금 가리키는 곳: 블록 하나(커서·개체) 또는 여러 블록에 걸친 선택 */
export interface EditorFocus {
  /** 선택 시작/끝 블록 ID (블록 하나면 같다) */
  anchorId: string;
  focusId: string;
  blockCount: number;
  /** 보여주기용 이름 (예: "링크 카드: Windows Registry…", "문단: 오늘은…") */
  label: string;
  /** 글 블록(문단 여러 개)에서 커서가 있는 문단 */
  paragraph?: string;
  selectedText?: string;
  /** 사진을 골랐으면 그 사진 주소 (칩 미리보기용) */
  imageSrc?: string;
  /** 블록 종류. 슬래시 메뉴에서 그 블록에 맞는 기본 커맨드만 보여줄 때 쓴다. */
  ctype?: string;
}

const LABEL_CHARS = 40;
/** 블록 전체가 아니라 커서가 있는 문단만 가리키는 블록 */
const PARAGRAPH_BLOCKS = new Set(['text']);

function short(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > LABEL_CHARS ? `${t.slice(0, LABEL_CHARS)}…` : t;
}

/**
 * 에디터 커서/선택이 가리키는 블록.
 * 글 블록은 커서가 있는 문단을, 인용구·표·캡션 있는 이미지 등은 블록 전체를 가리킨다.
 */
export async function getEditorFocus(): Promise<EditorFocus | null> {
  const sel = await sendToEditor<EditorSelection | null>({ type: 'selection' });
  if (!sel) return null;
  const base = { anchorId: sel.anchorCompId, focusId: sel.focusCompId, blockCount: sel.blockCount };
  if (sel.blockCount > 1) return { ...base, label: `블록 ${sel.blockCount}개` };

  const c = sel.component as SeComponent | null;
  if (!c) return null;
  const type = typeLabel(c['@ctype']);
  // 개요와 같은 이름 ("문단 3", "인용구 2", "이미지 4"). 제목은 하나뿐이라 번호가 없다.
  const name = c['@ctype'] === 'documentTitle' || !sel.ordinal ? type : `${type} ${sel.ordinal}`;
  const ctype = c['@ctype'];
  if (sel.selectedText) return { ...base, label: `${name}: "${short(sel.selectedText)}"`, selectedText: sel.selectedText, ctype };
  if (PARAGRAPH_BLOCKS.has(c['@ctype']) && sel.paragraph !== undefined) {
    return { ...base, label: `${name}: ${short(sel.paragraph) || '(빈 문단)'}`, paragraph: sel.paragraph, ctype };
  }
  const src = blockImages(c)[0]?.src;
  if (c['@ctype'] === 'image' && typeof src === 'string') {
    // 파일 이름은 대개 같아서(image.png) 쓰지 않고, 미리보기와 캡션으로 구별한다.
    const caption = /캡션: (.*)\)$/s.exec(blockText(c))?.[1];
    return { ...base, label: caption ? `${name} · ${short(caption)}` : name, imageSrc: src, ctype };
  }
  const text = short(
    blockText(c)
      .replace(/^\((.*)\)$/s, '$1')
      .replace(new RegExp(`^${type}:?\\s*`), ''),
  );
  return {
    ...base,
    label: text ? `${name}: ${text}` : name,
    ctype,
    ...(typeof src === 'string' ? { imageSrc: src } : {}),
  };
}

export async function revealBlock(id: string): Promise<void> {
  await sendToEditor({ type: 'reveal-block', id });
}
export async function writeDocument(data: SeDocumentData): Promise<void> {
  await sendToEditor({ type: 'set-document', data });
}
