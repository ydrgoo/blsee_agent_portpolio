import { isIP } from 'node:net';
import type { ImageInput } from '@blog-helper/shared';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 5 * 1024 * 1024;
const FONT_TYPES = new Set([
  'font/woff2',
  'font/woff',
  'font/ttf',
  'font/otf',
  'font/truetype',
  'font/opentype',
  'application/font-woff2',
  'application/font-woff',
  'application/x-font-ttf',
  'application/x-font-otf',
  'application/octet-stream',
]);

/** 검색·다운로드용 공개 http(s)만. 내부망은 막는다. */
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
    return !(
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (isIP(host) === 6)
    return !(host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80') || host.startsWith('::ffff:'));
  return true;
}

function mimeFromUrl(url: string): string | null {
  const path = url.split('?')[0].toLowerCase();
  if (path.endsWith('.woff2')) return 'font/woff2';
  if (path.endsWith('.woff')) return 'font/woff';
  if (path.endsWith('.ttf')) return 'font/ttf';
  if (path.endsWith('.otf')) return 'font/otf';
  return null;
}

/**
 * 공개 http(s) 글꼴 파일을 받는다. woff2/woff/ttf/otf.
 * 확장 권한 없이 서버가 받아 store_font로 넘긴다.
 */
export async function fetchFont(url: string): Promise<ImageInput> {
  if (!isPublicHttpUrl(url)) throw new Error('받을 수 없는 주소입니다.');
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
    headers: { Accept: 'font/woff2,font/woff,font/ttf,font/otf,*/*;q=0.1' },
  });
  if (!res.ok) throw new Error(`글꼴을 받지 못했습니다 (HTTP ${res.status}).`);
  if (!isPublicHttpUrl(res.url)) throw new Error('받을 수 없는 주소로 넘어갔습니다.');
  const headerType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const byUrl = mimeFromUrl(res.url) ?? mimeFromUrl(url);
  const mimeType = byUrl ?? (FONT_TYPES.has(headerType) && headerType !== 'application/octet-stream' ? headerType : null);
  if (!mimeType) throw new Error(`지원하지 않는 글꼴 형식입니다 (${headerType || '알 수 없음'}). woff2·woff·ttf·otf만 됩니다.`);
  if (!byUrl && headerType && !FONT_TYPES.has(headerType)) {
    throw new Error(`지원하지 않는 글꼴 형식입니다 (${headerType}).`);
  }
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('글꼴이 너무 큽니다.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('글꼴이 너무 큽니다.');
  if (buf.length < 16) throw new Error('글꼴 파일이 비정상적으로 작습니다.');
  return { mimeType, data: buf.toString('base64') };
}

export function fontSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const MAX_WEB_FONT_FAMILIES = 6;
/** Google Fonts CSS가 woff2를 주도록 브라우저 UA를 쓴다. */
const FONT_CSS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export type WebFontFile = { family: string; name: string; url: string; weight: number; style: string };

/** HTML에 외부 웹 글꼴(@import / @font-face url)이 있는지 */
export function hasWebFontDirectives(html: string): boolean {
  return /@import\b/i.test(html) || /@font-face\b/i.test(html);
}

/** 모델이 넣은 @import·@font-face(외부)를 제거한다. font-family 선언은 남긴다. */
export function stripWebFontDirectives(html: string): string {
  return html
    .replace(/@import\s+(?:url\s*\([^)]*\)|"[^"]*"|'[^']*')[^;]*;?/gi, '')
    .replace(/@font-face\s*\{[^{}]*\}/gi, '')
    .replace(/\n{3,}/g, '\n\n');
}

