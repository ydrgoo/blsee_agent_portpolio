/**
 * 작업공간 폴더에 대화와 라이브러리(이미지, 검색 자료)를 저장한다.
 * 사용자가 쓰는 자료는 맨 위에, 블씨 내부 파일은 숨김 폴더(.blsee)에 둔다.
 *
 * images/{YYYY-MM}/{이름}_{ID}.png              이미지 (이름이 없으면 {ID}.png)
 * research/{YYYY-MM}/{날짜}_{질문}_{ID}.md        검색 자료 (frontmatter + 본문)
 * prompts/{YYYY-MM}/{이름}_{ID}.md              저장 프롬프트 (frontmatter + 본문)
 * .blsee/workspace.json                         작업공간 표시
 * .blsee/index.json                             찾기용 (지워지거나 판이 바뀌면 폴더를 훑어 다시 만든다)
 * .blsee/posts/{날짜}_{제목}_{키 4자}/post.json, conversation.json
 * .blsee/images/{ID}.json                       이미지 정보 (이름, 출처, AI 여부, 만든 글, 파일 경로)
 * .blsee/research/{ID}.json                     사용자가 넣은 md의 ID (frontmatter가 없는 md)
 *
 * images/, research/ 에는 사용자가 직접 파일을 넣어도 된다. 폴더를 훑을 때 찾아 라이브러리에 넣는다.
 */
import { genImageUri, newGenImageId, parseUri } from '@blog-helper/se-model';
import {
  fontUri,
  htmlUri,
  htmlUriVariants,
  isHtmlUri,
  RESERVED_PROMPT_COMMANDS,
  commandNameOf,
  researchUri,
  type DocToolArgs,
  type PromptParam,
  type PromptScope,
  type ResearchKind,
} from '@blog-helper/shared';
import type { Conversation, ConversationSummary } from './conversations';
import type { ImageMeta } from './image-store';
import { blobHash } from './images';
import { INTERNAL, listNames, markWorkspace, readFile, readJson, removeEntry, writeFile, writeJson } from './workspace';

type Root = FileSystemDirectoryHandle;

interface PostEntry extends Omit<ConversationSummary, 'key'> {
  folder: string;
  createdAt: number;
}

/** 이미지 하나의 찾기용 정보 (이미지 정보 파일의 요약) */
export interface ImageEntry extends ImageMeta {
  path: string;
  /** 이미지 정보 파일 경로 */
  sidecar: string;
  createdAt: number;
  /** 만든 글 제목 */
  title: string;
}

/** added: 사용자가 research 폴더에 직접 넣은 md */
type ResearchEntryKind = ResearchKind | 'added';

interface PromptEntry {
  path: string;
  name: string;
  command: string;
  scope: PromptScope;
  /** scope가 post일 때 글 키 */
  post?: string;
  /** 목록에 보일 한 줄 설명 */
  description?: string;
  /** 칸 이름 (목록에 보인다) */
  params?: string[];
  createdAt: number;
}

interface ResearchEntry {
  path: string;
  /** 사용자가 넣은 md의 ID 기록 파일 */
  sidecar?: string;
  query: string;
  kind: ResearchEntryKind;
  createdAt: number;
  title: string;
  preview: string;
}

const VERSION = 4;

interface HtmlEntry {
  path: string;
  /** 이 HTML로 그린 이미지 URI (있으면) */
  imageUri?: string;
  createdAt: number;
}

export interface FontEntry {
  path: string;
  sidecar: string;
  /** CSS font-family */
  family: string;
  name: string;
  source?: string;
  createdAt: number;
}

interface FontSidecar {
  id: string;
  uri: string;
  path: string;
  family: string;
  name: string;
  source?: string;
  createdAt: number;
}

interface WorkspaceIndex {
  version: typeof VERSION;
  posts: Record<string, PostEntry>;
  /** 이미지 키(imageKey) → 정보 */
  images: Record<string, ImageEntry>;
  /** 내용 해시 → 이미지 URI (lib 중복 방지) */
  hashes: Record<string, string>;
  /** blsee://lib/infographics/… (및 옛 lib/html/…) → 정보 */
  htmls: Record<string, HtmlEntry>;
  /** blsee://lib/fonts/… → 정보 */
  fonts: Record<string, FontEntry>;
  /** blsee://lib/research/… → 정보 */
  research: Record<string, ResearchEntry>;
  /** 프롬프트 ID → 정보 */
  prompts: Record<string, PromptEntry>;
}

interface PostFile {
  key: string;
  documentId: string;
  title: string;
  url?: string;
  createdAt: number;
  updatedAt: number;
}

type ConversationFile = Pick<Conversation, 'messages' | 'history' | 'turnMeta' | 'refs'>;

export interface ImageSidecar extends ImageMeta {
  id: string;
  uri: string;
  /** 이미지 파일 경로 (작업공간 기준) */
  path: string;
  createdAt: number;
  origin: { postKey: string; title: string };
}

interface ResearchSidecar {
  id: string;
  uri: string;
  path: string;
}

const INDEX = `${INTERNAL}/index.json`;
const POSTS = `${INTERNAL}/posts`;
const IMAGE_META = `${INTERNAL}/images`;
const FONT_META = `${INTERNAL}/fonts`;
const RESEARCH_META = `${INTERNAL}/research`;
const IMAGES = 'images';
const FONTS = 'fonts';
const RESEARCH = 'research';
const PROMPTS = 'prompts';
const PREVIEW_CHARS = 120;
const IMAGE_EXTS = /\.(png|jpe?g|webp|gif|svg)$/i;
const FONT_EXTS = /\.(woff2|woff|ttf|otf)$/i;
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

/** 라이브러리 이미지(blsee://lib/images/…)는 어느 글에서나 같은 키, 예전 대화 이미지(blsee://gen/…)는 글마다 */
const imageKey = (convKey: string, uri: string) => (uri.startsWith('blsee://lib/') ? uri : `${convKey}|${uri}`);
const idOf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const stripExt = (name: string) => name.replace(/\.[^.]+$/, '');

/* 폴더 하나에서 index.json을 고치는 작업은 한 번에 하나씩 */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

let cache: { root: Root; index: WorkspaceIndex } | null = null;
let indexLoading: { root: Root; promise: Promise<WorkspaceIndex> } | null = null;

function loadIndex(root: Root): Promise<WorkspaceIndex> {
  if (cache?.root === root) return Promise.resolve(cache.index);
  if (indexLoading?.root !== root) {
    const promise = (async () => {
      await migrateLegacyLayout(root);
      const got = await readJson<WorkspaceIndex>(root, INDEX);
      const index =
        got?.version === VERSION && got.posts && got.images && got.research && got.hashes && got.htmls
          ? { ...got, fonts: got.fonts ?? {}, prompts: got.prompts ?? {} }
          : await rebuildIndex(root);
      cache = { root, index };
      lastSync = 0;
      return index;
    })().finally(() => (indexLoading = null));
    indexLoading = { root, promise };
  }
  return indexLoading.promise;
}

