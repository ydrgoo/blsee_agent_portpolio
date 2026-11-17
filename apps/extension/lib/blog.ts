import { listConversations } from './conversations';
import type { ContentRequest, ContentResponse } from './messages';

/**
 * 내 블로그의 카테고리와 글 목록. 모바일 블로그 API를 블로그 탭의 콘텐츠 스크립트로 불러
 * 이 PC(chrome.storage.local)에 둔다. 네이버에서 언제든 다시 받을 수 있는 목록이라 작업공간에는 두지 않는다.
 */

/** 블로그 카테고리. 2단계까지만 있다 (parent가 있으면 2차 카테고리). */
export interface BlogCategory {
  no: number;
  name: string;
  parent: number | null;
  open: boolean;
  /** 글 수 (네이버가 센 값) */
  count: number;
  /** 목록 사이 구분선 (글이 없다) */
  divider: boolean;
}

export type PostOpen = 'all' | 'buddy' | 'both' | 'private';

export interface BlogPost {
  logNo: string;
  title: string;
  category: number;
  /** 발행 시각 (ms) */
  date: number;
  open: PostOpen;
  /** 열려다 지운 글로 확인됨 (다음 전체 동기화 때 목록에서 빠진다) */
  deleted?: boolean;
}

export interface BlogIndex {
  blogId: string;
  categories: BlogCategory[];
  /** 최신 글부터 */
  posts: BlogPost[];
  syncedAt: number;
  /** 전체 목록을 끝까지 받았다 (중간에 멈췄으면 false) */
  complete: boolean;
  /**
   * 끝까지 받았을 때 카테고리별(전체는 'all') 네이버 글 수 − 받은 글 수.
   * 비공개 글 등으로 원래 맞지 않는 차이를 기억해 두고, 이 차이가 달라지면 예전 글이 옮겨지거나 지워진 것이다.
   */
  gaps?: Record<string, number>;
}

export const OPEN_LABEL: Record<PostOpen, string> = { all: '전체공개', buddy: '이웃공개', both: '서로이웃공개', private: '비공개' };

const KEY = 'blog-index';
/** 모바일 API가 한 번에 주는 최대 글 수 */
const PAGE_SIZE = 30;
/** 네이버에 부담을 주지 않도록 페이지 사이에 쉬는 시간 */
const PAGE_GAP_MS = 250;

export async function loadBlogIndex(): Promise<BlogIndex | null> {
  return ((await browser.storage.local.get(KEY))[KEY] as BlogIndex | undefined) ?? null;
}

async function saveBlogIndex(index: BlogIndex): Promise<void> {
  await browser.storage.local.set({ [KEY]: index });
}

/** 블로그 탭(지금 창의 활성 탭을 먼저)의 맨 위 프레임 콘텐츠 스크립트에 보낸다. */
async function sendToBlogTab<T>(req: ContentRequest): Promise<T> {
  const tabs = await browser.tabs.query({ url: 'https://blog.naver.com/*' });
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  const ordered = [...tabs].sort((a, b) => Number(b.id === active?.id) - Number(a.id === active?.id));
  for (const tab of ordered) {
    if (tab.id === undefined) continue;
    let res: ContentResponse<T> | undefined;
    try {
      res = await browser.tabs.sendMessage(tab.id, req, { frameId: 0 });
    } catch {
      continue;
    }
    if (!res) continue;
    if (!res.ok) throw new Error(res.error);
    return res.result;
  }
  throw new Error('열린 네이버 블로그 탭이 없습니다. 블로그 글쓰기 화면을 연 상태에서 다시 시도해 주세요.');
}

interface RawCategory {
  categoryNo: number;
  categoryName: string;
  parentCategoryNo: number | null;
  openYN: boolean;
  postCnt: number;
  divisionLine: boolean;
}

interface RawPost {
  logNo: number | string;
  titleWithInspectMessage: string;
  categoryNo: number;
  addDate: number;
  allOpenPost?: boolean;
  buddyOpen?: boolean;
  bothBuddyOpen?: boolean;
  notOpen?: boolean;
}

const openOf = (p: RawPost): PostOpen =>
  p.allOpenPost ? 'all' : p.bothBuddyOpen ? 'both' : p.buddyOpen ? 'buddy' : p.notOpen ? 'private' : 'all';

const toPost = (p: RawPost): BlogPost => ({
  logNo: String(p.logNo),
  title: p.titleWithInspectMessage || '제목 없음',
  category: p.categoryNo,
  date: p.addDate,
  open: openOf(p),
});

