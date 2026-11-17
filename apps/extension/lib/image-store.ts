/**
 * 대화에서 만든 이미지(blsee://gen/{ID})를 보관한다.
 * 작업공간을 정했으면 그 폴더의 라이브러리에, 아니면 이 PC의 IndexedDB에 둔다.
 * chrome.storage.local은 용량이 작아 이미지 바이트를 넣지 않는다.
 */
import { loadSettings, saveSettings } from './settings';
import { activeWorkspace } from './workspace';
import * as ws from './workspace-store';

/** 이미지 정보. 작업공간에서는 이미지 옆 JSON으로 남는다. */
export interface ImageMeta {
  /**
   * generated: 새로 만듦 / edited: 이미지를 고침 / diagram: 설명 그림 / web: 웹 이미지 그대로 / attached: 사용자가 붙여넣음
   * added: 사용자가 작업공간 images 폴더에 직접 넣음 / original: 글에 있던 이미지를 이미지 작업 전에 보관함
   */
  kind: 'generated' | 'edited' | 'diagram' | 'web' | 'attached' | 'added' | 'original';
  /** 사람이 알아볼 이름 (파일로 내려받을 때 "{name}.png") */
  name?: string;
  /** 이미지 안에 넣을 캡션 (출처·참고) */
  caption?: string;
  /** AI로 만들었는지 */
  ai: boolean;
  instruction?: string;
  /** 웹 페이지 주소 또는 고친 원본 이미지 URI */
  source?: string;
  /** 내용 해시 (SHA-256 앞 16자). 같은 그림이면 lib에서 재사용한다. */
  hash?: string;
  /** 인포그래픽 HTML 원본 URI (blsee://lib/infographics/…, 옛 lib/html/…) */
  htmlUri?: string;
}

/** 미리보기·목록용 종류 이름 */
export const IMAGE_KIND_LABEL: Record<ImageMeta['kind'], string> = {
  generated: 'AI 생성',
  edited: '고친 이미지',
  diagram: '설명 그림',
  web: '웹 이미지',
  attached: '첨부한 이미지',
  added: '사용자가 넣은 이미지',
  original: '글의 원본 이미지',
};

/** 작업공간에서 오는 추가 표시 정보 */
export type ImageInfo = ImageMeta & {
  title?: string;
  createdAt?: number;
};