async function saveIndex(root: Root, index: WorkspaceIndex): Promise<void> {
  cache = { root, index };
  await writeJson(root, INDEX, index);
}

/** 폴더를 훑어 index.json을 다시 만든다. */
async function rebuildIndex(root: Root): Promise<WorkspaceIndex> {
  const index: WorkspaceIndex = { version: VERSION, posts: {}, images: {}, hashes: {}, htmls: {}, fonts: {}, research: {}, prompts: {} };
  for (const folder of await listNames(root, POSTS, 'directory')) {
    const post = await readJson<PostFile>(root, `${POSTS}/${folder}/post.json`);
    if (!post?.key) continue;
    const conv = (await readJson<ConversationFile>(root, `${POSTS}/${folder}/conversation.json`)) ?? { messages: [], history: [] };
    index.posts[post.key] = { ...summaryOf({ ...post, ...conv }), folder, createdAt: post.createdAt };
  }
  for (const name of await listNames(root, IMAGE_META, 'file')) {
    if (!name.endsWith('.json')) continue;
    const sidecar = `${IMAGE_META}/${name}`;
    const side = await readJson<ImageSidecar>(root, sidecar);
    if (side?.uri && side.path) {
      index.images[imageKey(side.origin?.postKey ?? '', side.uri)] = imageEntry(side, sidecar);
      if (side.hash) index.hashes[side.hash] = side.uri;
    }
  }
  for (const path of await libraryFiles(root, IMAGES, /\.html$/i)) {
    const m = /_([a-z0-9]{8})\.html$/i.exec(baseName(path));
    if (!m) continue;
    const uri = htmlUri(m[1]);
    index.htmls[uri] ??= { path, createdAt: Date.now() };
  }
  for (const name of await listNames(root, FONT_META, 'file')) {
    if (!name.endsWith('.json')) continue;
    const sidecar = `${FONT_META}/${name}`;
    const side = await readJson<FontSidecar>(root, sidecar);
    if (side?.uri && side.path) {
      index.fonts[side.uri] = {
        path: side.path,
        sidecar,
        family: side.family,
        name: side.name,
        source: side.source,
        createdAt: side.createdAt,
      };
    }
  }
  for (const path of await libraryFiles(root, FONTS, FONT_EXTS)) {
    const m = /_([a-z0-9]{8})\.(woff2|woff|ttf|otf)$/i.exec(baseName(path));
    if (!m || index.fonts[fontUri(m[1])]) continue;
    index.fonts[fontUri(m[1])] = {
      path,
      sidecar: '',
      family: stripExt(baseName(path)).replace(/_[a-z0-9]{8}$/i, ''),
      name: stripExt(baseName(path)),
      createdAt: Date.now(),
    };
  }
  const researchIds = new Map<string, ResearchSidecar & { sidecar: string }>();
  for (const name of await listNames(root, RESEARCH_META, 'file')) {
    const sidecar = `${RESEARCH_META}/${name}`;
    const side = name.endsWith('.json') ? await readJson<ResearchSidecar>(root, sidecar) : null;
    if (side?.path) researchIds.set(side.path, { ...side, sidecar });
  }
  await syncLibrary(root, index, researchIds);
  await scanPrompts(root, index);
  await writeJson(root, INDEX, index);
  return index;
}

/** prompts/ 의 md를 찾이용 목록에 맞춘다. frontmatter의 id·command를 쓴다. */
async function scanPrompts(root: Root, index: WorkspaceIndex): Promise<void> {
  index.prompts ??= {};
  const files = await libraryFiles(root, PROMPTS, /\.md$/i);
  const onDisk = new Set(files);
  for (const [id, entry] of Object.entries(index.prompts)) {
    if (!onDisk.has(entry.path)) delete index.prompts[id];
  }
  const known = new Set(Object.values(index.prompts).map((entry) => entry.path));
  for (const path of files) {
    if (known.has(path)) continue;
    const file = await readFile(root, path);
    if (!file) continue;
    const meta = frontmatter(await file.text());
    const id = typeof meta.id === 'string' ? meta.id : /_([a-z0-9]+)\.md$/i.exec(baseName(path))?.[1];
    const command = typeof meta.command === 'string' ? meta.command : '';
    if (!id || !command || index.prompts[id]) continue;
    const scope = meta.scope === 'all' ? 'all' : 'post';
    index.prompts[id] = {
      path,
      name: typeof meta.name === 'string' ? meta.name : command,
      command,
      scope,
      ...(scope === 'post' && typeof meta.post === 'string' ? { post: meta.post } : {}),
      ...(typeof meta.description === 'string' && meta.description ? { description: meta.description } : {}),
      params: paramsOf(meta.params).map((p) => p.name),
      createdAt: file.lastModified || Date.now(),
    };
  }
}

function frontmatter(text: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const raw = line.slice(i + 1).trim();
    try {
      meta[line.slice(0, i).trim()] = JSON.parse(raw);
    } catch {
      meta[line.slice(0, i).trim()] = raw;
    }
  }
  return meta;
}

/** images/, research/ 아래 파일 (바로 아래와 한 단계 아래 폴더). 숨김 파일은 뺀다. */
async function libraryFiles(root: Root, top: string, match: RegExp): Promise<string[]> {
  const paths = (await listNames(root, top, 'file')).map((n) => `${top}/${n}`);
  for (const dir of await listNames(root, top, 'directory')) {
    if (dir.startsWith('.')) continue;
    paths.push(...(await listNames(root, `${top}/${dir}`, 'file')).map((n) => `${top}/${dir}/${n}`));
  }
  return paths.filter((p) => !baseName(p).startsWith('.') && match.test(p));
}

/**
 * 폴더와 색인을 맞춘다: 사용자가 넣은 파일은 라이브러리에 넣고, 지워진 파일은 뺀다.
 * researchIds: 다시 만들 때만 (사용자가 넣은 md의 ID 기록). 바뀌었으면 true
 */
