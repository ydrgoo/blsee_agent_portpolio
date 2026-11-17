import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import { uploadImage } from './image-upload';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex = mathjax.document('', {
  InputJax: new TeX({
    packages: AllPackages,
    formatError: (_jax: unknown, err: Error) => {
      throw err;
    },
  }),
  OutputJax: new SVG({ fontCache: 'none' }),
});

/** MathJax 글꼴의 x 높이 (em 대비) */
const EX_PER_EM = 0.431;
const PAD = 4;
/** PNG는 화면 크기의 2배로 그려 선명하게 한다. */
const SCALE = 2;

export interface RenderedFormula {
  blob: Blob;
  /** 화면에 보일 크기(px). PNG는 이것의 SCALE배다. */
  width: number;
  height: number;
}

function toSvg(latex: string, fontPx: number): { svg: string; width: number; height: number } {
  const node = tex.convert(latex, { display: true, em: fontPx, ex: fontPx * EX_PER_EM, containerWidth: 1200 });
  let svg = adaptor.innerHTML(node);
  const ex = fontPx * EX_PER_EM;
  const size = (name: string) => Number(new RegExp(`${name}="([\\d.]+)ex"`).exec(svg)?.[1] ?? 0) * ex;
  const width = size('width');
  const height = size('height');
  if (!width || !height) throw new Error(`수식을 그리지 못했습니다: ${latex}`);
  svg = svg
    .replace(/width="[\d.]+ex"/, `width="${width}"`)
    .replace(/height="[\d.]+ex"/, `height="${height}"`)
    .replace(/currentColor/g, '#000');
  if (!svg.includes('xmlns=')) svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  return { svg, width, height };
}

/** LaTeX를 흰 바탕 PNG로 그린다. 잘못된 LaTeX면 MathJax 오류를 던진다. */
export async function renderFormula(latex: string, fontPx = 15): Promise<RenderedFormula> {
  const { svg, width, height } = toSvg(latex, fontPx);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const w = Math.ceil(width + PAD * 2);
  const h = Math.ceil(height + PAD * 2);
  const canvas = new OffscreenCanvas(w * SCALE, h * SCALE);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, PAD * SCALE, PAD * SCALE, width * SCALE, height * SCALE);
  return { blob: await canvas.convertToBlob({ type: 'image/png' }), width: w, height: h };
}

/**
 * 수식 블록에 넣을 html·thumbnail. 에디터는 latex를 다시 그리지 않고 html을 그대로 보여 주므로
 * html 안에 올린 그림을 넣는다. 수식 편집창은 latex를 읽는다.
 */
export function formulaFields(src: string, size: { width: number; height: number }) {
  const bare = src.split('?')[0];
  return {
    html:
      `<div style="font-size: 15px;" class="lama-viewer"><div class="mq-math-mode-wrapper">` +
      `<div style="display: block;" class="mq-math-mode"><img src="${bare}" width="${size.width}" height="${size.height}" alt=""></div></div></div>`,
    thumbnail: { src: bare, width: size.width, height: size.height, '@ctype': 'thumbnail' },
  };
}

/** 이미 올린 수식 그림 (LaTeX → 필드). 같은 수식은 다시 올리지 않는다. */
const uploadedFormulas = new Map<string, ReturnType<typeof formulaFields>>();

/** 수식을 그려 네이버에 올리고 수식 블록에 넣을 필드를 돌려준다. */
export async function uploadFormula(latex: string): Promise<ReturnType<typeof formulaFields>> {
  const cached = uploadedFormulas.get(latex);
  if (cached) return structuredClone(cached);
  const r = await renderFormula(latex);
  const uploaded = await uploadImage(r.blob);
  const fields = formulaFields(String(uploaded.src), r);
  uploadedFormulas.set(latex, fields);
  return structuredClone(fields);
}
