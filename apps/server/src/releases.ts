import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 관리자 화면에서 올린 확장 zip과 그 목록. 설치 페이지는 current로 고른 것을 내준다. */
export const DOWNLOADS_DIR = fileURLToPath(new URL('../downloads', import.meta.url));
const INDEX_FILE = join(DOWNLOADS_DIR, 'releases.json');
const MAX_BYTES = 50 * 1024 * 1024;

export interface Release {
  id: string;
  version: string;
  /** 설치 페이지에 보일 바뀐 점 */
  note: string;
  file: string;
  size: number;
  uploadedAt: string;
}

interface ReleaseIndex {
  releases: Release[];
  current: string | null;
}

function load(): ReleaseIndex {
  if (!existsSync(INDEX_FILE)) return { releases: [], current: null };
  return JSON.parse(readFileSync(INDEX_FILE, 'utf8')) as ReleaseIndex;
}

function save(index: ReleaseIndex): void {
  mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const tmp = `${INDEX_FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`);
  renameSync(tmp, INDEX_FILE);
}

export function listReleases(): ReleaseIndex {
  const index = load();
  index.releases.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  return index;
}

export function currentRelease(): (Release & { path: string }) | null {
  const index = load();
  const r = index.releases.find((x) => x.id === index.current);
  return r ? { ...r, path: join(DOWNLOADS_DIR, r.file) } : null;
}

/** zip을 저장하고 목록에 더한다. 새로 올린 것이 설치 페이지에 나간다. */
export function addRelease(data: Buffer, version: string, note: string): Release {
  version = version.trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('버전은 1.2.3 형식으로 써 주세요.');
  if (data.length > MAX_BYTES) throw new Error('파일이 50MB보다 큽니다.');
  if (data.subarray(0, 4).toString('binary') !== 'PK\x03\x04') throw new Error('zip 파일이 아닙니다.');
  const index = load();
  if (index.releases.some((x) => x.version === version)) throw new Error(`${version} 버전이 이미 있습니다.`);
  const id = randomBytes(6).toString('base64url');
  const file = `blsee-${version}-${id}.zip`;
  mkdirSync(DOWNLOADS_DIR, { recursive: true });
  writeFileSync(join(DOWNLOADS_DIR, file), data);
  const r: Release = { id, version, note: note.trim(), file, size: data.length, uploadedAt: new Date().toISOString() };
  index.releases.push(r);
  index.current = id;
  save(index);
  return r;
}

export function setCurrent(id: string): Release {
  const index = load();
  const r = index.releases.find((x) => x.id === id);
  if (!r) throw new Error('없는 버전입니다.');
  index.current = id;
  save(index);
  return r;
}

export function removeRelease(id: string): Release {
  const index = load();
  const r = index.releases.find((x) => x.id === id);
  if (!r) throw new Error('없는 버전입니다.');
  if (index.current === id) throw new Error('설치 페이지에 나가는 버전은 지울 수 없습니다. 다른 버전을 먼저 고르세요.');
  index.releases = index.releases.filter((x) => x !== r);
  save(index);
  const path = join(DOWNLOADS_DIR, r.file);
  if (existsSync(path)) unlinkSync(path);
  return r;
}