async function syncLibrary(root: Root, index: WorkspaceIndex, researchIds?: Map<string, ResearchSidecar & { sidecar: string }>): Promise<boolean> {
  let changed = false;

  const imageFiles = await libraryFiles(root, IMAGES, IMAGE_EXTS);
  const onDisk = new Set(imageFiles);
  for (const [key, e] of Object.entries(index.images)) {
    if (onDisk.has(e.path)) continue;
    // listNames가 놓친 경우 readFile로 한 번 더 확인한다.
    if (await readFile(root, e.path)) continue;
    delete index.images[key];
    const uri = key.startsWith('blsee://') ? key : key.slice(key.indexOf('|') + 1);
    if (e.hash && index.hashes[e.hash] === uri) delete index.hashes[e.hash];
    await removeEntry(root, e.sidecar);
    changed = true;
  }
  const known = new Set(Object.values(index.images).map((e) => e.path));
  const takenIds = new Set(Object.keys(index.images).map(idOf));
  for (const path of imageFiles) {
    if (known.has(path)) continue;
    const file = await readFile(root, path);
    if (!file) continue;
    const id = newGenImageId(takenIds);
    takenIds.add(id);
    const side: ImageSidecar = {
      id,
      uri: genImageUri(id),
      path,
      createdAt: file.lastModified || Date.now(),
      origin: { postKey: '', title: '' },
      kind: 'added',
      name: stripExt(baseName(path)),
      ai: false,
    };
    const sidecar = await freeSidecar(root, IMAGE_META, id);
    await writeJson(root, sidecar, side);
    index.images[side.uri] = imageEntry(side, sidecar);
    changed = true;
  }

  const fontFiles = await libraryFiles(root, FONTS, FONT_EXTS);
  const fontsOnDisk = new Set(fontFiles);
  for (const [uri, e] of Object.entries(index.fonts)) {
    if (fontsOnDisk.has(e.path)) continue;
    delete index.fonts[uri];
    if (e.sidecar) await removeEntry(root, e.sidecar);
    changed = true;
  }
  const knownFonts = new Set(Object.values(index.fonts).map((e) => e.path));
  const takenFontIds = new Set(Object.keys(index.fonts).map(idOf));
  for (const path of fontFiles) {
    if (knownFonts.has(path)) continue;
    const file = await readFile(root, path);
    if (!file) continue;
    const id = newGenImageId(takenFontIds);
    takenFontIds.add(id);
    const family = stripExt(baseName(path)).replace(/_[a-z0-9]{8}$/i, '') || 'CustomFont';
    const side: FontSidecar = {
      id,
      uri: fontUri(id),
      path,
      family,
      name: family,
      createdAt: file.lastModified || Date.now(),
    };
    const sidecar = await freeSidecar(root, FONT_META, id);
    await writeJson(root, sidecar, side);
    index.fonts[side.uri] = {
      path,
      sidecar,
      family: side.family,
      name: side.name,
      createdAt: side.createdAt,
    };
    changed = true;
  }

  const mdFiles = await libraryFiles(root, RESEARCH, /\.md$/i);
  const mdOnDisk = new Set(mdFiles);
  for (const [uri, e] of Object.entries(index.research)) {
    if (mdOnDisk.has(e.path)) continue;
    delete index.research[uri];
    if (e.sidecar) await removeEntry(root, e.sidecar);
    changed = true;
  }
  const knownMd = new Set(Object.values(index.research).map((e) => e.path));
  const takenMd = new Set(Object.keys(index.research).map(idOf));
  for (const path of mdFiles) {
    if (knownMd.has(path)) continue;
    const file = await readFile(root, path);
    if (!file) continue;
    const text = await file.text();
    const parsed = parseResearch(text);
    if (parsed?.meta.uri && !index.research[parsed.meta.uri]) {
      index.research[parsed.meta.uri] = researchEntry(parsed.meta, parsed.body, path);
      changed = true;
      continue;
    }
    let side = researchIds?.get(path);
    if (!side || index.research[side.uri]) {
      const id = newGenImageId(takenMd);
      const sidecar = await freeSidecar(root, RESEARCH_META, id);
      side = { id, uri: researchUri(id), path, sidecar };
      await writeJson(root, sidecar, { id, uri: side.uri, path });
    }
    takenMd.add(side.id);
    const heading = /^#\s+(.+)$/m.exec(parsed?.body ?? text)?.[1]?.trim();
    index.research[side.uri] = {
      path,
      sidecar: side.sidecar,
      query: heading || stripExt(baseName(path)),
      kind: 'added',
      createdAt: file.lastModified || Date.now(),
      title: '',
      preview: previewOf(parsed?.body ?? text),
    };
    changed = true;
  }
  return changed;
}

const SYNC_MS = 30_000;
let lastSync = 0;

/** 사용자가 넣거나 지운 파일을 반영한다 (자주 부르면 SYNC_MS에 한 번만). */
function syncIfStale(root: Root): Promise<void> {
  if (Date.now() - lastSync < SYNC_MS) return Promise.resolve();
  lastSync = Date.now();
  return serial(async () => {
    const index = await loadIndex(root);
    if (await syncLibrary(root, index)) await saveIndex(root, index);
  });
}

/** 정보 파일 이름이 겹치면 -2, -3을 붙인다. */
async function freeSidecar(root: Root, dir: string, id: string): Promise<string> {
  const used = new Set(await listNames(root, dir, 'file'));
  let name = id;
  for (let n = 2; used.has(`${name}.json`); n++) name = `${id}-${n}`;
  return `${dir}/${name}.json`;
}

/* 예전 구조(맨 위의 index.json, posts/, library/)를 새 구조로 옮긴다 */

interface LegacySidecar extends ImageMeta {
  id: string;
  uri: string;
  file: string;
  createdAt: number;
  origin: { postKey: string; title: string };
}

/** 새 위치에 이미 있으면 (전에 옮긴 뒤 이어 쓴 것일 수 있다) 덮어쓰지 않는다. */
async function copy(root: Root, from: string, to: string): Promise<boolean> {
  if (await readFile(root, to)) return true;
  const file = await readFile(root, from);
  if (!file) return false;
  await writeFile(root, to, file);
  return true;
}

async function migrateLegacyLayout(root: Root): Promise<void> {
  const top = new Set([...(await listNames(root, '', 'directory')), ...(await listNames(root, '', 'file'))]);
  if (!top.has('posts') && !top.has('library') && !top.has('index.json')) return;

  for (const folder of await listNames(root, 'posts', 'directory')) {
    for (const name of ['post.json', 'conversation.json']) await copy(root, `posts/${folder}/${name}`, `${POSTS}/${folder}/${name}`);
  }
  for (const month of await listNames(root, 'library/images', 'directory')) {
    for (const name of await listNames(root, `library/images/${month}`, 'file')) {
      if (!name.endsWith('.json')) continue;
      const old = await readJson<LegacySidecar>(root, `library/images/${month}/${name}`);
      if (!old?.uri || !old.file) continue;
      if (old.uri.startsWith('blsee://lib/') && (await readFile(root, `${IMAGE_META}/${old.id}.json`))) continue;
      const { file, ...meta } = old;
      const ext = file.slice(file.lastIndexOf('.') + 1);
      const path = `${IMAGES}/${month}/${imageFileBase(old.id, old.name)}.${ext}`;
      if (!(await copy(root, `library/images/${month}/${file}`, path))) continue;
      await writeJson(root, await freeSidecar(root, IMAGE_META, old.id), { ...meta, path } satisfies ImageSidecar);
    }
  }
  for (const month of await listNames(root, 'library/research', 'directory')) {
    for (const name of await listNames(root, `library/research/${month}`, 'file')) {
      if (name.endsWith('.md')) await copy(root, `library/research/${month}/${name}`, `${RESEARCH}/${month}/${name}`);
    }
  }
  await markWorkspace(root);
  // 옮긴 뒤에는 예전 파일을 지운다. 못 지운 것은 다음에 열 때 다시 옮기고 지운다 (덮어쓰기라 안전하다).
  for (const name of ['posts', 'library', 'index.json', 'blsee-workspace.json']) {
    await removeEntry(root, name).catch((err) => console.warn(`[blsee] 예전 작업공간 파일을 지우지 못했습니다: ${name}`, err));
  }
}

