import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AccessError, AccountInfo } from '@blog-helper/shared';

/**
 * 직접 발급한 접근 키와 키마다 준 장작.
 * 서버와 키 관리 명령(npm run key)이 같은 파일을 읽고 쓴다. 서버가 켜진 채로 충전해도 바로 반영되도록 매번 파일을 읽는다.
 */
export const KEYS_FILE = fileURLToPath(new URL('../keys.json', import.meta.url));

export interface AccessKey {
  name: string;
  key: string;
  /** 지금까지 준 장작 (충전하면 늘어난다) */
  granted: number;
  used: number;
  disabled?: boolean;
  createdAt: string;
  lastUsedAt?: string;
}

interface KeyFile {
  keys: AccessKey[];
}

export function loadKeys(): AccessKey[] {
  if (!existsSync(KEYS_FILE)) return [];
  return (JSON.parse(readFileSync(KEYS_FILE, 'utf8')) as KeyFile).keys ?? [];
}

export function saveKeys(keys: AccessKey[]): void {
  const tmp = `${KEYS_FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ keys } satisfies KeyFile, null, 2)}\n`);
  renameSync(tmp, KEYS_FILE);
}

export function newKey(): string {
  return `blsee_${randomBytes(18).toString('base64url')}`;
}

export function accountOf(k: AccessKey): AccountInfo {
  return { name: k.name, granted: k.granted, used: k.used, remaining: Math.max(0, k.granted - k.used) };
}

/** 개발용: .env에 ACCESS_KEY_CHECK=off 를 넣으면 키 없이 누구나 쓸 수 있다. 상용 서버에는 넣지 않는다. */
export const keyCheckOff = () => process.env.ACCESS_KEY_CHECK === 'off';

const OPEN_ACCOUNT: AccountInfo = {
  name: '개발 서버',
  granted: 0,
  used: 0,
  remaining: Number.MAX_SAFE_INTEGER,
  unlimited: true,
};

/** 키의 현황. 키가 없거나 잘못됐거나 막혀 있으면 null */
export function accountForKey(key: unknown): AccountInfo | null {
  if (keyCheckOff()) return OPEN_ACCOUNT;
  const k = typeof key === 'string' && key ? loadKeys().find((x) => x.key === key) : undefined;
  return k && !k.disabled ? accountOf(k) : null;
}

export type Access = { ok: true; account: AccountInfo } | { ok: false; code: AccessError; message: string };

/** 키를 확인한다. 장작이 남아 있어야 통과한다. */
export function checkAccess(key: unknown): Access {
  if (keyCheckOff()) return { ok: true, account: OPEN_ACCOUNT };
  const k = typeof key === 'string' && key ? loadKeys().find((x) => x.key === key) : undefined;
  if (!k || k.disabled) {
    return { ok: false, code: 'key', message: '접근 키가 없거나 잘못됐습니다. 설정에서 발급받은 키를 넣어 주세요.' };
  }
  const account = accountOf(k);
  if (account.remaining <= 0) {
    return { ok: false, code: 'wood', message: '장작을 다 썼습니다. 충전을 요청해 주세요.' };
  }
  return { ok: true, account };
}

/** 요청 하나가 쓴 장작을 키에 더한다. 진행 중인 요청 몫만큼은 잔액을 조금 넘길 수 있다. */
export function charge(key: string, wood: number): void {
  if (wood <= 0) return;
  const keys = loadKeys();
  const k = keys.find((x) => x.key === key);
  if (!k) return;
  k.used = Math.round((k.used + wood) * 1000) / 1000;
  k.lastUsedAt = new Date().toISOString();
  saveKeys(keys);
}

/* ---------- 관리 (키 관리 명령과 관리자 화면이 같이 쓴다). 잘못된 입력은 Error로 알린다. ---------- */

export function parseWood(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (raw === '' || raw == null || !Number.isFinite(n) || n < 0) throw new Error('장작은 0 이상의 숫자로 써 주세요.');
  return n;
}

export function addKey(name: string, granted: number): AccessKey {
  name = name.trim();
  if (!name) throw new Error('이름을 써 주세요.');
  const keys = loadKeys();
  if (keys.some((x) => x.name === name)) throw new Error(`"${name}" 이름이 이미 있습니다.`);
  const k: AccessKey = { name, key: newKey(), granted, used: 0, createdAt: new Date().toISOString() };
  saveKeys([...keys, k]);
  return k;
}

/** 이름(또는 키)으로 찾아 고치고 저장한다. */
export function updateKey(name: string, change: (k: AccessKey) => void): AccessKey {
  const keys = loadKeys();
  const k = keys.find((x) => x.name === name || x.key === name);
  if (!k) throw new Error(`"${name}" 키가 없습니다.`);
  change(k);
  saveKeys(keys);
  return k;
}

export function removeKey(name: string): AccessKey {
  const keys = loadKeys();
  const k = keys.find((x) => x.name === name || x.key === name);
  if (!k) throw new Error(`"${name}" 키가 없습니다.`);
  saveKeys(keys.filter((x) => x !== k));
  return k;
}
