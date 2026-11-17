import { ASK_DONT_ASK_IMAGE_GEN, ASK_DONT_ASK_IMAGE_REVIEW, ASK_DONT_ASK_PROMPT_SAVE } from '@blog-helper/shared';

/**
 * Ask·확인 UI의 「다시 묻지 않기」 키.
 * 전역이 아니라 키마다 따로 건너뛴다.
 */
export const ASK_SKIP = {
  /** 제안 적용: 글 편집 */
  proposalEdits: 'proposal-edits',
  /** 제안 적용: 이미지 넣기 */
  proposalImages: 'proposal-images',
  /** 이미지 픽셀 생성(generate_image·edit_image) 확인 */
  imageGen: ASK_DONT_ASK_IMAGE_GEN,
  /** 만든 이미지·인포그래픽을 이대로 쓸지 확인 */
  imageReview: ASK_DONT_ASK_IMAGE_REVIEW,
  /** 만든 프롬프트를 저장하기 전 확인 */
  promptSave: ASK_DONT_ASK_PROMPT_SAVE,
} as const;

/** 이 PC의 사용자 설정 */
export interface UserSettings {
  textSize: TextSize;
  /** 발급받은 접근 키 (상용 서버용) */
  accessKey: string;
  /** 붙을 서버. 개발 빌드에서만 고를 수 있고, 배포 빌드는 늘 상용 서버다. */
  server: ServerChoice;
  /** 에디터의 커서 옆 블씨 버튼 (버튼의 ✕로 끄고, 설정에서 다시 켠다) */
  editorButton: boolean;
  /**
   * 작업공간 권고 카드. new: 처음 한 번 띄움 / later: [나중에]를 누름 /
   * remind: 그 뒤 브라우저에 이미지가 쌓여 한 번 더 띄움 / done: 다시 띄우지 않음
   */
  workspaceTip: 'new' | 'later' | 'remind' | 'done';
  /** 다시 묻지 않기로 켠 Ask/확인 키 */
  askSkip: Record<string, boolean>;
}

export type ServerChoice = 'prod' | 'local';

export type TextSize = 'small' | 'medium' | 'large' | 'xlarge';

export const TEXT_SIZES: { value: TextSize; label: string; scale: number }[] = [
  { value: 'small', label: '작게', scale: 1 },
  { value: 'medium', label: '보통', scale: 1.15 },
  { value: 'large', label: '크게', scale: 1.3 },
  { value: 'xlarge', label: '아주 크게', scale: 1.45 },
];

const KEY = 'settings';
const DEFAULTS: UserSettings = {
  textSize: 'medium',
  accessKey: '',
  server: 'local',
  editorButton: true,
  workspaceTip: 'new',
  askSkip: {},
};

/** 이 키로 다시 묻지 않기로 되어 있는지 */
export function isAskSkipped(s: UserSettings, key: string): boolean {
  return !!s.askSkip[key];
}

/** askSkip 키들을 켜거나 끈다 */
export async function setAskSkipped(keys: Record<string, boolean>): Promise<UserSettings> {
  const cur = await loadSettings();
  const askSkip = { ...cur.askSkip };
  for (const [k, v] of Object.entries(keys)) {
    if (v) askSkip[k] = true;
    else delete askSkip[k];
  }
  return saveSettings({ askSkip });
}

function applyTextSize(size: TextSize) {
  const scale = TEXT_SIZES.find((s) => s.value === size)?.scale ?? 1.15;
  document.documentElement.style.setProperty('--text-scale', String(scale));
}

/** 저장된 글자 크기를 화면에 적용하고, 설정이 바뀌면 다시 적용한다. 해제 함수를 돌려준다. */
export function watchTextSize(): () => void {
  loadSettings().then((s) => applyTextSize(s.textSize));
  return onSettingsChange((s) => applyTextSize(s.textSize));
}

/** 설정이 바뀌면 새 설정으로 부른다 (다른 화면이나 콘텐츠 스크립트에서 바꿔도). 해제 함수를 돌려준다. */
export function onSettingsChange(callback: (s: UserSettings) => void): () => void {
  const onChange = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && changes[KEY]) callback(normalizeSettings(changes[KEY].newValue as StoredSettings | undefined));
  };
  browser.storage.onChanged.addListener(onChange);
  return () => browser.storage.onChanged.removeListener(onChange);
}

type StoredSettings = Partial<UserSettings> & {
  /** 예전 전역 플래그 → askSkip으로 옮긴다 */
  autoApplyEdits?: boolean;
  autoInsertImages?: boolean;
};

function normalizeSettings(raw: StoredSettings | undefined): UserSettings {
  const { autoApplyEdits, autoInsertImages, askSkip: rawSkip, ...rest } = raw ?? {};
  const askSkip = { ...(rawSkip ?? {}) };
  if (autoApplyEdits) askSkip[ASK_SKIP.proposalEdits] = true;
  if (autoInsertImages) askSkip[ASK_SKIP.proposalImages] = true;
  return { ...DEFAULTS, ...rest, askSkip };
}

export async function loadSettings(): Promise<UserSettings> {
  const got = await browser.storage.local.get(KEY);
  return normalizeSettings(got[KEY] as StoredSettings | undefined);
}

export async function saveSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
  const next = { ...(await loadSettings()), ...patch };
  await browser.storage.local.set({ [KEY]: next });
  return next;
}
