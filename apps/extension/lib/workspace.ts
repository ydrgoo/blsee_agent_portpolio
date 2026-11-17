/**
 * 사용자가 고른 작업공간 폴더 (File System Access API). 고르면 대화·이미지를 여기에 저장하고,
 * 고르지 않으면 브라우저 저장소에 저장한다. 폴더 핸들은 IndexedDB에 둔다 (확장 저장소에는 넣을 수 없다).
 * 사이드 패널(확장 화면)에서만 쓴다.
 */

declare global {
  interface FileSystemHandle {
    queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
    requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  }
  interface Window {
    showDirectoryPicker(options?: {
      id?: string;
      mode?: 'read' | 'readwrite';
      startIn?: FileSystemHandle;
    }): Promise<FileSystemDirectoryHandle>;
  }
}

const DB_NAME = 'blsee-workspace';
const STORE = 'handles';
const ROOT_KEY = 'root';
const MODE = { mode: 'readwrite' } as const;

/**
 * none: 작업공간을 정하지 않음 (브라우저에 저장) / ready: 쓸 수 있음
 * prompt: 다시 허용받아야 함 (크롬을 다시 켠 뒤 등) / missing: 폴더를 찾을 수 없음 (저장장치를 뺐거나 폴더를 옮김)
 */
export type WorkspaceState =
  | { kind: 'none' }
  | { kind: 'ready' | 'prompt' | 'missing'; name: string };

/** 작업공간을 정했는데 지금 쓸 수 없을 때. 이때는 브라우저 저장소로 대신 저장하지 않는다. */
export class WorkspaceUnavailableError extends Error {
  constructor(readonly state: WorkspaceState) {
    super(
      state.kind === 'missing'
        ? '작업공간 폴더를 찾을 수 없어요. 저장장치를 연결한 뒤 다시 시도해 주세요.'
        : '작업공간 폴더에 다시 연결해야 해요.',
    );
  }
}

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

