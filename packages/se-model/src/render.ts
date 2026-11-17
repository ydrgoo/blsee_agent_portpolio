/**
 * 문서 데이터만으로 블로그 글 모양을 대략 HTML로 그린다 (화면 캡처 없이).
 * 스마트에디터의 실제 CSS를 흉내 낸 근사치이며, 스타일은 모두 인라인이라 그대로 이미지로 바꿀 수 있다.
 */
import { fontByCode } from './fonts';
import type { SeComponent, SeDocumentData, SeNode, SeParagraph, SeTableRow } from './index';

/**
 * 아직 에디터에 올리지 않은 새 이미지 자리. 이미지 컴포넌트에 이 키로 blsee://gen/{ID} 를 달아 두고,
 * 적용할 때 실제로 업로드한 이미지 컴포넌트로 바꾼다. 이 키가 남은 채로 에디터에 쓰면 안 된다.
 */
export const PENDING_IMAGE_KEY = '__pendingImage';

export interface RenderOptions {
  /** 이미지 주소를 바꾼다 (예: data URL로). null이면 회색 자리표시로 그린다. */
  imageSrc?: (src: string) => string | null;
  /** 넣기 대기 중인 이미지(blsee://gen/{ID})의 주소 */
  pendingSrc?: (uri: string) => string | null;
}

export const RENDER_WIDTH = 720;
const BASE_FONT = 16;
const FONT = `'Nanum Gothic','Apple SD Gothic Neo','Malgun Gothic',sans-serif`;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
}

