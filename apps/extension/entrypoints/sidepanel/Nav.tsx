import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  loadBlogIndex,
  OPEN_LABEL,
  openPost,
  postRefOf,
  syncBlog,
  type BlogCategory,
  type BlogIndex,
  type BlogPost,
  type SyncProgress,
} from '@/lib/blog';
import type { ImageMeta } from '@/lib/image-store';
import { listConversations } from '@/lib/conversations';
import { HistoryList } from './History';
import { LibraryPanel } from './Library';
import { Icon, IconButton } from './ui';

export type NavTab = 'blog' | 'chats' | 'lib';

/** 서랍을 닫았다 열어도 보던 탭을 유지한다 (사이드 패널을 닫으면 처음으로) */
let lastTab: NavTab = 'blog';

/** 왼쪽 위 메뉴·보관함 버튼으로 여는 탐색 서랍 */
export function NavPanel({
  currentKey,
  currentUrl,
  initialTab,
  onClose,
  onOpenChat,
  onChatDeleted,
  onSettings,
  onDev,
  onReferImage,
}: {
  currentKey?: string;
  /** 편집 중인 글의 주소 (목록에서 그 글을 표시한다) */
  currentUrl?: string;
  /** 열 때 이 탭으로 (헤더 보관함 버튼). 없으면 마지막 탭 */
  initialTab?: NavTab;
  onClose: () => void;
  onOpenChat: (key: string) => void;
  onChatDeleted: (key: string) => void;
  onSettings: () => void;
  /** 개발 빌드에서만 */
  onDev?: () => void;
  /** 보관함 Preview 「참조」 */
  onReferImage?: (uri: string, meta: ImageMeta | null, name?: string) => void;
}) {
  const [tab, setTab] = useState<NavTab>(() => {
    const t = initialTab ?? lastTab;
    lastTab = t;
    return t;
  });
  const pick = (t: NavTab) => {
    lastTab = t;
    setTab(t);
  };

  return (
    <div className="overlay">
      <div className="drawer">
        <header className="header nav-header">
          <div className="nav-tabs" role="tablist">
            <button role="tab" className={tab === 'blog' ? 'on' : ''} onClick={() => pick('blog')}>
              블로그 글
            </button>
            <button role="tab" className={tab === 'chats' ? 'on' : ''} onClick={() => pick('chats')}>
              대화 기록
            </button>
            <button role="tab" className={tab === 'lib' ? 'on' : ''} onClick={() => pick('lib')}>
              보관함
            </button>
          </div>
          <IconButton name="close" label="닫기" onClick={onClose} />
        </header>
        {tab === 'blog' ? (
          <BlogPosts currentLogNo={currentUrl ? postRefOf(currentUrl)?.logNo : undefined} onOpenChat={onOpenChat} />
        ) : tab === 'chats' ? (
          <HistoryList currentKey={currentKey} onOpen={onOpenChat} onDeleted={onChatDeleted} />
        ) : (
          <LibraryPanel
            convKey={currentKey}
            onOpenSettings={onSettings}
            onRefer={
              onReferImage
                ? (uri, meta, name) => {
                    onReferImage(uri, meta, name);
                    onClose();
                  }
                : undefined
            }
          />
        )}
        <div className="drawer-menu">
          <button onClick={onSettings}>
            <Icon name="user" />
            계정 · 사용량
          </button>
          {onDev && (
            <button onClick={onDev}>
              <Icon name="tool" />
              개발자 도구
            </button>
          )}
        </div>
      </div>
      <div className="overlay-dim" onClick={onClose} />
    </div>
  );
}

/** 카테고리를 펼쳤을 때 처음 보여주는 글 수 */
const PAGE = 50;

