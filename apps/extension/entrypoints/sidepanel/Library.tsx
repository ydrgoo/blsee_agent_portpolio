import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDate } from '@/lib/conversations';
import {
  getImage,
  IMAGE_KIND_LABEL,
  listLibraryImages,
  listLibraryResearch,
  readLibraryResearch,
  type ImageMeta,
  type LibraryImageItem,
  type LibraryResearchItem,
} from '@/lib/image-store';
import { thumbnailUrl } from '@/lib/images';
import { ImagePreview } from './ImagePreview';
import { useWorkspaceState } from './Workspace';

type Filter = 'all' | 'image' | 'info' | 'research';

const RESEARCH_LABEL: Record<LibraryResearchItem['kind'], string> = {
  web_search: '웹 검색',
  fact_check: '사실 확인',
  added: '사용자 자료',
};

function itemTitle(it: LibraryImageItem): string {
  return (
    it.name?.trim() ||
    it.instruction?.replace(/\s+/g, ' ').trim().slice(0, 40) ||
    it.caption?.replace(/\s+/g, ' ').trim().slice(0, 40) ||
    '이미지'
  );
}

function matchesImage(it: LibraryImageItem, q: string): boolean {
  if (!q) return true;
  const hay = [it.name, it.caption, it.instruction, it.title, IMAGE_KIND_LABEL[it.kind], it.uri]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

function matchesResearch(it: LibraryResearchItem, q: string): boolean {
  if (!q) return true;
  const hay = [it.query, it.preview, it.title, RESEARCH_LABEL[it.kind], it.uri]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

/** 탐색 서랍의 보관함 탭: 이미지·인포 그리드 · 자료 리스트 */
export function LibraryPanel({
  convKey,
  onRefer,
  onOpenSettings,
}: {
  /** 썸네일·미리보기 로드용 (lib URI는 글 키와 무관) */
  convKey?: string;
  onRefer?: (uri: string, meta: ImageMeta | null, name?: string) => void;
  onOpenSettings: () => void;
}) {
  const [workspace] = useWorkspaceState();
  const [images, setImages] = useState<LibraryImageItem[] | null | undefined>(undefined);
  const [research, setResearch] = useState<LibraryResearchItem[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [preview, setPreview] = useState<{
    uri: string;
    name?: string;
    image: { url: string; blob: Blob };
  } | null>(null);
  const [researchPreview, setResearchPreview] = useState<{
    uri: string;
    query: string;
    kind: string;
    body: string;
  } | null>(null);

  const key = convKey ?? '';

  const reload = useCallback(() => {
    Promise.all([listLibraryImages(), listLibraryResearch()]).then(
      ([imgs, res]) => {
        setImages(imgs);
        setResearch(res ?? []);
        setError('');
      },
      (err) => {
        setImages([]);
        setResearch([]);
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  }, []);

  useEffect(() => {
    setImages(undefined);
    reload();
  }, [workspace?.kind, reload]);

  const filteredImages = useMemo(() => {
    if (!images || filter === 'research') return [];
    const q = query.trim().toLowerCase();
    return images.filter((it) => {
      if (filter === 'info' && !it.htmlUri) return false;
      if (filter === 'image' && it.htmlUri) return false;
      return matchesImage(it, q);
    });
  }, [images, query, filter]);

  const filteredResearch = useMemo(() => {
    if (filter !== 'research' && filter !== 'all') return [];
    const q = query.trim().toLowerCase();
    return research.filter((it) => matchesResearch(it, q));
  }, [research, query, filter]);

  if (workspace?.kind !== 'ready') {
    return (
      <div className="drawer-list">
        <p className="empty-hint">
          작업공간 폴더를 정하면 만든 이미지·인포그래픽·검색 자료가 여기에 모여요.
        </p>
        <div className="drawer-search">
          <button className="primary" style={{ width: '100%' }} onClick={onOpenSettings}>
            작업공간 설정
          </button>
        </div>
      </div>
    );
  }

  if (images === undefined) {
    return (
      <div className="drawer-list">
        <p className="empty-hint">불러오는 중…</p>
      </div>
    );
  }

  if (images === null) {
    return (
      <div className="drawer-list">
        <p className="empty-hint">작업공간이 없어요. 설정에서 폴더를 정해 주세요.</p>
        <div className="drawer-search">
          <button className="primary" style={{ width: '100%' }} onClick={onOpenSettings}>
            작업공간 설정
          </button>
        </div>
      </div>
    );
  }

  const showResearch = filter === 'research' || filter === 'all';
  const showImages = filter !== 'research';
  const emptyImages = showImages && filteredImages.length === 0;
  const emptyResearch = showResearch && filteredResearch.length === 0;
  const totallyEmpty =
    (filter === 'research' && research.length === 0) ||
    (filter !== 'research' && filter !== 'all' && images.length === 0) ||
    (filter === 'all' && images.length === 0 && research.length === 0);

  return (
    <>
      {error && <p className="empty-hint error">{error}</p>}
      <div className="drawer-search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={filter === 'research' ? '질문 · 내용으로 검색' : '이름 · 캡션 · 지시 · 질문으로 검색'}
          aria-label="보관함 검색"
        />
      </div>
      <div className="lib-filters" role="tablist" aria-label="종류">
        {(
          [
            ['all', '전체'],
            ['image', '이미지'],
            ['info', '인포'],
            ['research', '자료'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            className={filter === id ? 'on' : ''}
            aria-selected={filter === id}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="drawer-list">
        {totallyEmpty ? (
          <p className="empty-hint">
            {filter === 'research' ? '아직 보관한 검색 자료가 없어요.' : '아직 보관한 것이 없어요.'}
          </p>
        ) : (
          <>
            {showImages && (
              <>
                {filter === 'all' && filteredImages.length > 0 && (
                  <div className="group-label">이미지 · 인포</div>
                )}
                {emptyImages && filter !== 'all' ? (
                  <p className="empty-hint">
                    {query.trim() ? '검색과 맞는 이미지가 없어요.' : '아직 보관한 이미지가 없어요.'}
                  </p>
                ) : (
                  filteredImages.length > 0 && (
                    <div className="lib-grid">
                      {filteredImages.map((it) => (
                        <LibraryCard
                          key={it.uri}
                          item={it}
                          convKey={key}
                          onOpen={async () => {
                            const blob = await getImage(key, it.uri);
                            if (!blob) {
                              setError('이미지를 이 PC에서 찾지 못했어요.');
                              return;
                            }
                            setPreview({
                              uri: it.uri,
                              name: itemTitle(it),
                              image: { url: URL.createObjectURL(blob), blob },
                            });
                          }}
                        />
                      ))}
                    </div>
                  )
                )}
              </>
            )}
            {showResearch && (
              <>
                {filter === 'all' && filteredResearch.length > 0 && (
                  <div className="group-label">자료</div>
                )}
                {emptyResearch && filter === 'research' ? (
                  <p className="empty-hint">
                    {query.trim() ? '검색과 맞는 자료가 없어요.' : '아직 보관한 검색 자료가 없어요.'}
                  </p>
                ) : (
                  filteredResearch.length > 0 && (
                    <div className="lib-research-list">
                      {filteredResearch.map((it) => (
                        <button
                          key={it.uri}
                          type="button"
                          className="lib-research-item"
                          onClick={async () => {
                            const body = await readLibraryResearch(it.uri);
                            if (body == null) {
                              setError('자료를 이 PC에서 찾지 못했어요.');
                              return;
                            }
                            setResearchPreview({
                              uri: it.uri,
                              query: it.query,
                              kind: RESEARCH_LABEL[it.kind],
                              body,
                            });
                          }}
                        >
                          <div className="lib-research-top">
                            <span className="lib-research-q">{it.query || '자료'}</span>
                            <span className="lib-research-kind">{RESEARCH_LABEL[it.kind]}</span>
                          </div>
                          {it.preview && <div className="lib-research-preview">{it.preview}</div>}
                          <div className="lib-research-meta">
                            {formatDate(it.createdAt)}
                            {it.title ? ` · ${it.title}` : ''}
                          </div>
                        </button>
                      ))}
                    </div>
                  )
                )}
              </>
            )}
            {filter === 'all' && emptyImages && emptyResearch && !totallyEmpty && (
              <p className="empty-hint">검색과 맞는 것이 없어요.</p>
            )}
          </>
        )}
      </div>
      {preview && (
        <ImagePreview
          convKey={key}
          uri={preview.uri}
          image={preview.image}
          name={preview.name}
          onClose={() => {
            URL.revokeObjectURL(preview.image.url);
            setPreview(null);
          }}
          onRefer={
            onRefer
              ? (meta) => {
                  onRefer(preview.uri, meta, preview.name);
                  URL.revokeObjectURL(preview.image.url);
                  setPreview(null);
                }
              : undefined
          }
        />
      )}
      {researchPreview && (
        <ResearchPreview
          item={researchPreview}
          onClose={() => setResearchPreview(null)}
          onRefer={
            onRefer
              ? () => {
                  onRefer(researchPreview.uri, null, researchPreview.query);
                  setResearchPreview(null);
                }
              : undefined
          }
        />
      )}
    </>
  );
}

function LibraryCard({
  item,
  convKey,
  onOpen,
}: {
  item: LibraryImageItem;
  convKey: string;
  onOpen: () => void;
}) {
  const [thumb, setThumb] = useState<string | null>(null);
  const title = itemTitle(item);

  useEffect(() => {
    let cancelled = false;
    thumbnailUrl(`lib-grid|${item.uri}`, () => getImage(convKey, item.uri)).then((url) => {
      if (!cancelled) setThumb(url);
    });
    return () => {
      cancelled = true;
    };
  }, [convKey, item.uri]);

  return (
    <button type="button" className="lib-card" onClick={onOpen} title={title}>
      <div className="lib-card-thumb">
        {thumb ? <img src={thumb} alt="" /> : <span className="lib-card-ph" />}
        {item.htmlUri && <span className="lib-card-badge">인포</span>}
      </div>
      <div className="lib-card-body">
        <div className="lib-card-title">{title}</div>
        <div className="lib-card-meta">
          {IMAGE_KIND_LABEL[item.kind]} · {formatDate(item.createdAt)}
        </div>
      </div>
    </button>
  );
}

function ResearchPreview({
  item,
  onClose,
  onRefer,
}: {
  item: { uri: string; query: string; kind: string; body: string };
  onClose: () => void;
  onRefer?: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="image-preview" onClick={onClose}>
      <div className="lib-research-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="lib-research-sheet-head">
          <span className="image-preview-badge">{item.kind}</span>
          <div className="image-preview-name">{item.query}</div>
        </div>
        <pre className="lib-research-sheet-body">{item.body}</pre>
        <div className="image-preview-bar">
          <div className="image-preview-meta">
            <div className="image-preview-line muted">{item.uri.replace(/^blsee:\/\//, '')}</div>
          </div>
          {onRefer && (
            <button className="primary" onClick={onRefer} title="입력창 커서 위치에 참조로 넣습니다">
              참조
            </button>
          )}
          <button onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}
