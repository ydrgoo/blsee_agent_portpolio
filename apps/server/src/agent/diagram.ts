/** 블로그 본문 폭에 맞춘 그림 크기 상한 (px) */
const MAX_WIDTH = 960;
const MAX_HEIGHT = 1600;

export const SVG_RULES = `- 결과는 <svg>로 시작해 </svg>로 끝나는 SVG 하나다. 설명이나 코드 울타리(\`\`\`)는 쓰지 않는다.
- viewBox를 꼭 쓴다. 가로는 600~800 사이로 하고, 세로는 내용에 맞춘다.
- 맨 아래에 흰 바탕 <rect width="100%" height="100%" fill="#fff"/>를 깐다.
- 글자는 font-family="sans-serif", 크기 16 이상. 한국어 글자도 된다. 글자가 선이나 다른 글자와 겹치지 않게 둔다.
- 선은 stroke-width 2 안팎, 색은 3~4가지 안에서 구별되게 쓴다. 화살표는 <marker>로 그린다.
- 좌표와 각도는 계산해서 정확하게 그린다 (예: 반사면에 대해 입사각과 반사각이 같게, 수직은 정말 수직으로).
- 수식 기호는 글자로 쓴다 (예: θ, v⃗, ⊥, ², ½). LaTeX는 쓰지 않는다.
- <script>, <foreignObject>, <image>, 외부 주소(href, url(...)), on… 속성은 쓰지 않는다.`;

const FORBIDDEN = /<script|<foreignObject|<image|<iframe|\son\w+\s*=|javascript:|@import|url\(\s*['"]?(?!#)|(?:xlink:)?href\s*=\s*["'](?!#)/i;

/** 모델이 쓴 SVG를 확인하고 크기를 정한다. 안전하지 않거나 형식이 틀리면 던진다. */
export function checkSvg(raw: string): { svg: string; width: number; height: number } {
  let svg = raw
    .trim()
    .replace(/^```(?:svg|xml)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>$/i.test(svg)) throw new Error('<svg>로 시작해 </svg>로 끝나야 합니다.');
  const bad = FORBIDDEN.exec(svg);
  if (bad) throw new Error(`쓸 수 없는 내용이 있습니다: ${bad[0]}`);
  const box = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(svg);
  if (!box) throw new Error('viewBox가 없습니다.');
  const [w, h] = [Number(box[1]), Number(box[2])];
  if (!(w > 0 && h > 0)) throw new Error('viewBox 크기가 잘못됐습니다.');
  const scale = Math.min(1, MAX_WIDTH / w, MAX_HEIGHT / h);
  const width = Math.round(w * scale);
  const height = Math.round(h * scale);
  // 루트의 width/height를 viewBox에 맞춰 다시 단다.
  svg = svg.replace(/^<svg([^>]*)>/i, (_, attrs: string) => {
    const rest = attrs.replace(/\s(width|height)\s*=\s*["'][^"']*["']/gi, '');
    const ns = /xmlns\s*=/.test(rest) ? '' : ' xmlns="http://www.w3.org/2000/svg"';
    return `<svg${ns}${rest} width="${width}" height="${height}">`;
  });
  return { svg, width, height };
}

export const HTML_RULES = `- html에는 <body> 안에 들어갈 내용만 쓴다. 꾸밈은 맨 앞 <style> 하나나 style 속성으로 한다.
- width는 그림 폭(px)이다. 600~800 사이로 하고, 내용은 그 폭 안에 들어가게 한다. 높이는 내용에 맞게 저절로 정해진다.
- 바깥 여백(padding)을 24px 안팎으로 두고 흰 바탕이 기본이다.
- 글꼴은 list_fonts가 준 family 이름만 font-family에 쓴다 (예: font-family: 'Nanum Myeongjo', serif). 본문 16px 이상. 번들에 없는 글꼴은 download_font로 받은 뒤 family만 쓴다.
- flex, grid, 테두리, 둥근 모서리, 배경색, 그라데이션을 써도 된다. 색은 3~4가지 안에서 차분하게 쓴다.
- <script>, <iframe>, <link>, 외부 http(s) 주소, 웹 글꼴(@font-face, @import), on… 속성은 쓰지 않는다.
- 사진·일러스트는 request_pixel로 만든 URI만 <img src="blsee://lib/images/…"/> 또는 style의 url("blsee://lib/images/…")에 쓴다. 도형은 인라인 <svg>로 쓴다.
- 제목·수치·설명·배지 문구는 HTML 글자로 쓴다. 그림 안에는 글자를 넣지 않는다.
- HTML은 XHTML처럼 쓴다: 태그를 모두 닫고(<br/>), 속성값은 따옴표로 감싸고, & 는 &amp; 로 쓴다.`;

const HTML_FORBIDDEN =
  /<script|<iframe|<link|<object|<embed|<image|<foreignObject|<meta|<base|\son\w+\s*=|javascript:|@import|@font-face/i;
const BLSEE_IMG = /^blsee:\/\/lib\/images\/[a-z0-9]+$/i;

/** 모델이 쓴 HTML을 확인한다. 안전하지 않으면 던진다. */
export function checkHtml(raw: string, width: number): { html: string; width: number } {
  const html = raw
    .trim()
    .replace(/^```(?:html)?\s*/i, '')
    .replace(/```$/, '')
    .replace(/<\/?(?:html|head|body)[^>]*>/gi, '')
    .trim();
  if (!html) throw new Error('HTML이 비었습니다.');
  const bad = HTML_FORBIDDEN.exec(html);
  if (bad) throw new Error(`쓸 수 없는 내용이 있습니다: ${bad[0]}`);
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']*)["']/gi)) {
    const v = m[1];
    if (v.startsWith('#') || BLSEE_IMG.test(v)) continue;
    throw new Error(`쓸 수 없는 주소가 있습니다: ${m[0]}`);
  }
  for (const m of html.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi)) {
    const v = m[1];
    if (v.startsWith('#') || BLSEE_IMG.test(v)) continue;
    throw new Error(`쓸 수 없는 url()이 있습니다: ${m[0]}`);
  }
  return { html, width: Math.round(Math.min(MAX_WIDTH, Math.max(320, width || 720))) };
}
