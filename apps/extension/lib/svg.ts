/** PNG는 화면 크기의 2배로 그려 선명하게 한다. */
const SCALE = 2;
const MAX_HTML_HEIGHT = 3000;

/** SVG를 흰 바탕 PNG로 그린다. <img>로 불러 그리므로 SVG 안의 스크립트와 외부 자원은 실행되지 않는다. */
async function drawSvg(svg: string, width: number, height: number, what: string): Promise<Blob> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try {
    await img.decode();
  } catch {
    throw new Error(`${what}를 그리지 못했습니다. 문법(태그 짝, 따옴표, & 문자)을 확인하세요.`);
  }
  const canvas = new OffscreenCanvas(Math.round(width * SCALE), Math.round(height * SCALE));
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** SVG 글을 PNG로 그린다. 루트에 width/height가 있어야 한다 (서버가 viewBox에 맞춰 단다). */
export function renderSvg(svg: string): Promise<Blob> {
  const root = /^<svg([^>]*)>/i.exec(svg.trim())?.[1] ?? '';
  const size = (name: string) => Number(new RegExp(`\\s${name}\\s*=\\s*["']([\\d.]+)`, 'i').exec(root)?.[1] ?? 0);
  const width = size('width');
  const height = size('height');
  if (!width || !height) throw new Error('SVG에 width/height가 없습니다.');
  return drawSvg(svg, width, height, 'SVG');
}

/**
 * HTML 조각을 width 폭으로 그려 PNG로 만든다.
 * 스크립트를 막은 숨긴 iframe에서 높이를 재고, 정리된 XHTML을 SVG foreignObject에 담아 그린다.
 * fontCss: 렌더러가 붙이는 @font-face (번들·작업공간). 모델 HTML에는 @font-face를 쓰지 않는다.
 */
export async function renderHtml(html: string, width: number, fontCss = ''): Promise<Blob> {
  const frame = document.createElement('iframe');
  frame.sandbox.add('allow-same-origin');
  frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;height:10px;border:0;visibility:hidden;`;
  frame.srcdoc =
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0;padding:0;background:#fff;width:${width}px;font-family:sans-serif;color:#222;}` +
    `*{box-sizing:border-box;}` +
    `${fontCss}</style></head><body>${html}</body></html>`;
  try {
    await new Promise<void>((resolve, reject) => {
      frame.onload = () => resolve();
      frame.onerror = () => reject(new Error('HTML을 불러오지 못했습니다.'));
      document.body.appendChild(frame);
    });
    const doc = frame.contentDocument;
    if (!doc) throw new Error('HTML을 불러오지 못했습니다.');
    if (doc.fonts?.ready) await doc.fonts.ready.catch(() => {});
    const height = Math.min(MAX_HTML_HEIGHT, Math.ceil(doc.documentElement.scrollHeight));
    if (!height) throw new Error('HTML 내용의 높이가 0입니다.');
    const xhtml = new XMLSerializer().serializeToString(doc.documentElement);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
    return await drawSvg(svg, width, height, 'HTML');
  } finally {
    frame.remove();
  }
}