async function fetchCategories(blogId: string): Promise<{ categories: BlogCategory[]; total: number }> {
  const r = await sendToBlogTab<{ mylogCategoryList?: RawCategory[]; mylogPostCount?: number }>({
    type: 'blog-api',
    path: `blogs/${encodeURIComponent(blogId)}/category-list`,
  });
  const categories = (r.mylogCategoryList ?? []).map((c) => ({
    no: c.categoryNo,
    name: c.categoryName,
    parent: c.parentCategoryNo,
    open: c.openYN,
    count: c.postCnt,
    divider: c.divisionLine,
  }));
  return { categories, total: r.mylogPostCount ?? 0 };
}

async function fetchPostPage(blogId: string, page: number): Promise<BlogPost[]> {
  const r = await sendToBlogTab<{ items?: RawPost[] }>({
    type: 'blog-api',
    path: `blogs/${encodeURIComponent(blogId)}/post-list?categoryNo=0&itemCount=${PAGE_SIZE}&page=${page}`,
  });
  return (r.items ?? []).map(toPost);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SyncProgress {
  done: number;
  /** 네이버가 센 전체 글 수 (모르면 0) */
  total: number;
}

/**
 * 카테고리와 글 목록을 받아 저장한다.
 * full이 아니면 최신 글부터 받다가 이미 아는 글이 나오는 페이지에서 멈춘다.
 * 카테고리별 글 수로 예전 글이 옮겨진 걸 알아채면 끝까지 이어서 받는다 (예전 글의 제목만 바꾼 건 모른다).
 * 지운 글은 여기서 빼지 않고, 열려고 할 때 확인해 표시한다 (openPost).
 * 블로그가 바뀌었거나 전체 목록을 다 받은 적이 없으면 full로 한다.
 */
export async function syncBlog(
  opts: {
    full?: boolean;
    onProgress?: (p: SyncProgress) => void;
    /** 페이지를 받을 때마다 지금까지 받은 목록 (아직 못 받은 뒤쪽은 저장돼 있던 글로 채운다) */
    onPartial?: (index: BlogIndex) => void;
    signal?: AbortSignal;
  } = {},
): Promise<BlogIndex> {
  const blogId = await sendToBlogTab<string>({ type: 'my-blog-id' });
  const prev = await loadBlogIndex();
  const same = prev?.blogId === blogId ? prev : null;
  let full = opts.full || !same?.complete;
  const { categories, total } = await fetchCategories(blogId);

  const known = new Map((same?.posts ?? []).map((p) => [p.logNo, p]));
  const fetched: BlogPost[] = [];
  // 받은 글은 새 값으로 바꾸고, 받지 못한 뒤쪽 글은 그대로 둔다.
  const merged = (): BlogPost[] => {
    const got = new Set(fetched.map((p) => p.logNo));
    return [...fetched, ...(same?.posts ?? []).filter((p) => !got.has(p.logNo))].sort((a, b) => b.date - a.date);
  };
  let gaps = same?.gaps;
  const indexOf = (posts: BlogPost[], complete: boolean): BlogIndex => ({
    blogId,
    categories,
    posts,
    syncedAt: Date.now(),
    complete,
    gaps,
  });

  let complete = true;
  for (let page = 1; ; page++) {
    if (opts.signal?.aborted) {
      complete = false;
      break;
    }
    const items = await fetchPostPage(blogId, page);
    fetched.push(...items);
    opts.onProgress?.({ done: fetched.length, total });
    if (items.length < PAGE_SIZE) {
      full = true;
      break;
    }
    // 전체 글 목록은 최신순이라, 이미 아는 글이 나오면 그 뒤는 모두 아는 글이다.
    // 다만 전체 글 수 차이는 그대로인데 카테고리별 차이가 달라졌으면 예전 글이 옮겨진 것이니 끝까지 이어서 받는다.
    // 전체 글 수 차이가 달라졌으면 글이 지워진 것인데, 지운 글은 열려고 할 때 표시하므로 기준만 옮긴다.
    if (!full && items.some((p) => known.has(p.logNo))) {
      const now = gapsOf(categories, total, merged());
      if (gaps && now.all !== gaps.all) {
        gaps = now;
        break;
      }
      if (!gapsChanged(gaps, now)) break;
      full = true;
    }
    opts.onPartial?.(indexOf(merged(), same?.complete ?? false));
    await sleep(PAGE_GAP_MS);
  }

  let index: BlogIndex;
  if (full && complete) {
    index = { ...indexOf(fetched, true), gaps: gapsOf(categories, total, fetched) };
  } else {
    index = indexOf(merged(), full ? false : (same?.complete ?? false));
  }
  await saveBlogIndex(index);
  return index;
}

function gapsOf(categories: BlogCategory[], total: number, posts: BlogPost[]): Record<string, number> {
  const ours = new Map<number, number>();
  for (const p of posts) ours.set(p.category, (ours.get(p.category) ?? 0) + 1);
  const gaps: Record<string, number> = { all: total - posts.length };
  for (const c of categories) if (!c.divider) gaps[c.no] = c.count - (ours.get(c.no) ?? 0);
  return gaps;
}

function gapsChanged(before: Record<string, number> | undefined, now: Record<string, number>): boolean {
  if (!before) return false;
  return Object.keys(now).some((k) => (before[k] ?? 0) !== now[k]);
}

export const postUrl = (blogId: string, logNo: string) => `https://blog.naver.com/${blogId}/${logNo}`;

/** 글쓰기·수정 화면 주소 */
export const isWriteUrl = (url: string) => /postwrite|PostWriteForm|PostUpdateForm|Redirect=Write|Redirect=Update/i.test(url);

/**
 * 지금 탭이 글 보기 화면이고 그 글의 대화가 있으면 그 대화.
 * 주소가 같으면 대화 목록을 다시 읽지 않는다 (사이드 패널이 몇 초마다 묻는다).
 */
let viewedCache: { url: string; found: ViewedPost | null } | null = null;

export interface ViewedPost {
  url: string;
  logNo: string;
  /** 그 글의 대화 (없으면 undefined) */
  convKey?: string;
  title?: string;
}

export async function findViewedPost(): Promise<ViewedPost | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url;
  if (!url || isWriteUrl(url)) return null;
  if (viewedCache?.url === url) return viewedCache.found;
  const ref = postRefOf(url);
  let found: ViewedPost | null = null;
  if (ref) {
    const conv = (await listConversations()).find((c) => c.url && postRefOf(c.url)?.logNo === ref.logNo);
    found = { url, logNo: ref.logNo, convKey: conv?.key, title: conv?.title };
  }
  viewedCache = { url, found };
  return found;
}

