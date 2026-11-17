import type { UsagePurpose } from '@blog-helper/shared';

/**
 * 오늘 쓴 장작 (이 PC 기준, 보여주기용). 날짜가 바뀌면 0부터 다시 센다.
 * 남은 장작과 한도는 서버가 접근 키마다 관리한다.
 */
const KEY = 'wood-usage';

/** 사용자에게 보이는 기능 구분 */
export type WoodKind = 'edit' | 'search' | 'image';

export const WOOD_KINDS: { kind: WoodKind; label: string }[] = [
  { kind: 'edit', label: '글 편집' },
  { kind: 'search', label: '웹 검색' },
  { kind: 'image', label: '이미지 생성' },
];

const KIND_OF: Record<UsagePurpose, WoodKind> = {
  chat: 'edit',
  plan: 'edit',
  action: 'edit',
  view: 'edit',
  review: 'edit',
  search: 'search',
  image_agent: 'image',
  draw_agent: 'image',
  image_edit: 'image',
};

export interface WoodToday {
  used: number;
  byKind: Record<WoodKind, number>;
  /** 오늘 보낸 요청 수 */
  requests: number;
}

interface WoodLedger extends WoodToday {
  /** 로컬 날짜 YYYY-MM-DD */
  day: string;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function woodToday(): Promise<WoodToday> {
  const got = (await browser.storage.local.get(KEY))[KEY] as Partial<WoodLedger> | undefined;
  const empty = { edit: 0, search: 0, image: 0 };
  if (got?.day !== today()) return { used: 0, byKind: empty, requests: 0 };
  return { used: got.used ?? 0, byKind: { ...empty, ...got.byKind }, requests: got.requests ?? 0 };
}

/** 요청 하나가 끝났을 때 쓴 장작(용도별)을 오늘 사용량에 더한다. */
export async function recordRequest(byPurpose: Partial<Record<UsagePurpose, number>>): Promise<void> {
  const cur = await woodToday();
  for (const [purpose, wood] of Object.entries(byPurpose) as [UsagePurpose, number][]) {
    const kind = KIND_OF[purpose] ?? 'edit';
    cur.byKind[kind] += wood;
    cur.used += wood;
  }
  cur.requests += 1;
  await browser.storage.local.set({ [KEY]: { ...cur, day: today() } satisfies WoodLedger });
}

/** 화면에 보일 장작 수: 소수 첫째 자리까지, 그 아래는 버린다 (12.37 → "12.3"). */
export function formatWood(n: number): string {
  // 2.3 * 10 = 22.999… 같은 부동소수 오차로 한 칸 덜 나오지 않게 아주 작은 값을 더한다.
  return (Math.floor(n * 10 + 1e-9) / 10).toFixed(1);
}