function BlogPosts({ currentLogNo, onOpenChat }: { currentLogNo?: string; onOpenChat: (key: string) => void }) {
  /** undefined: 저장된 목록을 읽는 중 */
  const [index, setIndex] = useState<BlogIndex | null | undefined>(undefined);
  /** 동기화 중이면 진행 상황 */
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [shown, setShown] = useState<Record<number, number>>({});
  /** 글 번호 → 그 글의 대화 키 */
  const [chats, setChats] = useState<Map<string, string>>(new Map());
  const running = useRef<AbortController | null>(null);
  const currentRow = useRef<HTMLDivElement | null>(null);
  const scrolled = useRef(false);

  const sync = async (full: boolean) => {
    if (running.current) return;
    const ctl = new AbortController();
    running.current = ctl;
    setProgress({ done: 0, total: 0 });
    setError('');
    try {
      const next = await syncBlog({
        full,
        signal: ctl.signal,
        onProgress: (p) => !ctl.signal.aborted && setProgress(p),
        onPartial: (partial) => !ctl.signal.aborted && setIndex(partial),
      });
      if (!ctl.signal.aborted) setIndex(next);
    } catch (err) {
      if (!ctl.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (running.current === ctl) {
        running.current = null;
        setProgress(null);
      }
    }
  };

  useEffect(() => {
    loadBlogIndex().then((saved) => {
      setIndex(saved);
      sync(false);
    });
    listConversations().then(
      (list) => {
        const map = new Map<string, string>();
        for (const c of list) {
          const logNo = c.url ? postRefOf(c.url)?.logNo : undefined;
          if (logNo && !map.has(logNo)) map.set(logNo, c.key);
        }
        setChats(map);
      },
      () => {},
    );
    return () => {
      running.current?.abort();
      running.current = null;
    };
  }, []);

  const tree = useMemo(() => {
    if (!index) return null;
    const byCategory = new Map<number, BlogPost[]>();
    for (const p of index.posts) {
      const list = byCategory.get(p.category);
      if (list) list.push(p);
      else byCategory.set(p.category, [p]);
    }
    const known = new Set(index.categories.map((c) => c.no));
    return {
      tops: index.categories.filter((c) => c.parent === null),
      childrenOf: (no: number) => index.categories.filter((c) => c.parent === no),
      postsOf: (no: number) => byCategory.get(no) ?? [],
      orphans: index.posts.filter((p) => !known.has(p.category)),
      nameOf: new Map(index.categories.map((c) => [c.no, c.name])),
    };
  }, [index]);

  // 편집 중인 글이 든 카테고리를 펼쳐 둔다.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!index || !currentLogNo || revealed.current === currentLogNo) return;
    const post = index.posts.find((p) => p.logNo === currentLogNo);
    if (!post) return;
    revealed.current = currentLogNo;
    const cat = index.categories.find((c) => c.no === post.category);
    setExpanded((prev) => new Set([...prev, post.category, ...(cat?.parent != null ? [cat.parent] : [])]));
    const at = tree?.postsOf(post.category).indexOf(post) ?? -1;
    if (at >= PAGE) setShown((prev) => ({ ...prev, [post.category]: at + 1 }));
  }, [index, currentLogNo]);

  useEffect(() => {
    if (scrolled.current || !currentRow.current) return;
    scrolled.current = true;
    currentRow.current.scrollIntoView({ block: 'center' });
  });

  const toggle = (no: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(no)) next.add(no);
      return next;
    });

  const open = (p: BlogPost) => {
    if (!index) return;
    openPost(index.blogId, p.logNo).then(
      (result) => {
        const deleted = result === 'deleted';
        if (!!p.deleted === deleted) return;
        setIndex((cur) =>
          cur && {
            ...cur,
            posts: cur.posts.map((x) => (x.logNo === p.logNo ? { ...x, deleted: deleted || undefined } : x)),
          },
        );
      },
      (err) => setError(err instanceof Error ? err.message : String(err)),
    );
  };

  const renderPost = (p: BlogPost, depth: number, categoryName?: string) => {
    const isCurrent = p.logNo === currentLogNo;
    const chat = chats.get(p.logNo);
    return (
      <div
        key={p.logNo}
        ref={isCurrent ? currentRow : undefined}
        className={`nav-post depth-${depth} ${isCurrent ? 'current' : ''} ${p.deleted ? 'deleted' : ''}`}
        title={p.deleted ? `${p.title}\n지운 글이에요` : `${p.title}\n새 탭에서 글 보기`}
        onClick={() => open(p)}
      >
        <div className="nav-post-main">
          <div className="nav-post-title">{p.title}</div>
          <div className="nav-post-meta">
            {postDate(p.date)}
            {categoryName && ` · ${categoryName}`}
            {p.deleted ? ' · 지운 글' : p.open !== 'all' && <span className="nav-lock"> · {OPEN_LABEL[p.open]}</span>}
          </div>
        </div>
        {chat && (
          <IconButton
            name="chat"
            label="이 글의 대화 보기"
            onClick={(e) => {
              e.stopPropagation();
              onOpenChat(chat);
            }}
          />
        )}
      </div>
    );
  };

  const renderPosts = (key: number, posts: BlogPost[], depth: number) => {
    const limit = shown[key] ?? PAGE;
    return (
      <>
        {posts.slice(0, limit).map((p) => renderPost(p, depth))}
        {posts.length > limit && (
          <button className={`nav-more depth-${depth}`} onClick={() => setShown((prev) => ({ ...prev, [key]: limit + PAGE * 2 }))}>
            {posts.length - limit}개 더 보기
          </button>
        )}
      </>
    );
  };

  const renderCategory = (c: BlogCategory, depth: number): ReactNode => {
    if (c.divider) return <div key={c.no} className="nav-divider" />;
    const children = depth === 0 && tree ? tree.childrenOf(c.no) : [];
    const own = tree?.postsOf(c.no) ?? [];
    const count = own.length + children.reduce((n, ch) => n + (tree?.postsOf(ch.no).length ?? 0), 0);
    const isOpen = expanded.has(c.no);
    return (
      <div key={c.no}>
        <div className={`nav-category depth-${depth} ${isOpen ? 'open' : ''}`} onClick={() => toggle(c.no)}>
          <Icon name="chevron" />
          <span className="nav-category-name">{c.name}</span>
          {!c.open && <span className="nav-lock">비공개</span>}
          <span className="nav-count">{count}</span>
        </div>
        {isOpen && (
          <>
            {renderPosts(c.no, own, depth + 1)}
            {children.map((ch) => renderCategory(ch, 1))}
            {own.length === 0 && children.length === 0 && <div className={`nav-empty depth-${depth + 1}`}>글이 없어요</div>}
          </>
        )}
      </div>
    );
  };

  const q = query.trim().toLowerCase();
  const found = q && index ? index.posts.filter((p) => p.title.toLowerCase().includes(q)) : null;

  return (
    <>
      {error && <p className="empty-hint error">{error}</p>}
      <div className="drawer-search">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="글 제목 검색" />
      </div>
      <div className="drawer-list">
        {found ? (
          <>
            {found.slice(0, 200).map((p) => renderPost(p, 0, tree?.nameOf.get(p.category)))}
            {found.length === 0 && <p className="empty-hint">검색 결과가 없어요.</p>}
          </>
        ) : tree ? (
          <>
            {tree.tops.map((c) => renderCategory(c, 0))}
            {tree.orphans.length > 0 && (
              <div>
                <div className={`nav-category depth-0 ${expanded.has(-1) ? 'open' : ''}`} onClick={() => toggle(-1)}>
                  <Icon name="chevron" />
                  <span className="nav-category-name">기타</span>
                  <span className="nav-count">{tree.orphans.length}</span>
                </div>
                {expanded.has(-1) && renderPosts(-1, tree.orphans, 1)}
              </div>
            )}
          </>
        ) : (
          index === null &&
          !progress && <p className="empty-hint">블로그 탭을 연 상태에서 새로고침을 누르면 글 목록을 불러와요.</p>
        )}
      </div>
      <div className="drawer-foot nav-foot">
        <span>
          {progress
            ? `글 목록 받는 중 ${progress.done.toLocaleString()}${progress.total ? ` / ${progress.total.toLocaleString()}` : ''}`
            : index
              ? `${index.blogId} · 글 ${index.posts.length.toLocaleString()}개 · ${ago(index.syncedAt)} 동기화${index.complete ? '' : ' (일부)'}`
              : '이 PC에만 저장'}
        </span>
        <IconButton
          name="refresh"
          label={'새 글 받기\nShift+클릭: 전체 다시 받기 (예전 글의 바뀐 제목 반영)'}
          onClick={(e) => sync(e.shiftKey)}
        />
      </div>
    </>
  );
}

function postDate(ms: number): string {
  const d = new Date(ms);
  const md = `${d.getMonth() + 1}.${String(d.getDate()).padStart(2, '0')}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}.${md}`;
}

function ago(ms: number): string {
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}