/** HTML의 @import URL과 @font-face 안 http(s) 글꼴 URL을 모은다. */
export function collectWebFontRefs(html: string): { cssUrls: string[]; faces: WebFontFile[] } {
  const cssUrls: string[] = [];
  for (const m of html.matchAll(/@import\s+url\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi)) {
    if (/^https?:\/\//i.test(m[1])) cssUrls.push(m[1]);
  }
  for (const m of html.matchAll(/@import\s+['"](https?:[^'"]+)['"]/gi)) {
    cssUrls.push(m[1]);
  }
  const faces: WebFontFile[] = [];
  for (const block of html.matchAll(/@font-face\s*\{([^{}]*)\}/gi)) {
    const body = block[1];
    const family = /font-family\s*:\s*['"]?([^;'"}]+)['"]?/i.exec(body)?.[1]?.trim();
    const url = /url\s*\(\s*['"]?(https?:[^'")\s]+)['"]?\s*\)/i.exec(body)?.[1];
    if (!family || !url) continue;
    const weight = Number(/font-weight\s*:\s*(\d+)/i.exec(body)?.[1] ?? 400);
    const style = /font-style\s*:\s*(italic|oblique|normal)/i.exec(body)?.[1]?.toLowerCase() ?? 'normal';
    faces.push({ family, name: family, url, weight: Number.isFinite(weight) ? weight : 400, style });
  }
  return { cssUrls: [...new Set(cssUrls)], faces };
}

/** 공개 CSS(특히 Google Fonts)를 받아 텍스트로 돌려준다. */
export async function fetchFontCss(url: string): Promise<string> {
  if (!isPublicHttpUrl(url)) throw new Error('받을 수 없는 주소입니다.');
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
    headers: {
      Accept: 'text/css,*/*;q=0.1',
      'User-Agent': FONT_CSS_UA,
    },
  });
  if (!res.ok) throw new Error(`글꼴 CSS를 받지 못했습니다 (HTTP ${res.status}).`);
  if (!isPublicHttpUrl(res.url)) throw new Error('받을 수 없는 주소로 넘어갔습니다.');
  const text = await res.text();
  if (text.length > 500_000) throw new Error('글꼴 CSS가 너무 큽니다.');
  return text;
}

/** CSS @font-face 목록에서 family당 대표 파일 하나를 고른다 (400 normal 우선). */
export function pickWebFontFiles(faces: WebFontFile[]): WebFontFile[] {
  const byFamily = new Map<string, WebFontFile[]>();
  for (const f of faces) {
    const key = f.family.toLowerCase();
    const list = byFamily.get(key) ?? [];
    list.push(f);
    byFamily.set(key, list);
  }
  const picked: WebFontFile[] = [];
  for (const list of byFamily.values()) {
    if (picked.length >= MAX_WEB_FONT_FAMILIES) break;
    const best =
      list.find((f) => f.weight === 400 && f.style === 'normal') ??
      list.find((f) => f.style === 'normal') ??
      list.find((f) => f.weight === 400) ??
      list[0];
    if (best) picked.push(best);
  }
  return picked;
}

/** Google Fonts 등 CSS 텍스트에서 @font-face → 파일 URL을 뽑는다. */
export function parseFontFaceCss(css: string): WebFontFile[] {
  const faces: WebFontFile[] = [];
  for (const block of css.matchAll(/@font-face\s*\{([^{}]*)\}/gi)) {
    const body = block[1];
    const family = /font-family\s*:\s*['"]?([^;'"}]+)['"]?/i.exec(body)?.[1]?.trim();
    const urls = [...body.matchAll(/url\s*\(\s*['"]?(https?:[^'")\s]+)['"]?\s*\)/gi)].map((m) => m[1]);
    const fileUrl = urls.find((u) => /\.woff2(?:\?|$)/i.test(u)) ?? urls.find((u) => /\.woff(?:\?|$)/i.test(u)) ?? urls[0];
    if (!family || !fileUrl) continue;
    const weight = Number(/font-weight\s*:\s*(\d+)/i.exec(body)?.[1] ?? 400);
    const style = /font-style\s*:\s*(italic|oblique|normal)/i.exec(body)?.[1]?.toLowerCase() ?? 'normal';
    faces.push({
      family,
      name: family,
      url: fileUrl,
      weight: Number.isFinite(weight) ? weight : 400,
      style,
    });
  }
  return faces;
}

/**
 * HTML의 외부 웹 글꼴 참조를 파일 URL 목록으로 풀어낸다.
 * @import CSS를 받아 파싱하고, 인라인 @font-face도 포함한다.
 */
export async function resolveWebFontFiles(html: string): Promise<WebFontFile[]> {
  const { cssUrls, faces } = collectWebFontRefs(html);
  const all = [...faces];
  for (const cssUrl of cssUrls) {
    const css = await fetchFontCss(cssUrl);
    all.push(...parseFontFaceCss(css));
  }
  return pickWebFontFiles(all);
}