export function summaryOf(c: Pick<Conversation, 'key' | 'title' | 'documentId' | 'url' | 'updatedAt' | 'history'>): ConversationSummary {
  const lastUser = [...c.history].reverse().find((t) => t.role === 'user');
  return {
    key: c.key,
    title: c.title,
    documentId: c.documentId,
    url: c.url,
    updatedAt: c.updatedAt,
    turns: c.history.filter((t) => t.role === 'user').length,
    preview: lastUser?.text ?? '',
    searchText: `${c.title}\n${c.history.map((t) => t.text).join('\n')}`.toLowerCase(),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const ym = (ms: number) => ymd(ms).slice(0, 7);

/** 파일 이름에 못 쓰는 글자를 '-'로 바꾼다. */
export function slug(text: string, max: number): string {
  return text
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, max)
    .replace(/[-.]+$/, '');
}

const NAME_IN_FILE = 40;
const imageFileBase = (id: string, name?: string) => {
  const s = name ? slug(name, NAME_IN_FILE) : '';
  return s ? `${s}_${id}` : id;
};

function postFolder(index: WorkspaceIndex, key: string, title: string, createdAt: number): string {
  const tag = key.replace(/^SE-/i, '').replace(/[^0-9a-z]/gi, '');
  const taken = new Set(Object.entries(index.posts).filter(([k]) => k !== key).map(([, p]) => p.folder));
  const base = `${ymd(createdAt)}_${slug(title, 40) || '제목-없음'}`;
  for (const len of [4, 8, tag.length]) {
    const name = `${base}_${tag.slice(0, len) || 'post'}`;
    if (!taken.has(name)) return name;
  }
  return `${base}_${Date.now().toString(36)}`;
}

/* 대화 */

export async function loadConversation(root: Root, key: string): Promise<Conversation | null> {
  const entry = (await loadIndex(root)).posts[key];
  if (!entry) return null;
  const dir = `${POSTS}/${entry.folder}`;
  const post = await readJson<PostFile>(root, `${dir}/post.json`);
  const conv = await readJson<ConversationFile>(root, `${dir}/conversation.json`);
  if (!post || !conv) return null;
  return { key, title: post.title, documentId: post.documentId, url: post.url, updatedAt: post.updatedAt, ...conv };
}

export function saveConversation(root: Root, conv: Conversation): Promise<void> {
  return serial(async () => {
    const index = await loadIndex(root);
    const old = index.posts[conv.key];
    const createdAt = old?.createdAt ?? conv.updatedAt;
    const folder = old?.folder ?? postFolder(index, conv.key, conv.title, createdAt);
    const dir = `${POSTS}/${folder}`;
    const post: PostFile = {
      key: conv.key,
      documentId: conv.documentId,
      title: conv.title,
      url: conv.url,
      createdAt,
      updatedAt: conv.updatedAt,
    };
    const body: ConversationFile = { messages: conv.messages, history: conv.history, turnMeta: conv.turnMeta, refs: conv.refs };
    await writeJson(root, `${dir}/conversation.json`, body);
    await writeJson(root, `${dir}/post.json`, post);
    const { key: _, ...summary } = summaryOf(conv);
    index.posts[conv.key] = { ...summary, folder, createdAt };
    await saveIndex(root, index);
  });
}

/** 글 폴더만 지운다. 라이브러리의 이미지와 검색 자료는 남긴다. */
export function deleteConversation(root: Root, key: string): Promise<void> {
  return serial(async () => {
    const index = await loadIndex(root);
    const entry = index.posts[key];
    if (!entry) return;
    await removeEntry(root, `${POSTS}/${entry.folder}`);
    delete index.posts[key];
    await saveIndex(root, index);
  });
}

export async function listConversations(root: Root): Promise<ConversationSummary[]> {
  const index = await loadIndex(root);
  return Object.entries(index.posts)
    .map(([key, { folder: _f, createdAt: _c, ...rest }]) => ({ key, ...rest }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function clearConversations(root: Root): Promise<number> {
  return serial(async () => {
    const index = await loadIndex(root);
    const entries = Object.values(index.posts);
    for (const entry of entries) await removeEntry(root, `${POSTS}/${entry.folder}`);
    index.posts = {};
    await saveIndex(root, index);
    return entries.length;
  });
}

/* 이미지 */

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
/** 모르는 MIME은 png로 둔다. bin이면 sync가 이미지로 못 보고 색인에서 지워 HTML URI가 고아가 된다. */
export const extOf = (type: string) => EXT[type] ?? 'png';

function imageEntry(side: ImageSidecar, sidecar: string): ImageEntry {
  const { id: _i, uri: _u, origin, ...meta } = side;
  return { ...meta, sidecar, title: origin?.title ?? '' };
}

/**
 * 이미지를 라이브러리에 넣는다. 같은 내용 해시가 있으면 파일을 추가하지 않고 기존 URI를 돌려준다.
 */
export function putImage(root: Root, convKey: string, uri: string, blob: Blob, meta: ImageMeta): Promise<string> {
  return serial(async () => {
    const index = await loadIndex(root);
    const hash = meta.hash ?? (await blobHash(blob));
    const known = index.hashes[hash];
    const knownKey = known
      ? index.images[known]
        ? known
        : index.images[imageKey(convKey, known)]
          ? imageKey(convKey, known)
          : null
      : null;
    if (known && knownKey) {
      const alive = await readFile(root, index.images[knownKey].path);
      if (alive) return known;
      // 색인만 있고 파일이 없으면 고아로 보고 새로 쓴다.
      delete index.images[knownKey];
      delete index.hashes[hash];
    }

    const id = idOf(uri);
    const now = Date.now();
    const dir = `${IMAGES}/${ym(now)}`;
    const mime = blob.type && EXT[blob.type] ? blob.type : 'image/png';
    const fileBlob = blob.type === mime ? blob : new Blob([blob], { type: mime });
    const ext = extOf(mime);
    const used = new Set(await listNames(root, dir, 'file'));
    const base = imageFileBase(id, meta.name);
    let name = base;
    for (let n = 2; used.has(`${name}.${ext}`); n++) name = `${base}-${n}`;

    const side: ImageSidecar = {
      id,
      uri,
      path: `${dir}/${name}.${ext}`,
      createdAt: now,
      origin: { postKey: convKey, title: index.posts[convKey]?.title ?? '' },
      ...meta,
      hash,
    };
    const sidecar = await freeSidecar(root, IMAGE_META, id);
    await writeFile(root, side.path, fileBlob);
    await writeJson(root, sidecar, side);
    // 디스크에 실제로 남았는지 확인한다. 실패하면 색인에만 남는 고아 URI가 된다.
    if (!(await readFile(root, side.path))) {
      throw new Error(`${uri}: 이미지 파일을 쓰지 못했습니다 (${side.path}).`);
    }
    index.images[imageKey(convKey, uri)] = imageEntry(side, sidecar);
    index.hashes[hash] = uri;
    await saveIndex(root, index);
    return uri;
  });
}

/** 내용 해시로 lib 이미지를 찾는다. 색인에 실제 항목이 있을 때만 돌려준다 (고아 hashes 무시). */
export async function findImageByHash(root: Root, hash: string): Promise<string | null> {
  const index = await loadIndex(root);
  const uri = index.hashes[hash];
  if (uri && index.images[uri]) return uri;
  for (const [key, e] of Object.entries(index.images)) {
    if (e.hash === hash) return key.startsWith('blsee://') ? key : key.slice(key.indexOf('|') + 1);
  }
  return null;
}

/** 출처(source) 주소로 lib 이미지를 찾는다 (글 원본 pstatic 등). */
export async function findImageBySource(root: Root, source: string): Promise<string | null> {
  const index = await loadIndex(root);
  for (const [key, e] of Object.entries(index.images)) {
    if (e.source === source) return key.startsWith('blsee://') ? key : key.slice(key.indexOf('|') + 1);
  }
  return null;
}

/**
 * HTML 원본을 저장하고 URI(blsee://lib/infographics/…)를 돌려준다.
 * imageUri가 있으면 그 이미지 메타에 htmlUri를 단다.
 */
export function putHtml(root: Root, html: string, o: { id: string; name?: string; imageUri?: string }): Promise<string> {
  return serial(async () => {
    const index = await loadIndex(root);
    const uri = htmlUri(o.id);
    const now = Date.now();
    const dir = `${IMAGES}/${ym(now)}`;
    const used = new Set(await listNames(root, dir, 'file'));
    let name = o.name ? `${slug(o.name, 40)}_${o.id}` : `infographic_${o.id}`;
    for (let n = 2; used.has(`${name}.html`); n++) name = `${o.name ? `${slug(o.name, 40)}_${o.id}` : `infographic_${o.id}`}-${n}`;
    const path = `${dir}/${name}.html`;
    await writeFile(root, path, new Blob([html], { type: 'text/html;charset=utf-8' }));
    index.htmls[uri] = { path, imageUri: o.imageUri, createdAt: now };
    // 옛 키로만 남아 있으면 정리
    delete index.htmls[`blsee://lib/html/${o.id}`];
    if (o.imageUri) {
      const key = Object.keys(index.images).find((k) => k === o.imageUri || k.endsWith(`|${o.imageUri}`));
      if (key) {
        const entry = index.images[key];
        const side = await readJson<ImageSidecar>(root, entry.sidecar);
        if (side) {
          side.htmlUri = uri;
          await writeJson(root, entry.sidecar, side);
          index.images[key] = imageEntry(side, entry.sidecar);
        }
      }
    }
    await saveIndex(root, index);
    return uri;
  });
}

function htmlEntryOf(index: WorkspaceIndex, htmlRef: string): HtmlEntry | undefined {
  for (const key of htmlUriVariants(htmlRef)) {
    const h = index.htmls[key];
    if (h) return h;
  }
  return undefined;
}

/** 인포그래픽 URI(blsee://lib/infographics/…)를 렌더해 둔 그림 URI. 없으면 null */
export async function htmlImageUri(root: Root, htmlUri: string): Promise<string | null> {
  return htmlEntryOf(await loadIndex(root), htmlUri)?.imageUri ?? null;
}

/** 인포 URI 또는 이미지 URI(메타 htmlUri)로 HTML 본문을 읽는다. */
export async function getHtml(root: Root, uri: string): Promise<string | null> {
  const index = await loadIndex(root);
  let htmlRef = uri;
  if (!isHtmlUri(uri)) {
    const entry = index.images[uri] ?? Object.entries(index.images).find(([k]) => k.endsWith(`|${uri}`))?.[1];
    if (!entry?.htmlUri) return null;
    htmlRef = entry.htmlUri;
  }
  const h = htmlEntryOf(index, htmlRef);
  if (!h) return null;
  const file = await readFile(root, h.path);
  return file ? file.text() : null;
}

/**
 * 글꼴 파일을 저장하고 URI(blsee://lib/fonts/…)를 돌려준다.
 * family는 CSS font-family에 쓸 이름, name은 사람이 읽는 이름이다.
 */
export function putFont(
  root: Root,
  blob: Blob,
  o: { id: string; name: string; family: string; source?: string },
): Promise<string> {
  return serial(async () => {
    const index = await loadIndex(root);
    const uri = fontUri(o.id);
    if (index.fonts[uri]) return uri;
    const now = Date.now();
    const dir = `${FONTS}/${ym(now)}`;
    const ext = (() => {
      const t = blob.type.toLowerCase();
      if (t.includes('woff2')) return 'woff2';
      if (t.includes('woff')) return 'woff';
      if (t.includes('ttf') || t.includes('truetype')) return 'ttf';
      if (t.includes('otf') || t.includes('opentype')) return 'otf';
      const fromName = /\.(woff2|woff|ttf|otf)(?:\?|$)/i.exec(o.source ?? '');
      return fromName?.[1]?.toLowerCase() ?? 'woff2';
    })();
    const used = new Set(await listNames(root, dir, 'file'));
    let base = `${slug(o.name || o.family, 40) || 'font'}_${o.id}`;
    for (let n = 2; used.has(`${base}.${ext}`); n++) base = `${slug(o.name || o.family, 40) || 'font'}_${o.id}-${n}`;
    const path = `${dir}/${base}.${ext}`;
    const type = MIME[ext] || blob.type || 'font/woff2';
    await writeFile(root, path, blob.type === type ? blob : new Blob([blob], { type }));
    const side: FontSidecar = {
      id: o.id,
      uri,
      path,
      family: o.family,
      name: o.name || o.family,
      source: o.source,
      createdAt: now,
    };
    const sidecar = await freeSidecar(root, FONT_META, o.id);
    await writeJson(root, sidecar, side);
    index.fonts[uri] = {
      path,
      sidecar,
      family: side.family,
      name: side.name,
      source: side.source,
      createdAt: now,
    };
    await saveIndex(root, index);
    return uri;
  });
}

export async function getFontBlob(root: Root, uri: string): Promise<{ blob: Blob; family: string; name: string } | null> {
  const entry = (await loadIndex(root)).fonts[uri];
  if (!entry) return null;
  const file = await readFile(root, entry.path);
  if (!file) return null;
  const type = file.type || MIME[entry.path.slice(entry.path.lastIndexOf('.') + 1).toLowerCase()] || 'font/woff2';
  return {
    blob: file.type === type ? file : new Blob([file], { type }),
    family: entry.family,
    name: entry.name,
  };
}

/** 워크스페이스에 저장된 커스텀 글꼴 목록 */
export async function listWorkspaceFonts(root: Root): Promise<{ uri: string; name: string; family: string; source?: string }[]> {
  await syncIfStale(root);
  return Object.entries((await loadIndex(root)).fonts).map(([uri, e]) => ({
    uri,
    name: e.name,
    family: e.family,
    source: e.source,
  }));
}

/** 워크스페이스 글꼴을 @font-face CSS로 만든다 (data URL). */
export async function workspaceFontFaceCss(root: Root): Promise<string> {
  const fonts = Object.entries((await loadIndex(root)).fonts);
  if (!fonts.length) return '';
  const { blobToDataUrl } = await import('./images');
  const parts: string[] = [];
  for (const [, e] of fonts) {
    const file = await readFile(root, e.path);
    if (!file) continue;
    const type = file.type || MIME[e.path.slice(e.path.lastIndexOf('.') + 1).toLowerCase()] || 'font/woff2';
    const blob = file.type === type ? file : new Blob([file], { type });
    const data = await blobToDataUrl(blob);
    const format =
      type.includes('woff2') || e.path.endsWith('.woff2')
        ? 'woff2'
        : type.includes('woff') || e.path.endsWith('.woff')
          ? 'woff'
          : type.includes('ttf') || e.path.endsWith('.ttf')
            ? 'truetype'
            : 'opentype';
    parts.push(
      `@font-face{font-family:'${e.family}';font-weight:400;font-style:normal;font-display:block;` +
        `src:url('${data}') format('${format}');}`,
    );
  }
  return parts.join('\n');
}

/** 색인에서 빠져도 사이드카가 가리키는 파일이 있으면 읽는다. 색인 복구는 serial로 한다. */
async function readImageViaSidecar(root: Root, convKey: string, uri: string): Promise<{ path: string; file: Blob } | null> {
  const id = idOf(uri);
  for (const name of await listNames(root, IMAGE_META, 'file')) {
    if (!name.startsWith(id) || !name.endsWith('.json')) continue;
    const side = await readJson<ImageSidecar>(root, `${IMAGE_META}/${name}`);
    if (!side || side.uri !== uri) continue;
    const file = await readFile(root, side.path);
    if (!file) continue;
    const sidecar = `${IMAGE_META}/${name}`;
    void serial(async () => {
      const index = await loadIndex(root);
      if (index.images[imageKey(convKey, uri)]) return;
      index.images[imageKey(convKey, uri)] = imageEntry(side, sidecar);
      if (side.hash) index.hashes[side.hash] = uri;
      await saveIndex(root, index);
    });
    return { path: side.path, file };
  }
  return null;
}

export async function getImage(root: Root, convKey: string, uri: string): Promise<Blob | null> {
  const entry = (await loadIndex(root)).images[imageKey(convKey, uri)];
  let path = entry?.path;
  let file: Blob | null = entry ? await readFile(root, entry.path) : null;
  if (!file) {
    const recovered = await readImageViaSidecar(root, convKey, uri);
    if (!recovered) return null;
    path = recovered.path;
    file = recovered.file;
  }
  // 사용자가 넣은 파일은 종류가 비어 있을 수 있다.
  const type = file.type || MIME[(path ?? '').slice((path ?? '').lastIndexOf('.') + 1).toLowerCase()] || '';
  return file.type === type ? file : new Blob([file], { type });
}

export async function imageInfo(root: Root, convKey: string, uri: string): Promise<ImageEntry | null> {
  return (await loadIndex(root)).images[imageKey(convKey, uri)] ?? null;
}

/** 글에 올린 뒤 pstatic 주소를 source로 남겨, 나중에 가리킬 때 같은 lib URI(인포 htmlUri 포함)를 찾게 한다. */
export function setImageSource(root: Root, convKey: string, uri: string, source: string): Promise<void> {
  return serial(async () => {
    const index = await loadIndex(root);
    const key = imageKey(convKey, uri);
    const entry = index.images[key];
    if (!entry?.sidecar) return;
    const side = await readJson<ImageSidecar>(root, entry.sidecar);
    if (!side) return;
    side.source = source;
    await writeJson(root, entry.sidecar, side);
    index.images[key] = imageEntry(side, entry.sidecar);
    await saveIndex(root, index);
  });
}

/* 검색 자료 */

interface ResearchMeta {
  id: string;
  uri: string;
  kind: ResearchKind;
  query: string;
  createdAt: string;
  postKey: string;
  post: string;
}

const previewOf = (body: string) =>
  body
    .replace(/^#.*\n/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PREVIEW_CHARS);

function researchEntry(meta: ResearchMeta, body: string, path: string): ResearchEntry {
  return {
    path,
    query: meta.query,
    kind: meta.kind,
    createdAt: Date.parse(meta.createdAt) || 0,
    title: meta.post ?? '',
    preview: previewOf(body),
  };
}

/** frontmatter의 값은 JSON 글자로 쓴다 (따옴표·줄바꿈이 섞여도 한 줄). */
function formatResearch(meta: ResearchMeta, content: string): string {
  const front = Object.entries(meta).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${front.join('\n')}\n---\n\n# ${meta.query}\n\n${content.trim()}\n`;
}

function parseResearch(text: string): { meta: ResearchMeta; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return null;
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const raw = line.slice(i + 1).trim();
    try {
      meta[line.slice(0, i).trim()] = JSON.parse(raw);
    } catch {
      meta[line.slice(0, i).trim()] = raw;
    }
  }
  return { meta: meta as unknown as ResearchMeta, body: text.slice(m[0].length) };
}

export function storeResearch(root: Root, convKey: string, { query, content, kind }: DocToolArgs['store_research']): Promise<string> {
  return serial(async () => {
    const index = await loadIndex(root);
    const id = newGenImageId(new Set(Object.keys(index.research).map(idOf)));
    const now = Date.now();
    const meta: ResearchMeta = {
      id,
      uri: researchUri(id),
      kind,
      query,
      createdAt: new Date(now).toISOString(),
      postKey: convKey,
      post: index.posts[convKey]?.title ?? '',
    };
    const path = `${RESEARCH}/${ym(now)}/${ymd(now)}_${slug(query, 40) || '검색'}_${id}.md`;
    await writeFile(root, path, formatResearch(meta, content));
    index.research[meta.uri] = researchEntry(meta, content, path);
    await saveIndex(root, index);
    return meta.uri;
  });
}

export interface SavedPromptFile {
  id: string;
  name: string;
  command: string;
  scope: PromptScope;
  post?: string;
  description: string;
  body: string;
  params: PromptParam[];
  createdAt: number;
}

function promptFront(entry: {
  id: string;
  name: string;
  command: string;
  scope: PromptScope;
  post?: string;
  description?: string;
  params: PromptParam[];
}): string {
  const lines = [
    `id: ${JSON.stringify(entry.id)}`,
    `name: ${JSON.stringify(entry.name)}`,
    `command: ${JSON.stringify(entry.command)}`,
    `scope: ${JSON.stringify(entry.scope)}`,
  ];
  if (entry.scope === 'post' && entry.post) lines.push(`post: ${JSON.stringify(entry.post)}`);
  if (entry.description) lines.push(`description: ${JSON.stringify(entry.description)}`);
  lines.push(`params: ${JSON.stringify(entry.params)}`);
  return `---\n${lines.join('\n')}\n---\n\n`;
}

/**
 * 저장 프롬프트를 prompts/{YYYY-MM}/{이름}_{ID}.md 에 쓴다.
 * 결과로 커맨드 이름을 돌려준다. 같은 커맨드가 있으면 ID를 붙인다.
 */
export function storePrompt(
  root: Root,
  convKey: string,
  input: { name: string; command?: string; description?: string; scope: PromptScope; body: string; params?: PromptParam[] },
): Promise<string> {
  return serial(async () => {
    const index = await loadIndex(root);
    index.prompts ??= {};
    const id = newGenImageId(new Set(Object.keys(index.prompts)));
    const now = Date.now();
    const name = input.name.trim() || '새 프롬프트';
    let command = commandNameOf(input.command ?? '') || 'prompt';
    if (RESERVED_PROMPT_COMMANDS.includes(command)) command = 'prompt';
    const taken = new Set(Object.values(index.prompts).map((p) => p.command));
    if (taken.has(command)) command = `${command}-${id}`;
    const params = cleanParams(input.params, input.body);
    const description = input.description?.trim() ?? '';
    const scope = input.scope === 'all' ? 'all' : 'post';
    const path = `${PROMPTS}/${ym(now)}/${slug(name, 40) || '프롬프트'}_${id}.md`;
    await writeFile(
      root,
      path,
      `${promptFront({ id, name, command, scope, post: scope === 'post' ? convKey : undefined, description, params })}${input.body.trim()}\n`,
    );
    index.prompts[id] = {
      path,
      name,
      command,
      scope,
      ...(scope === 'post' ? { post: convKey } : {}),
      ...(description ? { description } : {}),
      params: params.map((p) => p.name),
      createdAt: now,
    };
    await saveIndex(root, index);
    return command;
  });
}

/** 본문에 실제로 있는 칸만, 이름 하나에 하나씩 남긴다. 설명은 빈 글이면 뺀다. */
function cleanParams(params: PromptParam[] | undefined, body: string): PromptParam[] {
  const seen = new Set<string>();
  return (params ?? []).flatMap((p) => {
    const name = p.name.trim();
    if (!name || seen.has(name) || !body.includes(`{{${name}}}`)) return [];
    seen.add(name);
    return [{ name, ...(p.description?.trim() ? { description: p.description.trim() } : {}) }];
  });
}

/** 저장 프롬프트를 고쳐 쓴다. 파일 자리와 ID는 그대로 두고, 커맨드가 겹치면 ID를 붙인다. */
export function updatePrompt(
  root: Root,
  convKey: string,
  id: string,
  input: { name: string; command: string; description?: string; scope: PromptScope; body: string; params?: PromptParam[] },
): Promise<string> {
  return serial(async () => {
    const index = await loadIndex(root);
    const entry = index.prompts?.[id];
    if (!entry) throw new Error('고칠 프롬프트를 찾지 못했습니다.');
    const name = input.name.trim() || entry.name;
    let command = commandNameOf(input.command) || entry.command;
    if (RESERVED_PROMPT_COMMANDS.includes(command)) command = entry.command;
    const taken = new Set(Object.entries(index.prompts ?? {}).flatMap(([k, p]) => (k === id ? [] : [p.command])));
    if (taken.has(command)) command = `${command}-${id}`;
    const params = cleanParams(input.params, input.body);
    const description = input.description?.trim() ?? '';
    const scope = input.scope === 'all' ? 'all' : 'post';
    const post = scope === 'post' ? (entry.post ?? convKey) : undefined;
    await writeFile(root, entry.path, `${promptFront({ id, name, command, scope, post, description, params })}${input.body.trim()}\n`);
    const { post: _old, description: _d, ...rest } = entry;
    index.prompts![id] = {
      ...rest,
      name,
      command,
      scope,
      ...(post ? { post } : {}),
      ...(description ? { description } : {}),
      params: params.map((p) => p.name),
    };
    await saveIndex(root, index);
    return command;
  });
}

/** 저장 프롬프트를 지운다. */
export function deletePrompt(root: Root, id: string): Promise<void> {
  return serial(async () => {
    const index = await loadIndex(root);
    const entry = index.prompts?.[id];
    if (!entry) return;
    await removeEntry(root, entry.path).catch(() => undefined);
    delete index.prompts![id];
    await saveIndex(root, index);
  });
}

/** 이 글과 모든 글 프롬프트. 기본 커맨드는 여기 없다. */
export async function listPrompts(root: Root, convKey: string): Promise<SavedPromptFile[]> {
  const index = await loadIndex(root);
  return Object.entries(index.prompts ?? {})
    .filter(([, p]) => p.scope === 'all' || p.post === convKey)
    .map(([id, p]) => ({
      id,
      name: p.name,
      command: p.command,
      scope: p.scope,
      post: p.post,
      description: p.description ?? '',
      body: '',
      params: (p.params ?? []).map((name) => ({ name })),
      createdAt: p.createdAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function paramsOf(value: unknown): PromptParam[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const name = (item as { name?: unknown }).name;
    const description = (item as { description?: unknown }).description;
    if (typeof name !== 'string' || !name.trim()) return [];
    return [{ name: name.trim(), ...(typeof description === 'string' && description.trim() ? { description: description.trim() } : {}) }];
  });
}

/** 커맨드 이름으로 이 글 또는 모든 글 프롬프트를 읽는다. */
export async function findPrompt(root: Root, convKey: string, command: string): Promise<SavedPromptFile | null> {
  const index = await loadIndex(root);
  const key = command.toLowerCase();
  const found = Object.entries(index.prompts ?? {}).find(
    ([, entry]) => entry.command.toLowerCase() === key && (entry.scope === 'all' || entry.post === convKey),
  );
  if (!found) return null;
  const [id, entry] = found;
  const file = await readFile(root, entry.path);
  if (!file) return null;
  const text = await file.text();
  const meta = frontmatter(text);
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  return {
    id,
    name: entry.name,
    command: entry.command,
    scope: entry.scope,
    post: entry.post,
    description: typeof meta.description === 'string' ? meta.description : (entry.description ?? ''),
    body,
    params: paramsOf(meta.params),
    createdAt: entry.createdAt,
  };
}

const RESEARCH_MAX_CHARS = 8000;

export async function readResearch(root: Root, uri: string): Promise<string> {
  const entry = (await loadIndex(root)).research[uri];
  const file = entry && (await readFile(root, entry.path));
  if (!file) throw new Error(`${uri}: 라이브러리에 없는 검색 자료입니다.`);
  const text = await file.text();
  const body = parseResearch(text)?.body ?? text;
  return body.length > RESEARCH_MAX_CHARS ? `${body.slice(0, RESEARCH_MAX_CHARS)}\n…(뒷부분 생략)` : body;
}

/* 라이브러리 목록 · 찾기 */

/** 보관함 UI·검색용 이미지 한 줄 */
export interface LibraryImageItem {
  uri: string;
  kind: ImageMeta['kind'];
  name?: string;
  caption?: string;
  instruction?: string;
  ai: boolean;
  htmlUri?: string;
  title?: string;
  createdAt: number;
}

/** 작업공간 이미지 (최근순). lib/images·gen 모두. 같은 URI는 하나. */
export async function listLibraryImages(root: Root): Promise<LibraryImageItem[]> {
  await syncIfStale(root);
  const index = await loadIndex(root);
  const byUri = new Map<string, LibraryImageItem>();
  for (const [key, e] of Object.entries(index.images)) {
    const uri = key.includes('|') ? key.slice(key.indexOf('|') + 1) : key;
    if (parseUri(uri)?.kind !== 'gen') continue;
    const prev = byUri.get(uri);
    if (prev && prev.createdAt >= e.createdAt) continue;
    byUri.set(uri, {
      uri,
      kind: e.kind,
      name: e.name,
      caption: e.caption,
      instruction: e.instruction,
      ai: e.ai,
      htmlUri: e.htmlUri,
      title: e.title,
      createdAt: e.createdAt,
    });
  }
  return [...byUri.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** 보관함 UI용 검색 자료 한 줄 */
export interface LibraryResearchItem {
  uri: string;
  kind: ResearchEntryKind;
  query: string;
  title?: string;
  preview: string;
  createdAt: number;
}

/** 작업공간 검색 자료 (최근순) */
export async function listLibraryResearch(root: Root): Promise<LibraryResearchItem[]> {
  await syncIfStale(root);
  const index = await loadIndex(root);
  return Object.entries(index.research)
    .map(([uri, e]) => ({
      uri,
      kind: e.kind,
      query: e.query,
      title: e.title || undefined,
      preview: e.preview,
      createdAt: e.createdAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

const KIND_LABEL: Record<ImageMeta['kind'], string> = {
  generated: 'AI 생성',
  edited: '고친 이미지',
  diagram: '설명 그림',
  web: '웹 이미지',
  attached: '첨부한 이미지',
  added: '사용자가 넣은 이미지',
  original: '글의 원본 이미지',
};
const RESEARCH_LABEL: Record<ResearchEntryKind, string> = { web_search: '웹 검색', fact_check: '사실 확인', added: '사용자 자료' };
const SEARCH_LIMIT = 10;
const FIELD_CHARS = 60;

const clip = (s: string | undefined, n = FIELD_CHARS) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export interface LibraryHits {
  text: string;
  /** 찾은 라이브러리 이미지 (글에 넣을 때 캡션과 AI 표시를 알아야 한다) */
  images: { uri: string; caption?: string; ai: boolean }[];
}

/** 낱말이 많이 들어간 것부터, 같으면 최근 것부터 */
export async function searchLibrary(root: Root, { query, kind, limit = SEARCH_LIMIT }: DocToolArgs['search_library']): Promise<LibraryHits> {
  await syncIfStale(root);
  const index = await loadIndex(root);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const score = (hay: string) => terms.filter((t) => hay.includes(t)).length;
  type Hit = { score: number; at: number; line: string; image?: LibraryHits['images'][number] };
  const hits: Hit[] = [];

  if (kind !== 'research') {
    for (const [key, e] of Object.entries(index.images)) {
      if (parseUri(key)?.kind !== 'gen') continue;
      const s = score([e.name, e.caption, e.instruction, e.title, baseName(e.path), KIND_LABEL[e.kind]].join('\n').toLowerCase());
      if (!s) continue;
      const parts = [
        e.name && `이름: ${clip(e.name)}`,
        e.caption && `캡션: ${clip(e.caption)}`,
        e.instruction && `내용: ${clip(e.instruction)}`,
        e.title && `만든 글: ${clip(e.title, 30)}`,
        ymd(e.createdAt),
      ].filter(Boolean);
      hits.push({ score: s, at: e.createdAt, line: `- ${key} [${KIND_LABEL[e.kind]}] ${parts.join(' · ')}`, image: { uri: key, caption: e.caption, ai: e.ai } });
    }
  }
  if (kind !== 'image') {
    for (const [uri, e] of Object.entries(index.research)) {
      const s = score([e.query, e.preview, e.title, baseName(e.path)].join('\n').toLowerCase());
      if (!s) continue;
      const parts = [`질문: ${clip(e.query)}`, e.title && `글: ${clip(e.title, 30)}`, ymd(e.createdAt), clip(e.preview, 80)].filter(Boolean);
      hits.push({ score: s, at: e.createdAt, line: `- ${uri} [${RESEARCH_LABEL[e.kind]}] ${parts.join(' · ')}` });
    }
  }

  const top = hits.sort((a, b) => b.score - a.score || b.at - a.at).slice(0, Math.min(limit, 30));
  if (!top.length) return { text: `라이브러리에서 "${query}"에 맞는 것을 찾지 못했다.`, images: [] };
  return {
    text: `라이브러리에서 찾은 것 (${top.length}개${hits.length > top.length ? `, 전체 ${hits.length}개 중` : ''}):\n${top.map((h) => h.line).join('\n')}`,
    images: top.flatMap((h) => (h.image ? [h.image] : [])),
  };
}
