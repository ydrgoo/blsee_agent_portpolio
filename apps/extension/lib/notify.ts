/**
 * 비활성(작업 글 탭이 앞에 없을 때) Ask·작업 완료 → 툴바 아이콘 배지.
 * 시스템(OS) 알림은 쓰지 않는다.
 */

import { isEditorTabActive } from './editor-client';

export type NotifyKind = 'ask' | 'done';

const DEFAULT_TITLE = '블씨 열기';

/** 작업 글 탭이 비활성이면 배지를 켠다. */
export async function notifyIfInactive(tabId: number, kind: NotifyKind): Promise<void> {
  if (await isEditorTabActive(tabId)) return;
  try {
    await browser.action.setBadgeText({ text: kind === 'ask' ? '?' : '!' });
    await browser.action.setBadgeBackgroundColor({
      color: kind === 'ask' ? '#C45C26' : '#1F6B4A',
    });
    await browser.action.setTitle({
      title: kind === 'ask' ? '블씨: 답이 필요해요' : '블씨: 작업이 끝났어요',
    });
  } catch (err) {
    console.warn('[blsee] 배지 실패', err);
  }
}

/** 배지를 지운다 (답함·패널을 다시 봄). */
export async function clearBadge(): Promise<void> {
  try {
    await browser.action.setBadgeText({ text: '' });
    await browser.action.setTitle({ title: DEFAULT_TITLE });
  } catch {
    /* ignore */
  }
}
