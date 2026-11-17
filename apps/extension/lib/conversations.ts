import { GEN_URI_SRC, type BlockRefsData } from '@blog-helper/se-model';
import type { AskAction, ChatTurn, PlanTaskView, PresetId, RefItem, ReviewResult, TaskState, TurnMeta } from '@blog-helper/shared';
export type { RefItem };
import { browserImage, deleteBrowserImages, deleteImages, type ImageMeta } from './image-store';
import { activeWorkspace } from './workspace';
import * as ws from './workspace-store';

/** 화면에 보여주는 대화 한 줄 */
export type ChatMessage =
  | { role: 'assistant' | 'info' | 'error'; text: string }
  /**
   * refs: 문장 안에 넣은 참조. text의 URI와 순서가 같다. 예전 대화는 문장 위 칩 줄.
   * preset: 빠른 실행이면 문장 대신 칩으로 보인다.
   * attachments: 입력창에 붙여넣은 이미지 (blsee://gen/…, 바이트는 image-store에 있다)
   */
  | {
      role: 'user';
      text: string;
      refs?: RefItem[];
      selection?: string;
      selectionImage?: string;
      preset?: PresetId;
      attachments?: string[];
    }
  | { role: 'step'; ok: boolean; text: string }
  /** 만든 이미지 미리보기. 바이트는 image-store에 있다. */
  /** ai: AI로 만든 이미지 (없으면 예전 기록이라 "만든 이미지"면 AI로 본다) */
  /** name: 저장할 때 파일 이름. original: 글에 있던 이미지를 보관한 것이면 그 원래 주소 (작게 보인다) */
  | { role: 'image'; uri: string; text: string; caption?: string; ai?: boolean; name?: string; original?: string }
  /** 에이전트가 세운 작업 목록과 작업별 진행 상태 */
  | { role: 'plan'; round: number; reason?: 'review' | 'retry'; tasks: PlanTaskItem[] }
  /**
   * Ask 확인에 대한 답. 질문·결과(확인/거절)·추가 의견을 한 카드로 남긴다.
   * action은 accept|decline (cancel/중지는 기록하지 않음).
   */
  | { role: 'ask'; question: string; action: Exclude<AskAction, 'cancel'>; text?: string }
  /** 점검 결과. 편집이 반영되면 만료된다 (만료된 것은 다음 요청에 보내지 않는다). */
  | { role: 'review'; review: ReviewResult; expired?: boolean };

export interface PlanTaskItem extends PlanTaskView {
  state: TaskState | 'pending';
  text?: string;
}

/** 글 하나에 대화 하나. 작업공간 폴더 또는 이 PC(chrome.storage.local)에 저장한다. */
export interface Conversation {
  /** 글 식별자 (에디터 문서 ID) */
  key: string;
  title: string;
  documentId: string;
  url?: string;
  updatedAt: number;
  messages: ChatMessage[];
  /** 에이전트에게 넘기는 이전 대화 */
  history: ChatTurn[];
  /** history 사용자 턴 ID → 그 턴의 시각·가리킨 곳·첨부 */
  turnMeta?: Record<string, TurnMeta>;
  refs?: BlockRefsData;
}

export interface ConversationSummary {
  key: string;
  title: string;
  documentId: string;
  url?: string;
  updatedAt: number;
  turns: number;
  /** 마지막 요청 */
  preview: string;
  /** 검색용 전체 대화 글 */
  searchText: string;
}

const PREFIX = 'conv:';

/* 작업공간을 정했으면 그 폴더에, 아니면 chrome.storage.local에 둔다. */

export async function loadConversation(key: string): Promise<Conversation | null> {
  const root = await activeWorkspace();
  if (root) return ws.loadConversation(root, key);
  const id = PREFIX + key;
  const got = await browser.storage.local.get(id);
  return (got[id] as Conversation | undefined) ?? null;
}

export async function saveConversation(conv: Conversation): Promise<void> {
  const root = await activeWorkspace();
  if (root) return ws.saveConversation(root, conv);
  await browser.storage.local.set({ [PREFIX + conv.key]: conv });
}

export async function deleteConversation(key: string): Promise<void> {
  const root = await activeWorkspace();
  if (root) return ws.deleteConversation(root, key);
  await browser.storage.local.remove(PREFIX + key);
  await deleteImages(key);
}

/**
 * 대화를 처음부터 다시 시작한다. 글과의 연결과 블록 참조는 두고, 화면 대화·에이전트에게 넘기는 이전 대화만 비운다.
 * 만든 이미지와 첨부 이미지는 보관소에 그대로 남는다.
 */
export async function resetConversation(key: string): Promise<void> {
  const conv = await loadConversation(key);
  if (!conv) return;
  await saveConversation({ ...conv, messages: [], history: [], turnMeta: {}, updatedAt: Date.now() });
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const root = await activeWorkspace();
  if (root) return ws.listConversations(root);
  return (await browserConversations()).map(ws.summaryOf).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function clearConversations(): Promise<number> {
  const root = await activeWorkspace();
  if (root) return ws.clearConversations(root);
  const keys = Object.keys(await browser.storage.local.get(null)).filter((k) => k.startsWith(PREFIX));
  await browser.storage.local.remove(keys);
  await deleteImages();
  return keys.length;
}

async function browserConversations(): Promise<Conversation[]> {
  const all = await browser.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(PREFIX))
    .map(([, v]) => v as Conversation);
}

/** 브라우저에 남아 있는 대화 수 (작업공간으로 옮길지 물을 때) */
export async function browserConversationCount(): Promise<number> {
  return (await browserConversations()).length;
}

const GEN_URI_RE = new RegExp(GEN_URI_SRC, 'g');

/**
 * 브라우저에 있는 대화와 이미지를 작업공간으로 옮긴다. 다 옮긴 대화만 브라우저에서 지운다.
 * 작업공간에 이미 같은 글의 대화가 있으면 그대로 두고 건너뛴다.
 */
export async function moveBrowserDataToWorkspace(onProgress?: (done: number, total: number) => void): Promise<number> {
  const root = await activeWorkspace();
  if (!root) throw new Error('작업공간이 없어요.');
  const convs = await browserConversations();
  let moved = 0;
  for (const conv of convs) {
    if (!(await ws.loadConversation(root, conv.key))) {
      await ws.saveConversation(root, conv);
      const metaOf = new Map<string, ImageMeta>();
      for (const m of conv.messages) {
        if (m.role === 'image') {
          const ai = m.ai ?? (m.text.startsWith('만든 이미지') && !m.caption);
          metaOf.set(m.uri, { kind: ai ? 'generated' : 'web', ai, caption: m.caption, instruction: m.text });
        }
      }
      const uris = new Set(JSON.stringify(conv).match(GEN_URI_RE) ?? []);
      for (const uri of uris) {
        const blob = await browserImage(conv.key, uri);
        if (blob) await ws.putImage(root, conv.key, uri, blob, metaOf.get(uri) ?? { kind: 'attached', ai: false });
      }
    }
    await browser.storage.local.remove(PREFIX + conv.key);
    await deleteBrowserImages(conv.key);
    onProgress?.(++moved, convs.length);
  }
  return moved;
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `오늘 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}.${String(d.getDate()).padStart(2, '0')}`;
}