function css(style: Record<string, string | number | undefined>): string {
  return Object.entries(style)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${v}`)
    .join(';');
}

function fontSize(code: unknown): string | undefined {
  const m = /^fs(\d+)$/.exec(String(code ?? ''));
  return m ? `${m[1]}px` : undefined;
}

function nodeHtml(n: SeNode, opts: RenderOptions): string {
  if (n['@ctype'] === 'imageNode') {
    return imgHtml(n as unknown as SeComponent, opts, 'display:inline-block;vertical-align:middle;max-height:120px');
  }
  if (n['@ctype'] !== 'textNode') return `<span style="color:#999">[${esc(n['@ctype'])}]</span>`;
  const s = (n.style ?? {}) as Record<string, unknown>;
  const deco = [s.underline && 'underline', s.strikethrough && 'line-through'].filter(Boolean).join(' ');
  const style = css({
    color: s.fontColor as string,
    backgroundColor: s.backgroundColor as string,
    fontSize: fontSize(s.fontSizeCode),
    fontFamily: fontByCode(s.fontFamily)?.css.replace(/"/g, "'"),
    fontWeight: s.bold ? 'bold' : undefined,
    fontStyle: s.italic ? 'italic' : undefined,
    textDecoration: deco || (n.link ? 'underline' : undefined),
  });
  const text = esc((n as { value: string }).value).replace(/\n/g, '<br/>') || '&#8203;';
  return style ? `<span style="${style}">${text}</span>` : text;
}

function paragraphsHtml(ps: unknown, opts: RenderOptions, extra = ''): string {
  if (!Array.isArray(ps)) return '';
  return (ps as SeParagraph[])
    .map((p) => {
      const align = (p.style?.align as string) || undefined;
      const inner = p.nodes.map((n) => nodeHtml(n, opts)).join('') || '<br/>';
      return `<p style="${css({ margin: '0', minHeight: '1.8em', textAlign: align })}${extra}">${inner}</p>`;
    })
    .join('');
}

function imgHtml(c: SeComponent, opts: RenderOptions, extra = ''): string {
  const pending = c[PENDING_IMAGE_KEY];
  const raw = typeof c.src === 'string' ? c.src : '';
  const src =
    typeof pending === 'string'
      ? (opts.pendingSrc?.(pending) ?? null)
      : raw
        ? opts.imageSrc
          ? opts.imageSrc(raw)
          : raw
        : null;
  const w = Number(c.width) || 0;
  const h = Number(c.height) || 0;
  const width = w ? Math.min(w, RENDER_WIDTH) : RENDER_WIDTH;
  const height = w && h ? Math.round((h * width) / w) : 200;
  if (!src) {
    return `<div style="${css({ width: `${width}px`, height: `${height}px`, maxWidth: '100%', background: '#e5e5e5', color: '#888', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px' })};${extra}">이미지 ${esc(c.fileName)}</div>`;
  }
  return `<img src="${esc(src)}" alt="" style="${css({ width: `${width}px`, maxWidth: '100%', height: 'auto', display: 'block' })};${extra}"/>`;
}

const QUOTE_STYLE: Record<string, string> = {
  default: css({ textAlign: 'center', padding: '28px 40px 8px', fontSize: '19px', color: '#333' }),
  quotation_line: css({ borderLeft: '4px solid #333', padding: '4px 0 4px 20px', fontSize: '17px' }),
  quotation_bubble: css({ background: '#f2f2f2', borderRadius: '24px', padding: '24px 32px', fontSize: '17px' }),
  quotation_underline: css({ textAlign: 'center', padding: '8px 40px 16px', borderBottom: '2px solid #333', fontSize: '19px', margin: '0 120px' }),
  quotation_postit: css({ background: '#fff8c8', boxShadow: '2px 3px 6px rgba(0,0,0,.15)', padding: '28px 32px', fontSize: '17px' }),
  quotation_corner: css({ borderTop: '3px solid #333', borderLeft: '3px solid #333', padding: '20px 28px', fontSize: '17px', margin: '0 40px' }),
};

function quotationHtml(c: SeComponent, opts: RenderOptions): string {
  const layout = c.layout && QUOTE_STYLE[c.layout] ? c.layout : 'default';
  const mark = layout === 'default' ? `<div style="font-size:48px;line-height:1;color:#bbb">“</div>` : '';
  const source = paragraphsHtml(c.source, opts);
  const sourceHtml = source
    ? `<div style="${css({ marginTop: '10px', fontSize: '13px', color: '#888', textAlign: layout === 'default' || layout === 'quotation_underline' ? 'center' : undefined })}">${source}</div>`
    : '';
  return `<blockquote style="margin:0;${QUOTE_STYLE[layout]}">${mark}${paragraphsHtml(c.value, opts)}${sourceHtml}</blockquote>`;
}

const LINE_STYLE: Record<string, string> = {
  default: css({ width: '60px', borderTop: '2px solid #333', margin: '0 auto' }),
  line1: css({ borderTop: '1px solid #333' }),
  line2: css({ borderTop: '1px dashed #333' }),
  line3: css({ borderTop: '2px dotted #333' }),
  line4: css({ borderTop: '3px double #333' }),
  line5: css({ borderTop: '3px solid #333' }),
  line6: css({ width: '160px', borderTop: '1px solid #333', margin: '0 auto' }),
  line7: css({ width: '8px', height: '8px', background: '#333', transform: 'rotate(45deg)', margin: '0 auto' }),
};

function tableHtml(c: SeComponent, opts: RenderOptions): string {
  const rows = (c.rows as SeTableRow[]) ?? [];
  const header = c.layout && c.layout !== 'default' && c.layout !== 'table_layout1';
  const body = rows
    .map((r, ri) => {
      const cells = r.cells
        .map((cell) => {
          const bg = cell.backgroundColor || (header && ri === 0 ? '#f4f4f4' : undefined);
          const attrs = `${cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : ''}${cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ''}`;
          const style = css({ border: '1px solid #ccc', padding: '8px 10px', verticalAlign: 'top', background: bg, fontSize: '15px' });
          return `<td${attrs} style="${style}">${paragraphsHtml(cell.value, opts)}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return `<table style="border-collapse:collapse;width:100%;table-layout:fixed">${body}</table>`;
}