const DB_NAME = 'blog-helper';
const STORE = 'images';

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = run(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

const keyOf = (convKey: string, uri: string) => `${convKey}|${uri}`;
/**
 * 브라우저 저장소의 찾기 표: 내용 해시·출처 → URI. 작업공간이 없을 때도 같은 그림·같은 원본을 다시 보관하지 않게 한다.
 * 대화 키로 시작하므로 그 대화의 이미지를 지울 때 함께 지워진다.
 */
const hashKey = (convKey: string, hash: string) => `${convKey}|#hash:${hash}`;
const sourceKey = (convKey: string, source: string) => `${convKey}|#src:${source}`;

/** 이미지를 보관한다. 작업공간에서 같은 내용이면 기존 URI를 돌려준다. */
export async function putImage(convKey: string, uri: string, blob: Blob, meta: ImageMeta): Promise<string> {
  const root = await activeWorkspace();
  if (root) return ws.putImage(root, convKey, uri, blob, meta);
  await tx('readwrite', (s) => s.put(blob, keyOf(convKey, uri)));
  if (meta.hash) await tx('readwrite', (s) => s.put(uri, hashKey(convKey, meta.hash!)));
  if (meta.source && !meta.source.startsWith('blsee://')) await tx('readwrite', (s) => s.put(uri, sourceKey(convKey, meta.source!)));
  // 권고를 미뤄 둔 뒤 브라우저에 이미지가 쌓이기 시작하면 한 번 더 권한다.
  if ((await loadSettings()).workspaceTip === 'later') await saveSettings({ workspaceTip: 'remind' });
  return uri;
}

/** 같은 내용의 보관 이미지. 작업공간은 라이브러리 전체에서, 브라우저 저장소는 이 대화에서 찾는다. */
export async function findImageByHash(hash: string, convKey: string): Promise<string | null> {
  const root = await activeWorkspace();
  if (root) return ws.findImageByHash(root, hash);
  return ((await tx('readonly', (s) => s.get(hashKey(convKey, hash)))) as string | undefined) ?? null;
}

/** 같은 출처(글 원본 pstatic 주소 등)에서 보관한 이미지. 범위는 findImageByHash와 같다. */
export async function findImageBySource(source: string, convKey: string): Promise<string | null> {
  const root = await activeWorkspace();
  if (root) return ws.findImageBySource(root, source);
  return ((await tx('readonly', (s) => s.get(sourceKey(convKey, source)))) as string | undefined) ?? null;
}

/** 인포그래픽 URI를 렌더해 둔 그림 URI (작업공간에만 있다) */
export async function htmlImageUri(uri: string): Promise<string | null> {
  const root = await activeWorkspace();
  return root ? ws.htmlImageUri(root, uri) : null;
}

export async function getHtml(uri: string): Promise<string | null> {
  const root = await activeWorkspace();
  return root ? ws.getHtml(root, uri) : null;
}

export async function getImage(convKey: string, uri: string): Promise<Blob | null> {
  const root = await activeWorkspace();
  if (root) return ws.getImage(root, convKey, uri);
  return browserImage(convKey, uri);
}

/** 이미지 정보. 브라우저 저장소에는 정보를 두지 않으므로 작업공간에서만 돌려준다. */
export async function getImageInfo(convKey: string, uri: string): Promise<ImageInfo | null> {
  const root = await activeWorkspace();
  return root ? ws.imageInfo(root, convKey, uri) : null;
}

export type { LibraryImageItem, LibraryResearchItem } from './workspace-store';

/** 작업공간 보관함 이미지 (최근순). 작업공간이 없으면 null. */
export async function listLibraryImages(): Promise<ws.LibraryImageItem[] | null> {
  const root = await activeWorkspace();
  return root ? ws.listLibraryImages(root) : null;
}

/** 작업공간 검색 자료 (최근순). 작업공간이 없으면 null. */
export async function listLibraryResearch(): Promise<ws.LibraryResearchItem[] | null> {
  const root = await activeWorkspace();
  return root ? ws.listLibraryResearch(root) : null;
}

/** 검색 자료 본문. 없거나 실패하면 null. */
export async function readLibraryResearch(uri: string): Promise<string | null> {
  const root = await activeWorkspace();
  if (!root) return null;
  try {
    return await ws.readResearch(root, uri);
  } catch {
    return null;
  }
}

/** 글에 올린 pstatic 주소를 lib 이미지 source로 기록한다 (가리킬 때 인포 htmlUri 등을 되찾기 위함). */
export async function linkImageSource(convKey: string, uri: string, source: string): Promise<void> {
  const root = await activeWorkspace();
  if (root) await ws.setImageSource(root, convKey, uri, source);
}

/** 내려받을 파일 이름: 이름이 있으면 "{이름}.png", 없으면 "{ID}.png" */
export function downloadName(uri: string, blob: Blob, name?: string): string {
  const base = (name && ws.slug(name, 60)) || uri.slice(uri.lastIndexOf('/') + 1);
  return `${base}.${ws.extOf(blob.type)}`;
}

/** 대화 하나(없으면 전부)의 이미지를 지운다. 작업공간 라이브러리의 이미지는 남긴다. */
export async function deleteImages(convKey?: string): Promise<void> {
  if (await activeWorkspace()) return;
  await deleteBrowserImages(convKey);
}

/* 작업공간으로 옮길 때 쓰는 브라우저 저장소 직접 접근 */

export async function browserImage(convKey: string, uri: string): Promise<Blob | null> {
  const blob = (await tx('readonly', (s) => s.get(keyOf(convKey, uri)))) as Blob | undefined;
  return blob ?? null;
}

export async function deleteBrowserImages(convKey?: string): Promise<void> {
  if (!convKey) {
    await tx('readwrite', (s) => s.clear());
    return;
  }
  const range = IDBKeyRange.bound(`${convKey}|`, `${convKey}|\uffff`);
  await tx('readwrite', (s) => s.delete(range));
}
