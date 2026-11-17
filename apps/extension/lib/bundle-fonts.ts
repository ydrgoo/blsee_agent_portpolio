/**
 * 확장에 넣은 번들 글꼴을 data URL로 읽어 @font-face CSS를 만든다.
 * 인포그래픽 HTML 렌더 직전에 iframe에 주입한다 (모델 HTML에는 @font-face를 쓰지 않는다).
 */
import { BUNDLE_FONT_FILES } from '@blog-helper/se-model';
import { blobToDataUrl } from './images';

const urlModules = import.meta.glob('../assets/fonts/*.woff2', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const byFile = new Map<string, string>();
for (const [path, url] of Object.entries(urlModules)) {
  byFile.set(path.slice(path.lastIndexOf('/') + 1), url);
}

let cached: string | null = null;

async function dataUrlOf(file: string): Promise<string | null> {
  const url = byFile.get(file);
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  return blobToDataUrl(await res.blob());
}

/** 번들 글꼴 @font-face CSS (한 번 만들면 재사용) */
export async function bundleFontFaceCss(): Promise<string> {
  if (cached) return cached;
  const parts: string[] = [];
  for (const font of BUNDLE_FONT_FILES) {
    for (const [weight, file] of Object.entries(font.weights)) {
      if (!file) continue;
      const data = await dataUrlOf(file);
      if (!data) continue;
      parts.push(
        `@font-face{font-family:'${font.family}';font-weight:${weight};font-style:normal;font-display:block;` +
          `src:url('${data}') format('woff2');}`,
      );
    }
  }
  cached = parts.join('\n');
  return cached;
}

/** 목록에 보여줄 번들 글꼴 (기본서체 제외) */
export function listBundleFonts(): { name: string; family: string; kind: 'bundle' }[] {
  return BUNDLE_FONT_FILES.map((f) => ({ name: f.name, family: f.family, kind: 'bundle' as const }));
}
