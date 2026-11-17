import type { PresetId } from '@blog-helper/shared';

/** 에디터의 블씨 버튼 메뉴에서 고른 빠른 실행. 백그라운드가 남겨 두면 사이드 패널이 가져가 바로 보낸다. */
export interface PanelAction {
  preset: PresetId;
  at: number;
}

const KEY = 'panelAction';
/** 패널이 처음 열리며 서버 확인을 기다리는 동안은 이어서 처리하고, 그보다 오래된 건 버린다. */
const STALE_MS = 60_000;

export async function leavePanelAction(preset: PresetId): Promise<void> {
  await browser.storage.session.set({ [KEY]: { preset, at: Date.now() } satisfies PanelAction });
}

let taking: Promise<PanelAction | null> | null = null;

/** 남겨진 일을 꺼내고 지운다. 동시에 여러 번 불러도 같은 결과를 함께 받는다 (한 번만 실행되게). */
export function takePanelAction(): Promise<PanelAction | null> {
  taking ??= (async () => {
    const got: Record<string, unknown> = await browser.storage.session.get(KEY);
    const action = got[KEY] as PanelAction | undefined;
    if (!action) return null;
    await browser.storage.session.remove(KEY);
    return Date.now() - action.at < STALE_MS ? action : null;
  })().finally(() => (taking = null));
  return taking;
}

/** 패널이 이미 열려 있을 때 새로 남겨진 일을 알린다. 그만 들을 때 부를 함수를 돌려준다. */
export function onPanelAction(callback: () => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'session' && changes[KEY]?.newValue) callback();
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