function componentHtml(c: SeComponent, opts: RenderOptions): string {
  switch (c['@ctype']) {
    case 'documentTitle':
      return `<div style="${css({ fontSize: '32px', fontWeight: 'bold', textAlign: c.align as string, paddingBottom: '16px', borderBottom: '1px solid #eee' })}">${paragraphsHtml(c.title, opts)}</div>`;
    case 'sectionTitle':
      return `<div style="font-size:24px;font-weight:bold">${paragraphsHtml([c.title, c.value].find(Array.isArray), opts)}</div>`;
    case 'text':
      return paragraphsHtml(c.value, opts);
    case 'quotation':
      return quotationHtml(c, opts);
    case 'horizontalLine':
      return `<div style="padding:12px 0"><div style="${LINE_STYLE[c.layout ?? 'default'] ?? LINE_STYLE.default}"></div></div>`;
    case 'table':
      return tableHtml(c, opts);
    case 'code':
      return `<pre style="${css({ margin: '0', background: '#f6f6f6', border: '1px solid #e5e5e5', padding: '16px', fontFamily: 'Menlo,monospace', fontSize: '13px', whiteSpace: 'pre-wrap' })}">${esc(c.codeContents)}</pre>`;
    case 'formula':
      return `<div style="text-align:center;font-family:serif;font-size:18px;color:#444">${esc(c.latex)}</div>`;
    case 'image': {
      const caption = paragraphsHtml(c.caption, opts, ';font-size:13px;color:#777;text-align:center');
      const align = c.align === 'left' ? 'flex-start' : c.align === 'right' ? 'flex-end' : 'center';
      return `<div style="display:flex;flex-direction:column;align-items:${align}">${imgHtml(c, opts)}${caption ? `<div style="margin-top:8px;width:100%">${caption}</div>` : ''}</div>`;
    }
    case 'imageStrip': {
      // 한 줄에 나란히. 각 이미지 폭은 widthPercentage(합이 약 100)를 따르고, 높이는 브라우저가 비율대로 맞춘다.
      const capStyle = ';font-size:13px;color:#777;text-align:center';
      const imgs = ((c.images as SeComponent[]) ?? []).map((img) => {
        const pct = Number(img.widthPercentage);
        const basis = pct > 0 ? `flex:0 0 calc(${pct}% - 4px)` : 'flex:1';
        const cap = paragraphsHtml(img.caption, opts, capStyle);
        return `<div style="${basis};min-width:0">${imgHtml({ ...img, width: RENDER_WIDTH } as SeComponent, opts)}${cap ? `<div style="margin-top:6px">${cap}</div>` : ''}</div>`;
      });
      const caption = paragraphsHtml(c.caption, opts, capStyle);
      return `<div style="display:flex;gap:4px;justify-content:center">${imgs.join('')}</div>${caption ? `<div style="margin-top:8px">${caption}</div>` : ''}`;
    }
    case 'wrappingParagraph': {
      const img = c.wrappedSection as SeComponent | undefined;
      const right = String(c.layout ?? '').includes('right');
      const big = String(c.layout ?? '').includes('big');
      const box = css({ float: right ? 'right' : 'left', width: big ? '50%' : '33%', margin: right ? '0 0 12px 20px' : '0 20px 12px 0' });
      return `<div style="overflow:hidden">${img ? `<div style="${box}">${imgHtml(img, opts)}</div>` : ''}${paragraphsHtml(c.text, opts)}</div>`;
    }
    case 'oglink': {
      const thumb = c.thumbnail as SeComponent | undefined;
      const showThumb = c.layout !== 'text' && thumb?.src;
      return `<div style="display:flex;border:1px solid #ddd">${showThumb ? `<div style="width:140px;flex-shrink:0">${imgHtml({ ...thumb, width: 140, height: 100 } as SeComponent, opts)}</div>` : ''}<div style="padding:14px 18px;min-width:0"><div style="font-weight:bold;font-size:15px">${esc(c.title)}</div><div style="font-size:13px;color:#777;margin-top:4px">${esc(c.description)}</div><div style="font-size:12px;color:#03c75a;margin-top:6px">${esc(c.domain)}</div></div></div>`;
    }
    default:
      return `<div style="color:#999;font-size:13px">[${esc(c['@ctype'])}]</div>`;
  }
}

/** from~to번째 컴포넌트(0번은 제목)를 글 본문 폭으로 그린 HTML. */
export function renderHtml(doc: SeDocumentData, from = 0, to = Infinity, opts: RenderOptions = {}): string {
  const comps = doc.document.components.slice(Math.max(0, from), to + 1);
  const blocks = comps.map((c) => `<div style="margin:0 0 30px">${componentHtml(c, opts)}</div>`).join('');
  const root = css({
    width: `${RENDER_WIDTH}px`,
    padding: '40px',
    boxSizing: 'content-box',
    background: '#fff',
    color: '#333',
    fontFamily: FONT,
    fontSize: `${BASE_FONT}px`,
    lineHeight: '1.8',
    wordBreak: 'break-all',
  });
  return `<div xmlns="http://www.w3.org/1999/xhtml" style="${root}">${blocks}</div>`;
}

/** 그림 안에 넣을 이미지 주소들 (미리 받아 data URL로 바꿀 때 쓴다). */
export function imageSources(doc: SeDocumentData, from = 0, to = Infinity): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.src === 'string' && /^https?:/.test(o.src)) out.add(o.src);
      Object.values(o).forEach(walk);
    }
  };
  walk(doc.document.components.slice(Math.max(0, from), to + 1));
  return [...out];
}