function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = run(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

let cached: FileSystemDirectoryHandle | null | undefined;
const listeners = new Set<() => void>();

/** 다른 확장 화면(연결 탭 등)에서 작업공간을 바꾸거나 다시 연결하면 알린다. */
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('blsee-workspace');
const settingsListeners = new Set<() => void>();
channel?.addEventListener('message', (e: MessageEvent<'changed' | 'open-settings'>) => {
  if (e.data === 'open-settings') return settingsListeners.forEach((l) => l());
  cached = undefined;
  listeners.forEach((l) => l());
});

function notifyChange() {
  listeners.forEach((l) => l());
  channel?.postMessage('changed');
}

/** 연결 탭에서 다시 연결하지 못했을 때, 사이드 패널에 작업공간 설정을 띄우게 한다. */
export function requestWorkspaceSettings(): void {
  channel?.postMessage('open-settings');
}

/** 작업공간 설정을 띄워 달라는 요청을 받으면 부른다. 해제 함수를 돌려준다. */
export function onWorkspaceSettingsRequest(listener: () => void): () => void {
  settingsListeners.add(listener);
  return () => settingsListeners.delete(listener);
}

async function loadHandle(): Promise<FileSystemDirectoryHandle | null> {
  if (cached === undefined) cached = ((await idb('readonly', (s) => s.get(ROOT_KEY))) as FileSystemDirectoryHandle | undefined) ?? null;
  return cached;
}

async function saveHandle(handle: FileSystemDirectoryHandle | null): Promise<void> {
  if (handle) await idb('readwrite', (s) => s.put(handle, ROOT_KEY));
  else await idb('readwrite', (s) => s.delete(ROOT_KEY));
  cached = handle;
  notifyChange();
}

/** 작업공간 상태가 바뀌면 (고르기, 해제, 다시 연결) 부른다. 해제 함수를 돌려준다. */
export function onWorkspaceChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function stateOf(handle: FileSystemDirectoryHandle): Promise<WorkspaceState> {
  const name = handle.name;
  if ((await handle.queryPermission(MODE)) !== 'granted') return { kind: 'prompt', name };
  try {
    // 폴더가 없어졌으면 여기서 NotFoundError가 난다.
    for await (const _ of handle.keys()) break;
    return { kind: 'ready', name };
  } catch {
    return { kind: 'missing', name };
  }
}

export async function workspaceState(): Promise<WorkspaceState> {
  const handle = await loadHandle();
  return handle ? stateOf(handle) : { kind: 'none' };
}

/** 저장할 폴더. 작업공간을 안 정했으면 null, 정했는데 지금 못 쓰면 WorkspaceUnavailableError */
export async function activeWorkspace(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await loadHandle();
  if (!handle) return null;
  const state = await stateOf(handle);
  if (state.kind !== 'ready') throw new WorkspaceUnavailableError(state);
  return handle;
}

/** 블씨 내부 파일을 두는 숨김 폴더 */
export const INTERNAL = '.blsee';
/** 작업공간 폴더임을 나타내는 파일 */
const MARKER = `${INTERNAL}/workspace.json`;
/** 다른 파일이 있는 폴더를 고르면 그 안에 만들어 쓰는 폴더 */
export const SUBFOLDER = 'blsee-workspace';

/** 예전 구조의 작업공간 (표시 파일이 맨 위에 있거나, 표시 파일 없이 만든 것) */
const LEGACY_MARKER = 'blsee-workspace.json';
const LEGACY_ENTRIES = ['index.json', 'posts', 'library'];

async function hasEntry(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  for await (const key of dir.keys()) if (key === name) return true;
  return false;
}

async function isWorkspace(dir: FileSystemDirectoryHandle): Promise<boolean> {
  if ((await readFile(dir, MARKER)) || (await hasEntry(dir, LEGACY_MARKER))) return true;
  const names: string[] = [];
  for await (const key of dir.keys()) if (!key.startsWith('.')) names.push(key);
  return names.length > 0 && names.every((n) => LEGACY_ENTRIES.includes(n));
}

async function isEmpty(dir: FileSystemDirectoryHandle): Promise<boolean> {
  for await (const key of dir.keys()) if (!key.startsWith('.')) return false;
  return true;
}

export async function markWorkspace(dir: FileSystemDirectoryHandle): Promise<void> {
  if (await readFile(dir, MARKER)) return;
  await writeJson(dir, MARKER, {
    app: 'blsee',
    version: 1,
    createdAt: new Date().toISOString(),
    note: '블씨 작업공간입니다. 이 폴더를 고르면 대화와 이미지를 이어서 씁니다.',
  });
}

/**
 * 폴더 고르기 창을 띄운다 (버튼 클릭 안에서 불러야 한다). 취소하면 null
 * - 작업공간 표시 파일이 있거나 빈 폴더: 그대로 쓴다.
 * - 다른 파일이 있는 폴더: askSubfolder가 true를 주면 그 안의 blsee-workspace 폴더를 쓴다 (있으면 그대로).
 */
export async function pickWorkspace(askSubfolder: (folderName: string) => boolean | Promise<boolean>): Promise<FileSystemDirectoryHandle | null> {
  // 이미 정한 작업공간이 있으면 (다시 고를 때) 그 폴더에서 시작한다.
  const current = await loadHandle();
  let picked: FileSystemDirectoryHandle;
  try {
    picked = await window.showDirectoryPicker(current ? { startIn: current, mode: 'readwrite' } : { id: 'blsee-workspace', mode: 'readwrite' });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
  if ((await picked.requestPermission(MODE)) !== 'granted') throw new Error('폴더에 쓰기 권한을 받지 못했어요.');

  let root = picked;
  if (!(await isWorkspace(picked)) && !(await isEmpty(picked))) {
    const existing = (await hasEntry(picked, SUBFOLDER)) ? await picked.getDirectoryHandle(SUBFOLDER).catch(() => null) : null;
    if (existing && (await isWorkspace(existing))) root = existing;
    else if (!(await askSubfolder(picked.name))) return null;
    else root = await picked.getDirectoryHandle(SUBFOLDER, { create: true });
  }
  await markWorkspace(root);
  await saveHandle(root);
  return root;
}

/**
 * 권한을 다시 받는다 (버튼 클릭 안에서 불러야 한다). 사이드 패널에서는 크롬이 권한 창을 띄우지 않으므로
 * 연결 탭(connect.html)에서 부른다.
 */
export async function reconnectWorkspace(): Promise<WorkspaceState> {
  const handle = await loadHandle();
  if (!handle) return { kind: 'none' };
  await handle.requestPermission(MODE).catch(() => 'denied');
  notifyChange();
  return stateOf(handle);
}

/** 권한 창을 띄울 수 있는 연결 탭을 연다. */
export async function openConnectPage(): Promise<void> {
  await browser.tabs.create({ url: browser.runtime.getURL('/connect.html') });
}

/** 작업공간을 해제한다. 폴더의 파일은 그대로 둔다. */
export function forgetWorkspace(): Promise<void> {
  return saveHandle(null);
}

/* 경로("a/b/c.json")로 다루는 파일 도구 */

const parts = (path: string) => path.split('/').filter(Boolean);

async function dirAt(root: FileSystemDirectoryHandle, names: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const name of names) dir = await dir.getDirectoryHandle(name, { create });
  return dir;
}

const isNotFound = (err: unknown) => err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError');

export async function readFile(root: FileSystemDirectoryHandle, path: string): Promise<File | null> {
  const names = parts(path);
  try {
    const dir = await dirAt(root, names.slice(0, -1), false);
    return await (await dir.getFileHandle(names[names.length - 1])).getFile();
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function readJson<T>(root: FileSystemDirectoryHandle, path: string): Promise<T | null> {
  const file = await readFile(root, path);
  if (!file) return null;
  try {
    return JSON.parse(await file.text()) as T;
  } catch {
    return null;
  }
}

export async function writeFile(root: FileSystemDirectoryHandle, path: string, data: Blob | string): Promise<void> {
  const names = parts(path);
  const dir = await dirAt(root, names.slice(0, -1), true);
  const writable = await (await dir.getFileHandle(names[names.length - 1], { create: true })).createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    throw err;
  }
}

export function writeJson(root: FileSystemDirectoryHandle, path: string, value: unknown): Promise<void> {
  return writeFile(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function removeEntry(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  const names = parts(path);
  const name = names[names.length - 1];
  let parent: FileSystemDirectoryHandle;
  try {
    parent = await dirAt(root, names.slice(0, -1), false);
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
  try {
    await parent.removeEntry(name, { recursive: true });
    return;
  } catch (err) {
    if (isNotFound(err)) return;
    // 폴더째 지우기가 거절되면 안쪽부터 하나씩 지운다. exFAT 등에서는 macOS가 파일마다 「._이름」 파일을 붙이고
    // 원래 파일을 지울 때 함께 지워서, 폴더째 지우기가 중간에 실패할 수 있다.
    const dir = await parent.getDirectoryHandle(name).catch(() => null);
    if (!dir) throw err;
  }
  // 하나를 못 지워도 나머지는 지운다. 첫 오류는 끝에 던진다.
  let failure: unknown = null;
  for (const kind of ['directory', 'file'] as const) {
    for (const child of await listNames(root, path, kind)) {
      await removeEntry(root, `${path}/${child}`).catch((err) => (failure ??= err));
    }
  }
  try {
    await parent.removeEntry(name);
  } catch (err) {
    if (!isNotFound(err)) throw failure ?? err;
  }
}

/** 폴더 바로 아래의 항목 이름 (kind로 거른다). 폴더가 없으면 빈 목록 */
export async function listNames(root: FileSystemDirectoryHandle, path: string, kind: FileSystemHandleKind): Promise<string[]> {
  try {
    const dir = await dirAt(root, parts(path), false);
    const names: string[] = [];
    for await (const [name, handle] of dir.entries()) if (handle.kind === kind) names.push(name);
    return names;
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}
