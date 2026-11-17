import {
  findBlockImage,
  parseImageUri,
  PENDING_IMAGE_KEY,
  type BlockRefs,
  type SeDocumentData,
} from '@blog-helper/se-model';
import type { ImageInput } from '@blog-helper/shared';
import { getImage } from './image-store';

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** 이미지 내용 해시 (SHA-256 앞 16자 hex). lib 중복 보관·추적에 쓴다. */
export async function blobHash(blob: Blob): Promise<string> {
  const dig = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export async function blobToImageInput(blob: Blob): Promise<ImageInput> {
  const dataUrl = await blobToDataUrl(blob);
  return { mimeType: blob.type || 'image/png', data: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}

/** 긴 변이 maxSide를 넘으면 비율을 지켜 줄인다. 작거나 읽을 수 없으면 그대로 돌려준다. */
export async function shrinkBlob(blob: Blob, maxSide: number): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return blob;
  }
  const scale = maxSide / Math.max(bitmap.width, bitmap.height);
  if (!(scale < 1)) {
    bitmap.close();
    return blob;
  }
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // 투명할 수 있는 PNG·WebP·GIF는 PNG로, 나머지는 JPEG로 둔다.
  const type = /png|webp|gif/.test(blob.type) ? 'image/png' : 'image/jpeg';
  return canvas.convertToBlob(type === 'image/jpeg' ? { type, quality: 0.9 } : { type });
}

export async function imageInputToBlob(img: ImageInput): Promise<Blob> {
  const mime = img.mimeType?.startsWith('image/') ? img.mimeType : 'image/png';
  const blob = await (await fetch(`data:${mime};base64,${img.data}`)).blob();
  return blob.type === mime ? blob : new Blob([blob], { type: mime });
}

/**
 * 네이버 이미지 서버(pstatic)에서 받는다. 원본은 수 MB일 수 있어 큰 사본(w966)을 먼저 시도한다.
 * 확장 페이지에서 쿠키 없이 받으면 막히지 않는 것을 확인했다.
 */
export async function fetchPstatic(src: string, size: 'w80' | 'w773' | 'w966' = 'w966'): Promise<Blob | null> {
  const bare = src.split('?')[0];
  for (const url of [`${bare}?type=${size}`, bare, src]) {
    try {
      const res = await fetch(url, { credentials: 'omit' });
      const blob = await res.blob();
      if (res.ok && blob.type.startsWith('image/')) return blob;
    } catch {
      // 다음 주소로
    }
  }
  return null;
}

/** 이미지 URI(blsee://…)를 실제 이미지로 바꾼다. 블록 이미지는 네이버에서, 만든 이미지는 이 PC 저장소에서 가져온다. */
export async function resolveImageUri(
  uri: string,
  ctx: { doc: SeDocumentData; refs: BlockRefs; convKey: string },
): Promise<Blob> {
  const parsed = parseImageUri(uri);
  if (!parsed) throw new Error(`${uri}: 이미지 URI가 아닙니다.`);
  if (parsed.kind === 'gen') {
    const blob = await getImage(ctx.convKey, uri);
    if (!blob) throw new Error(`${uri}: 이미지를 찾지 못했습니다.`);
    return blob;
  }
  const img = findBlockImage(ctx.doc, ctx.refs, parsed);
  const pending = img[PENDING_IMAGE_KEY];
  if (typeof pending === 'string') return resolveImageUri(pending, ctx);
  if (typeof img.src !== 'string') throw new Error(`${uri}: 이미지 주소가 없습니다.`);
  const blob = await fetchPstatic(img.src);
  if (!blob) throw new Error(`${uri}: 이미지를 받지 못했습니다.`);
  return blob;
}

const thumbCache = new Map<string, Promise<string | null>>();

/** 칩에 넣을 작은 미리보기 주소 (object URL). 같은 이미지는 한 번만 받는다. */
export function thumbnailUrl(key: string, load: () => Promise<Blob | null>): Promise<string | null> {
  let p = thumbCache.get(key);
  if (!p) {
    p = load()
      .then((b) => (b ? URL.createObjectURL(b) : null))
      .catch(() => null);
    thumbCache.set(key, p);
  }
  return p;
}
