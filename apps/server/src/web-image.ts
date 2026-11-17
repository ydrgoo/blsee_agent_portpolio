import { isIP } from 'node:net';
import type { ImageInput } from '@blog-helper/shared';

const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 8 * 1024 * 1024;
/** 이미지 모델과 보는 모델이 받는 형식 */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** 검색 결과 주소라도 내부망은 부르지 않는다. */
function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return false;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  if (isIP(host) === 6) return !(host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80') || host.startsWith('::ffff:'));
  return true;
}

/** 웹 이미지를 받아 모델에 넘길 수 있는 형식으로. 받지 못하면 Error */
export async function fetchWebImage(url: string, referer?: string): Promise<ImageInput> {
  if (!isPublicHttpUrl(url)) throw new Error('받을 수 없는 주소입니다.');
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
    headers: { Accept: 'image/webp,image/png,image/jpeg,image/*;q=0.8', ...(referer ? { Referer: referer } : {}) },
  });
  if (!res.ok) throw new Error(`이미지를 받지 못했습니다 (HTTP ${res.status}).`);
  if (!isPublicHttpUrl(res.url)) throw new Error('받을 수 없는 주소로 넘어갔습니다.');
  const mimeType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(mimeType)) throw new Error(`지원하지 않는 이미지 형식입니다 (${mimeType || '알 수 없음'}).`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('이미지가 너무 큽니다.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('이미지가 너무 큽니다.');
  return { mimeType, data: buf.toString('base64') };
}
