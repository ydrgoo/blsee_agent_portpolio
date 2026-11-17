import { useEffect, useState } from 'react';
import {
  downloadName,
  getImageInfo,
  IMAGE_KIND_LABEL,
  type ImageInfo,
  type ImageMeta,
} from '@/lib/image-store';

function clipMeta(text: string, n = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function previewDate(ms?: number): string | undefined {
  if (!ms) return undefined;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return undefined;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function shortLibId(uri: string): string {
  const id = uri.slice(uri.lastIndexOf('/') + 1);
  const path = uri.includes('/infographics/') ? 'infographics' : uri.includes('/html/') ? 'html' : 'lib';
  return `lib/${path}/${id}`;
}

/** 보관·채팅 공용 이미지 크게 보기 (메타 · 참조 · 저장) */
export function ImagePreview({
  convKey,
  uri,
  image,
  name,
  onClose,
  onRefer,
}: {
  convKey: string;
  uri: string;
  image: { url: string; blob: Blob };
  /** 이미지 정보에 이름이 없을 때 쓸 이름 */
  name?: string;
  onClose: () => void;
  /** 입력창 커서 위치에 참조 칩으로 넣기 */
  onRefer?: (meta: ImageMeta | null) => void;
}) {
  const [info, setInfo] = useState<ImageInfo | null>(null);

  useEffect(() => {
    getImageInfo(convKey, uri).then(setInfo, () => {});
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [convKey, uri, onClose]);

  const title =
    info?.name?.trim() ||
    name?.trim() ||
    (info?.instruction ? clipMeta(info.instruction, 40) : undefined) ||
    (info?.caption ? clipMeta(info.caption, 40) : undefined) ||
    downloadName(uri, image.blob, undefined);
  const fileName = downloadName(uri, image.blob, info?.name ?? name);
  const isInfo = !!info?.htmlUri;
  const date = previewDate(info?.createdAt);
  const save = () => {
    const a = document.createElement('a');
    a.href = image.url;
    a.download = fileName;
    a.click();
  };

  return (
    <div className="image-preview" onClick={onClose}>
      <div className="image-preview-body" onClick={(e) => e.stopPropagation()}>
        <img src={image.url} alt={title} />
        <div className="image-preview-bar">
          <div className="image-preview-meta">
            <div className="image-preview-badges">
              {isInfo && <span className="image-preview-badge info">인포그래픽</span>}
              {info?.kind && <span className="image-preview-badge">{IMAGE_KIND_LABEL[info.kind]}</span>}
              {info?.ai && <span className="image-preview-badge">AI</span>}
            </div>
            <div className="image-preview-name">{title}</div>
            {info?.caption && (
              <div className="image-preview-line">
                <span className="image-preview-k">캡션</span> {clipMeta(info.caption)}
              </div>
            )}
            {info?.instruction && (
              <div className="image-preview-line">
                <span className="image-preview-k">지시</span> {clipMeta(info.instruction)}
              </div>
            )}
            {isInfo && info.htmlUri && (
              <div className="image-preview-line">
                <span className="image-preview-k">원본</span> {shortLibId(info.htmlUri)}
              </div>
            )}
            {info?.title && (
              <div className="image-preview-line muted">
                <span className="image-preview-k">만든 글</span> {clipMeta(info.title, 40)}
              </div>
            )}
            {date && (
              <div className="image-preview-line muted">
                <span className="image-preview-k">날짜</span> {date}
              </div>
            )}
          </div>
          {onRefer && (
            <button
              className="primary"
              onClick={() => onRefer(info)}
              title="입력창 커서 위치에 이 이미지를 참조로 넣습니다"
            >
              참조
            </button>
          )}
          <button className={onRefer ? undefined : 'primary'} onClick={save}>
            저장
          </button>
          <button onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}
