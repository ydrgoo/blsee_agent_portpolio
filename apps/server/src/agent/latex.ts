import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';

RegisterHTMLHandler(liteAdaptor());
const tex = mathjax.document('', {
  InputJax: new TeX({
    // noundefined는 모르는 명령을 빨간 글자로 그려 넘기므로 빼서 오류가 나게 한다.
    packages: AllPackages.filter((p) => p !== 'noundefined'),
    formatError: (_jax: unknown, err: Error) => {
      throw err;
    },
  }),
  OutputJax: new SVG({ fontCache: 'none' }),
});

/** 에디터의 수식 편집기(MathQuill)가 다시 열 수 없는 구문 */
const UNSUPPORTED = [/\\begin\{/, /\\displaystyle/, /\\tag\b/, /\\label\b/];

/** 확장이 그릴 수 있고 에디터에서 다시 고칠 수 있는 LaTeX인지 확인한다. 아니면 이유를 던진다. */
export function checkLatex(latex: string): string {
  const s = latex.trim().replace(/^\$+|\$+$/g, '').trim();
  if (!s) throw new Error('수식이 비어 있습니다.');
  const bad = UNSUPPORTED.find((re) => re.test(s));
  if (bad) throw new Error(`에디터 수식 편집기가 지원하지 않는 구문입니다 (${bad.source}). 한 줄 수식으로 쓴다.`);
  try {
    tex.convert(s, { display: true });
  } catch (e) {
    const message = (e as { message?: unknown })?.message;
    throw new Error(`LaTeX 문법 오류: ${typeof message === 'string' ? message : String(e)}`);
  }
  return s;
}