/** 대화가 새로 생기거나 지워졌을 때 다시 찾게 한다. */
export function forgetViewedPost(): void {
  viewedCache = null;
}

/** 글 주소에서 블로그 ID와 글 번호 (글 보기, 글쓰기·수정 화면 주소 모두) */
export function postRefOf(url: string): { blogId?: string; logNo: string } | null {
  try {
    const u = new URL(url);
    if (u.hostname !== 'blog.naver.com' && u.hostname !== 'm.blog.naver.com') return null;
    const q = u.searchParams.get('logNo');
    if (q) return { blogId: u.searchParams.get('blogId') ?? undefined, logNo: q };
    const [blogId, logNo] = u.pathname.split('/').filter(Boolean);
    return logNo && /^\d+$/.test(logNo) ? { blogId, logNo } : null;
  } catch {
    return null;
  }
}

/**
 * 글 보기 화면을 연다. 쓰던 글이 날아가지 않게 지금 탭은 두고, 그 글을 보고 있는 탭이 있으면 그리로 옮겨 가고 없으면 새 탭으로 연다.
 * 새 탭을 열기 전에 지운 글인지 확인해, 지운 글이면 열지 않고 목록에 표시해 둔다.
 */
export async function openPost(blogId: string, logNo: string): Promise<'opened' | 'deleted'> {
  const tabs = await browser.tabs.query({ url: ['https://blog.naver.com/*', 'https://m.blog.naver.com/*'] });
  const open = tabs.find((t) => {
    if (!t.url || isWriteUrl(t.url)) return false;
    const ref = postRefOf(t.url);
    return ref?.logNo === logNo && (!ref.blogId || ref.blogId === blogId);
  });
  if (open?.id !== undefined) {
    await browser.tabs.update(open.id, { active: true });
    if (open.windowId !== undefined) await browser.windows.update(open.windowId, { focused: true });
    return 'opened';
  }
  const exists = await sendToBlogTab<boolean>({ type: 'post-exists', blogId, logNo }).catch(() => true);
  await markDeleted(blogId, logNo, !exists);
  if (!exists) return 'deleted';
  await browser.tabs.create({ url: postUrl(blogId, logNo) });
  return 'opened';
}

async function markDeleted(blogId: string, logNo: string, deleted: boolean): Promise<void> {
  const index = await loadBlogIndex();
  const post = index?.blogId === blogId ? index.posts.find((p) => p.logNo === logNo) : undefined;
  if (!index || !post || !!post.deleted === deleted) return;
  if (deleted) post.deleted = true;
  else delete post.deleted;
  await saveBlogIndex(index);
}
