/**
 * 실행 모델이 쓴 표 HTML(<tr>…</tr>)을 se-model의 행 명세로 바꾼다.
 * 읽는 태그: tr, td/th (colspan, rowspan, 배경색, align), p/div/br (문단), b/strong, i/em, u, s/strike/del, span/font (글자색).
 * 그 밖의 태그는 안쪽 글자만 쓴다.
 */
import { parseDocument } from 'htmlparser2';
import type { ChildNode, Element } from 'domhandler';
import { HEX_COLOR, normalizeRuns, type TableCellSpec, type TableParagraph, type TableRowSpec, type TableRun } from '@blog-helper/se-model';

type Flags = Omit<TableRun, 'text'>;
type Align = TableParagraph['align'];

const isElement = (n: ChildNode): n is Element => n.type === 'tag';

function styleOf(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (el.attribs.style ?? '').split(';')) {
    const at = part.indexOf(':');
    if (at > 0) out[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim();
  }
  return out;
}

/** #rgb, #rrggbb, rgb(r,g,b)를 #rrggbb로. 못 읽으면 Error */
function hexColor(raw: string, what: string): string {
  const v = raw.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (HEX_COLOR.test(v)) return v;
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(v);
  if (rgb) return `#${rgb.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}`;
  throw new Error(`${what}은 #rrggbb 형식으로 쓴다: ${raw}`);
}

function alignOf(el: Element): Align | undefined {
  const v = (el.attribs.align ?? styleOf(el)['text-align'] ?? '').toLowerCase();
  return v === 'center' || v === 'right' || v === 'justify' ? v : undefined;
}

function span(el: Element, name: string): number | undefined {
  const raw = el.attribs[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name}는 1 이상의 정수여야 한다: ${raw}`);
  return n > 1 ? n : undefined;
}

/** 칸 안쪽을 문단 목록으로 */
function cellParagraphs(el: Element, cellAlign: Align | undefined): TableParagraph[] {
  const paragraphs: { runs: TableRun[]; align?: Align }[] = [];
  let current: { runs: TableRun[]; align?: Align } | null = null;
  const open = (align: Align | undefined) => {
    current = { runs: [], ...(align ? { align } : {}) };
    paragraphs.push(current);
    return current;
  };
  const take = (align: Align | undefined) => current ?? open(align);

  const walk = (nodes: ChildNode[], flags: Flags, align: Align | undefined) => {
    for (const n of nodes) {
      if (n.type === 'text') {
        const text = n.data.replace(/\s+/g, ' ');
        if (text) take(align).runs.push({ text, ...flags });
        continue;
      }
      if (!isElement(n)) continue;
      const tag = n.name.toLowerCase();
      if (tag === 'br') {
        take(align);
        current = null;
        take(align);
        continue;
      }
      if (tag === 'p' || tag === 'div') {
        const own = alignOf(n) ?? align;
        if (current && (current as { runs: TableRun[] }).runs.length) current = null;
        open(own);
        walk(n.children, flags, own);
        current = null;
        continue;
      }
      const next: Flags = { ...flags };
      if (tag === 'b' || tag === 'strong') next.bold = true;
      if (tag === 'i' || tag === 'em') next.italic = true;
      if (tag === 'u') next.underline = true;
      if (tag === 's' || tag === 'strike' || tag === 'del') next.strike = true;
      const color = styleOf(n).color ?? (tag === 'font' ? n.attribs.color : undefined);
      if (color) next.color = hexColor(color, '글자색');
      const weight = styleOf(n)['font-weight'];
      if (weight === 'bold' || Number(weight) >= 600) next.bold = true;
      walk(n.children, next, align);
    }
  };
  // th도 td처럼 다룬다 (굵게는 <b>로만 정한다).
  walk(el.children, {}, cellAlign);

  // 문단 앞뒤 공백을 다듬는다.
  const out = paragraphs.map((p) => {
    const runs = normalizeRuns(p.runs);
    if (runs.length) {
      runs[0].text = runs[0].text.trimStart();
      runs[runs.length - 1].text = runs[runs.length - 1].text.trimEnd();
    }
    return { ...p, runs: normalizeRuns(runs) };
  });
  while (out.length > 1 && !out[out.length - 1].runs.length) out.pop();
  return out;
}

function cellSpec(el: Element): TableCellSpec {
  const style = styleOf(el);
  const bg = style.background ?? style['background-color'] ?? el.attribs.bgcolor;
  const colSpan = span(el, 'colspan');
  const rowSpan = span(el, 'rowspan');
  return {
    paragraphs: cellParagraphs(el, alignOf(el)),
    ...(colSpan ? { colSpan } : {}),
    ...(rowSpan ? { rowSpan } : {}),
    ...(bg && bg !== 'none' && bg !== 'transparent' ? { background: hexColor(bg, '배경색') } : {}),
  };
}

/** tags에 든 요소를 문서 순서대로 모은다. 찾은 요소 안쪽은 더 들어가지 않는다. */
function collect(nodes: ChildNode[], tags: Set<string>, out: Element[] = []): Element[] {
  for (const n of nodes) {
    if (!isElement(n)) continue;
    if (tags.has(n.name.toLowerCase())) out.push(n);
    else collect(n.children, tags, out);
  }
  return out;
}

const ROW = new Set(['tr']);
const CELL = new Set(['td', 'th']);

/** <tr>들(앞뒤에 <table>, <tbody>가 있어도 된다)을 행 명세로. 비어 있으면 빈 배열 */
export function parseTableRows(html: string): TableRowSpec[] {
  const doc = parseDocument(html, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  return collect(doc.children, ROW).map((tr, i) => {
    const cells = collect(tr.children, CELL);
    if (!cells.length) throw new Error(`${i + 1}번째 <tr>에 칸(<td>)이 없다.`);
    return cells.map(cellSpec);
  });
}
