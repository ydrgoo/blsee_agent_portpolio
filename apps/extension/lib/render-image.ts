import { GEN_URI_SRC, imageSources, renderHtml, type SeDocumentData } from '@blog-helper/se-model';
import { blobToDataUrl, fetchPstatic } from './images';

/** 그림 한 장의 최대 높이. 더 길면 여러 장으로 나눈다 (아주 긴 그림은 보는 모델이 잘게 쪼개 비용이 커진다). */
const MAX_CHUNK_HEIGHT = 2400;

export interface RenderedBlocks {
  html: string;
  /** 위에서부터 나눈 그림들 */
  pngs: Blob[];
  width: number;
  height: number;
  missingImages: number;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('그림을 이미지로 바꾸지 못했습니다.'));
    img.src = url;
  });
}

async function toDataUrl(blob: Blob | null): Promise<string | null> {
  return blob ? blobToDataUrl(blob) : null;
}

/**
 * 문서 데이터의 from~to 블록(위치, 0번은 제목)을 HTML로 그리고 PNG로 만든다.
 * SVG foreignObject로 그리므로 외부 이미지는 미리 data URL로 바꿔 넣어야 한다.
 */
export async function renderBlocks(
  doc: SeDocumentData,
  from: number,
  to: number,
  resolvePending?: (uri: string) => Promise<Blob | null>,
): Promise<RenderedBlocks> {
  const srcs = imageSources(doc, from, to);
  const pendingUris = [
    ...new Set(
      JSON.stringify(doc.document.components.slice(from, to + 1)).match(new RegExp(`${GEN_URI_SRC}|img://gen/\\d+`, 'g')) ?? [],
    ),
  ];
  const [dataUrls, pendingUrls] = await Promise.all([
    Promise.all(srcs.map(async (s) => [s, await toDataUrl(await fetchPstatic(s, 'w773'))] as const)).then(
      (e) => new Map(e),
    ),
    Promise.all(
      pendingUris.map(async (u) => [u, await toDataUrl((await resolvePending?.(u)) ?? null)] as const),
    ).then((e) => new Map(e)),
  ]);
  const html = renderHtml(doc, from, to, {
    imageSrc: (s) => dataUrls.get(s) ?? null,
    pendingSrc: (u) => pendingUrls.get(u) ?? null,
  });

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-99999px;top:0';
  host.innerHTML = html;
  document.body.append(host);
  const root = host.firstElementChild as HTMLElement;
  await Promise.all([...root.querySelectorAll('img')].map((img) => img.decode().catch(() => {})));
  const width = Math.ceil(root.offsetWidth);
  const height = Math.ceil(root.offsetHeight);
  const xhtml = new XMLSerializer().serializeToString(root);
  host.remove();

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);

  const pngs: Blob[] = [];
  for (let top = 0; top < height; top += MAX_CHUNK_HEIGHT) {
    const h = Math.min(MAX_CHUNK_HEIGHT, height - top);
    const canvas = new OffscreenCanvas(width, h);
    canvas.getContext('2d')!.drawImage(img, 0, top, width, h, 0, 0, width, h);
    pngs.push(await canvas.convertToBlob({ type: 'image/png' }));
  }

  const missing = [...dataUrls.values(), ...pendingUrls.values()].filter((v) => !v).length;
  return { html, pngs, width, height, missingImages: missing };
}
