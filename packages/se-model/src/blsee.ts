/**
 * 블씨 마크다운: 에이전트가 문서를 읽고(read), 고치고(edit 패치), 쓰는(write·insert) 하나의 글 형식.
 *
 * - 한 줄이 한 문단이고, 빈 줄은 빈 문단(줄 간격)이다.
 * - `# ` `## ` `### ` 소제목, `- ` 글머리 목록(앞 공백 2칸마다 한 단계), `> ` 인용구(`> [!bubble]` 모양, `> -- 출처: …` 출처),
 *   `---` 구분선(`--- line3` 모양), `$$…$$` 수식, ``` 코드, `<table>…</table>` 표, `![캡션](URI)` 이미지,
 *   `<!-- blsee://block/N … -->` 글로 쓸 수 없는 블록(이미지 묶음, 링크 카드 등), `<title>…</title>` 글 제목.
 * - 문단 안 꾸밈은 <b> <i> <u> <s> <span style="color:#rrggbb"> <a href="…">만 쓴다.
 * - 위 기호로 시작하는 보통 문단은 맨 앞에 \를 붙인다.
 *
 * 글을 고친 결과는 원래 블록과 단위(문단·토큰)별로 맞춰 본 뒤, 안 바뀐 것은 원래 객체를 그대로 두고
 * 바뀐 것만 다시 만든다. 그래서 블록 경계 표시 없이 범위를 통째로 바꿔도 블록 참조와 서식이 남는다.
 *
 * index.ts와 서로 가져오므로, 모듈 최상위에서 index의 값을 쓰지 않는다 (함수 안에서만).
 */
import {
  EditError,
  INLINE_IMAGE_MARK,
  LINE_LAYOUTS,
  PENDING_FORMULA_KEY,
  QUOTATION_LAYOUTS,
  makeComponent,
  makeParagraph,
  newId,
  paragraphText,
  typeLabel,
  type SeComponent,
  type SeNode,
  type SeParagraph,
  type SeTextNode,
} from './index';
import { fontSizeOf } from './fonts';
import { fitStrip } from './strip';
import { applyTableChanges, tableMarkup, type TableRowSpec, type TableRun } from './table';

/** 문단 안 글자 조각. 꾸밈은 표와 같고 링크가 더 있다. */
export interface BlsRun extends TableRun {
  link?: string;
}

export interface BlsPara {
  runs: BlsRun[];
  /** 글머리 목록 단계 (0부터). 목록이 아니면 없다 */
  bullet?: number;
}

/** 글을 이루는 단위. src는 그 단위를 쓴 글(한 줄 또는 여러 줄)이다. */
export type BlsUnit =
  | { t: 'title'; src: string; para: BlsPara }
  | { t: 'p'; src: string; para: BlsPara }
  | { t: 'h'; src: string; level: number; para: BlsPara }
  | { t: 'q'; src: string; para: BlsPara }
  | { t: 'qlayout'; src: string; layout: string }
  | { t: 'qsrc'; src: string; text: string }
  | { t: 'code'; src: string; text: string }
  | { t: 'table'; src: string; rows?: TableRowSpec[] }
  | { t: 'formula'; src: string; latex: string }
  | { t: 'hr'; src: string; layout: string }
  | { t: 'img'; src: string; uri: string; caption: string }
  /** 한 줄에 이미지 2~3장: 나란히 놓는 새 이미지 묶음 (읽은 글의 묶음은 keep 줄이다) */
  | { t: 'strip'; src: string; imgs: { uri: string; caption: string }[] }
  | { t: 'keep'; src: string; ref: string };

export type BlsUnitKind = BlsUnit['t'];

/** 한 줄에 나란히 놓을 수 있는 이미지 수 */
export const STRIP_MAX = 3;
const IMG_TOKEN = /!\[((?:\\.|[^\]\\])*)\]\((\S+?)\)/g;

/* ---------- 공통 ---------- */

const isTextNode = (n: SeNode): n is SeTextNode => n['@ctype'] === 'textNode';
const cloneJson = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const FLAG_KEYS = ['bold', 'italic', 'underline', 'strike'] as const;

/** 맞춰 볼 때 쓰는 글: NBSP·폭 없는 글자·줄 끝 공백 차이는 같은 것으로 본다. */
export function normalizeSrc(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[​‌‍﻿]/g, '')
    .replace(/[ \t]+$/gm, '');
}

/** 소제목 단계 → 글자 크기 (1단계는 에디터 기본 크기) */
const HEADING_LEVEL_SIZE: Record<number, number | undefined> = { 1: undefined, 2: 19, 3: 16 };
const MAX_HEADING_LEVEL = 3;

function headingLevelOfSize(size: number | undefined): number {
  if (size === undefined) return 1;
  if (size === 19) return 2;
  if (size <= 16) return 3;
  return 1;
}

const QUOTE_SHORT = (layout: string) => layout.replace(/^quotation_/, '');
const QUOTE_FULL = (short: string) => (short === 'default' ? 'default' : `quotation_${short}`);

/* ---------- 읽기: 블록 → 글 ---------- */

/** 블록에서 가장 많이 쓴 글자색 (없으면 undefined). 글에서는 이 색을 생략한다. */
function baseColorOf(ps: SeParagraph[]): string | undefined {
  const counts = new Map<string, number>();
  for (const p of ps) {
    for (const n of p.nodes) {
      if (!isTextNode(n) || !n.value) continue;
      const color = String(n.style?.fontColor ?? '').toLowerCase();
      counts.set(color, (counts.get(color) ?? 0) + n.value.length);
    }
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return top || undefined;
}

function linkOf(n: SeTextNode): string | undefined {
  const url = n.link?.url;
  return typeof url === 'string' && url ? url : undefined;
}

/** 조각 글: NBSP·폭 없는 글자·줄바꿈만 맞추고, 앞뒤 공백은 그대로 둔다. */
function normalizeRunText(s: string): string {
  return s
    .replace(/\r\n?|\n/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '');
}

function runsOf(p: SeParagraph, base: string | undefined): BlsRun[] {
  const runs: BlsRun[] = p.nodes.map((n) => {
    if (!isTextNode(n)) return { text: n['@ctype'] === 'imageNode' ? INLINE_IMAGE_MARK : `{${n['@ctype']}}` };
    const s = n.style ?? {};
    const color = String(s.fontColor ?? '').toLowerCase();
    const link = linkOf(n);
    return {
      text: n.value,
      ...(s.bold ? { bold: true } : {}),
      ...(s.italic ? { italic: true } : {}),
      ...(s.underline ? { underline: true } : {}),
      ...(s.strikethrough ? { strike: true } : {}),
      ...(color && color !== base ? { color } : {}),
      ...(link ? { link } : {}),
    };
  });
  // 조각마다 줄 끝 공백을 지우면 꾸밈이 바뀌기 직전의 공백("따라서, " + <b>…)이 사라진다. 공백은 남기고 글자만 맞춘다.
  return mergeRuns(runs.map((r) => ({ ...r, text: normalizeRunText(r.text) })));
}

const sameFormat = (a: BlsRun, b: BlsRun) => FLAG_KEYS.every((k) => a[k] === b[k]) && a.color === b.color && a.link === b.link;

function mergeRuns(runs: BlsRun[]): BlsRun[] {
  const out: BlsRun[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = out.at(-1);
    if (last && sameFormat(last, r)) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

const INLINE_TAG_NAMES = 'b|strong|i|em|u|s|strike|del|span|font|a';
const TAG_START = new RegExp(`<(?=/?(?:${INLINE_TAG_NAMES})(?:\\s[^<>]*)?>)`, 'gi');

/** 마크다운 꾸밈으로 읽힐 글자 (**, __, ~~, `…`, [글](주소)) */
const MD_MARK = /\*\*|__|~~|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\//;

/**
 * 글자로 둘 <, &만 바꾼다 (보통 글은 그대로 보이게).
 * 마크다운 꾸밈처럼 보이는 글자가 원래 글에 있으면 기호를 엔티티로 바꿔, 다시 읽을 때 꾸밈으로 바뀌지 않게 한다.
 */
function escText(s: string): string {
  let out = s.replace(/&(?=(?:lt|gt|amp|quot|#\d+);)/g, '&amp;');
  if (MD_MARK.test(out)) {
    out = out.replace(/\*/g, '&#42;').replace(/_/g, '&#95;').replace(/~/g, '&#126;').replace(/`/g, '&#96;').replace(/\[/g, '&#91;');
  }
  return out.replace(TAG_START, '&lt;');
}

/**
 * 모델이 습관처럼 쓴 마크다운 꾸밈을 허용 태그로 바꾼다: **굵게**·__굵게__ → <b>, ~~취소~~ → <s>, [글](주소) → <a>, `코드` → 글자.
 * 원래 글에 있던 같은 기호는 읽을 때 엔티티로 막아 두었으니 여기서 바뀌지 않는다.
 */
function markdownToTags(s: string): string {
  return s
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, text: string, url: string) => `<a href="${escAttr(url)}">${text}</a>`)
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<b>$1</b>')
    .replace(/__(?=\S)(.+?)(?<=\S)__/g, '<b>$1</b>')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<s>$1</s>')
    .replace(/`([^`\n]+)`/g, '$1');
}

/** 캡션·출처처럼 꾸밈 없는 칸: 마크다운 기호만 지운다. */
function plainMarkdown(s: string): string {
  return decodeEntities(markdownToTags(s).replace(/<a href="([^"]*)">([^<]*)<\/a>/g, '$2 ($1)').replace(/<\/?[bs]>/g, ''));
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function runText(r: BlsRun): string {
  let s = escText(r.text);
  if (r.color) s = `<span style="color:${r.color}">${s}</span>`;
  if (r.strike) s = `<s>${s}</s>`;
  if (r.underline) s = `<u>${s}</u>`;
  if (r.italic) s = `<i>${s}</i>`;
  if (r.bold) s = `<b>${s}</b>`;
  if (r.link) s = `<a href="${escAttr(r.link)}">${s}</a>`;
  return s;
}

export function inlineText(runs: BlsRun[]): string {
  return runs.map(runText).join('');
}

/** 보통 문단이 다른 문법으로 읽히지 않도록 \를 붙여야 하는지 */
const P_SPECIAL = /^(?:#{1,6}(?:\s|$)|>|\s*[-*]\s|-{3,}\s*(?:\S+\s*)?$|\$\$|\\\[|`{3,}|!\[|<!--|<title>|<table[\s>]|\\)/;
const Q_SPECIAL = /^(?:\[!|--\s*출처|—\s*출처|\\)/;

function paraLine(para: BlsPara): string {
  const text = inlineText(para.runs);
  if (para.bullet !== undefined) return `${'  '.repeat(para.bullet)}- ${text}`;
  return P_SPECIAL.test(text) ? `\\${text}` : text;
}

function quoteLine(para: BlsPara): string {
  const text = inlineText(para.runs);
  if (!text) return '>';
  return `> ${Q_SPECIAL.test(text) ? `\\${text}` : text}`;
}

function bulletOf(p: SeParagraph): number | undefined {
  const list = p.style?.list as { type?: unknown; level?: unknown } | undefined;
  if (!list || list.type !== 'bullet') return undefined;
  const level = Number(list.level ?? 0);
  return Number.isInteger(level) && level >= 0 ? level : 0;
}

/** 문단에서 가장 많이 쓴 글자 서식 (글자 수 기준) */
function dominantStyle(p: SeParagraph | undefined): Record<string, unknown> {
  const counts = new Map<string, number>();
  for (const n of p?.nodes ?? []) {
    if (!isTextNode(n) || !n.value) continue;
    const key = JSON.stringify(n.style ?? {});
    counts.set(key, (counts.get(key) ?? 0) + n.value.length);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return top ? JSON.parse(top) : {};
}

function headingLevelOf(p: SeParagraph): number {
  return headingLevelOfSize(fontSizeOf(dominantStyle(p).fontSizeCode));
}

const paras = (v: unknown): SeParagraph[] => (Array.isArray(v) ? (v as SeParagraph[]) : []);
const plainOf = (ps: unknown) => paras(ps).map(paragraphText).join(' ');

function escCaption(s: string): string {
  return normalizeSrc(s).replace(/\n/g, ' ').replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

function codeFence(text: string): string {
  let fence = '```';
  while (text.includes(fence)) fence += '`';
  return fence;
}

/** 읽기 결과 단위와, 맞춰 보는 데 쓸 원래 객체 */
interface Entry {
  unit: BlsUnit;
  /** 문단 단위의 원래 문단 */
  para?: SeParagraph;
}

function opaqueNote(c: SeComponent): string {
  switch (c['@ctype']) {
    case 'imageStrip':
      return `이미지 묶음 ${((c.images as unknown[]) ?? []).length}장`;
    case 'oglink':
      return `링크 카드: ${String(c.title ?? '').replace(/--/g, '-')} (${String(c.link ?? '')})`;
    default:
      return typeLabel(c['@ctype']);
  }
}

function entriesOf(c: SeComponent, ref: string): Entry[] {
  const out: Entry[] = [];
  const para = (t: 'p' | 'q', p: SeParagraph, base: string | undefined) => {
    const bp: BlsPara = { runs: runsOf(p, base) };
    if (t === 'p') {
      const bullet = bulletOf(p);
      if (bullet !== undefined) bp.bullet = bullet;
    }
    out.push({ unit: { t, src: t === 'p' ? paraLine(bp) : quoteLine(bp), para: bp } as BlsUnit, para: p });
  };
  switch (c['@ctype']) {
    case 'documentTitle': {
      const text = normalizeSrc(plainOf(c.title));
      const bp: BlsPara = { runs: text ? [{ text }] : [] };
      out.push({ unit: { t: 'title', src: `<title>${inlineText(bp.runs)}</title>`, para: bp }, para: paras(c.title)[0] });
      break;
    }
    case 'sectionTitle': {
      const ps = paras(c.title);
      const base = baseColorOf(ps);
      for (const p of ps) {
        const bp: BlsPara = { runs: runsOf(p, base) };
        const level = headingLevelOf(p);
        out.push({ unit: { t: 'h', src: `${'#'.repeat(level)} ${inlineText(bp.runs)}`.trimEnd(), level, para: bp }, para: p });
      }
      break;
    }
    case 'text': {
      const ps = paras(c.value);
      const base = baseColorOf(ps);
      for (const p of ps) para('p', p, base);
      break;
    }
    case 'quotation': {
      const ps = paras(c.value);
      const base = baseColorOf(ps);
      const layout = String(c.layout ?? 'default');
      if (layout !== 'default') out.push({ unit: { t: 'qlayout', src: `> [!${QUOTE_SHORT(layout)}]`, layout } });
      for (const p of ps) para('q', p, base);
      const source = normalizeSrc(plainOf(c.source)).trim();
      if (source) out.push({ unit: { t: 'qsrc', src: `> -- 출처: ${source}`, text: source } });
      break;
    }
    case 'code': {
      const text = String(c.codeContents ?? '').replace(/\r\n?/g, '\n');
      const fence = codeFence(text);
      out.push({ unit: { t: 'code', src: `${fence}\n${text}\n${fence}`, text } });
      break;
    }
    case 'formula': {
      const latex = String(c.latex ?? '');
      out.push({ unit: { t: 'formula', src: latex.includes('\n') ? `$$\n${latex}\n$$` : `$$${latex}$$`, latex } });
      break;
    }
    case 'table':
      out.push({ unit: { t: 'table', src: tableMarkup(c) } });
      break;
    case 'horizontalLine': {
      const layout = String(c.layout ?? 'default');
      out.push({ unit: { t: 'hr', src: layout === 'default' ? '---' : `--- ${layout}`, layout } });
      break;
    }
    case 'image': {
      const caption = plainOf(c.caption);
      const uri = `${ref}/image`;
      out.push({ unit: { t: 'img', src: `![${escCaption(caption)}](${uri})`, uri, caption: normalizeSrc(caption) } });
      break;
    }
    case 'wrappingParagraph': {
      const img = c.wrappedSection as SeComponent | undefined;
      const caption = plainOf(img?.caption);
      const uri = `${ref}/image`;
      out.push({ unit: { t: 'img', src: `![${escCaption(caption)}](${uri})`, uri, caption: normalizeSrc(caption) } });
      const ps = paras(c.text);
      const base = baseColorOf(ps);
      for (const p of ps) para('p', p, base);
      break;
    }
    default:
      out.push({ unit: { t: 'keep', src: `<!-- ${ref} ${opaqueNote(c)} -->`, ref } });
  }
  return out;
}

/** 블록 하나를 블씨 마크다운으로 */
export function serializeBlock(c: SeComponent, ref: string): string {
  return entriesOf(c, ref)
    .map((e) => e.unit.src)
    .join('\n');
}

/* ---------- 쓰기: 글 → 단위 ---------- */

export interface ParseOptions {
  /** 표 HTML(<table>…</table>)을 행 명세로. 없으면 표 단위에 rows가 없다 (바뀐 표는 적용할 수 없다). */
  parseTable?: (html: string) => TableRowSpec[];
}

const ENTITY: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"' };

function decodeEntities(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|#\d+);/g, (_, e: string) => (e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1))) : ENTITY[e]));
}

function attrOf(attrs: string, name: string): string | undefined {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : undefined;
}

function hexColor(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(v);
  if (rgb) return `#${rgb.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}`;
  return undefined;
}

function styleColor(attrs: string): string | undefined {
  const style = attrOf(attrs, 'style') ?? '';
  const m = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style);
  return hexColor(m?.[1] ?? attrOf(attrs, 'color'));
}

type Frame = { name: string; set: Partial<BlsRun> };

const TAG_FLAG: Record<string, Partial<BlsRun>> = {
  b: { bold: true },
  strong: { bold: true },
  i: { italic: true },
  em: { italic: true },
  u: { underline: true },
  s: { strike: true },
  strike: { strike: true },
  del: { strike: true },
};

/** 문단 한 줄의 꾸밈 태그를 읽는다. 모르는 태그나 짝 없는 <는 글자로 둔다. */
export function parseInline(raw: string): BlsRun[] {
  const s = markdownToTags(raw);
  const runs: BlsRun[] = [];
  const stack: Frame[] = [];
  const current = (): Omit<BlsRun, 'text'> => Object.assign({}, ...stack.map((f) => f.set));
  const push = (text: string) => {
    if (text) runs.push({ text, ...current() });
  };
  const re = /<(\/?)([a-zA-Z]+)((?:\s[^<>]*)?)\s*\/?>|&(?:lt|gt|amp|quot|#\d+);|[^<&]+|[<&]/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const [token, close, rawName, attrs] = m;
    if (rawName === undefined) {
      push(token.startsWith('&') && token.length > 1 ? decodeEntities(token) : token);
      continue;
    }
    const name = rawName.toLowerCase();
    if (!new RegExp(`^(?:${INLINE_TAG_NAMES})$`).test(name)) {
      push(token);
      continue;
    }
    if (close) {
      const at = stack.map((f) => f.name).lastIndexOf(name);
      if (at >= 0) stack.splice(at, 1);
      continue;
    }
    let set: Partial<BlsRun> = TAG_FLAG[name] ?? {};
    if (name === 'span' || name === 'font') {
      const color = styleColor(attrs ?? '');
      set = color ? { color } : {};
    }
    if (name === 'a') {
      const href = attrOf(attrs ?? '', 'href');
      set = href ? { link: href } : {};
    }
    stack.push({ name, set });
  }
  return mergeRuns(runs);
}

function paraOf(text: string): BlsPara {
  return { runs: parseInline(text) };
}

/**
 * 블씨 마크다운을 단위 목록으로 읽는다. 문법에 맞지 않으면 EditError (몇 번째 줄인지 함께).
 * 단위의 src는 쓴 글 그대로이고, 맞춰 볼 때는 normalizeSrc로 비교한다.
 */
export function parseBlsee(text: string, options: ParseOptions = {}): BlsUnit[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const units: BlsUnit[] = [];
  const fail = (i: number, why: string): never => {
    throw new EditError(`${i + 1}번째 줄 "${lines[i].slice(0, 60)}": ${why}`);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = /^(`{3,})\s*\S*\s*$/.exec(line);
    if (fence) {
      const end = lines.findIndex((l, j) => j > i && l.trimEnd() === fence[1]);
      if (end < 0) fail(i, `코드 블록을 닫는 ${fence[1]} 줄이 없다.`);
      units.push({ t: 'code', src: lines.slice(i, end + 1).join('\n'), text: lines.slice(i + 1, end).join('\n') });
      i = end;
      continue;
    }

    const formula = /^\s*(?:\$\$(.+)\$\$|\\\[(.+)\\\])\s*$/.exec(line);
    if (formula) {
      units.push({ t: 'formula', src: line, latex: (formula[1] ?? formula[2]).trim() });
      continue;
    }
    if (line.trim() === '$$') {
      const end = lines.findIndex((l, j) => j > i && l.trim() === '$$');
      if (end < 0) fail(i, '수식을 닫는 $$ 줄이 없다.');
      units.push({ t: 'formula', src: lines.slice(i, end + 1).join('\n'), latex: lines.slice(i + 1, end).join('\n').trim() });
      i = end;
      continue;
    }

    if (/^\s*<table[\s>]/i.test(line)) {
      const end = lines.findIndex((l, j) => j >= i && /<\/table>\s*$/i.test(l));
      if (end < 0) fail(i, '표를 닫는 </table>이 없다.');
      const src = lines.slice(i, end + 1).join('\n');
      let rows: TableRowSpec[] | undefined;
      if (options.parseTable) {
        try {
          rows = options.parseTable(src);
        } catch (err) {
          fail(i, `표 HTML을 읽지 못했다: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!rows?.length) fail(i, '표에 <tr> 행이 없다.');
      }
      units.push({ t: 'table', src, ...(rows ? { rows } : {}) });
      i = end;
      continue;
    }

    const title = /^<title>(.*)<\/title>\s*$/.exec(line);
    if (title) {
      units.push({ t: 'title', src: line, para: paraOf(title[1]) });
      continue;
    }

    const keep = /^<!--\s*(blsee:\/\/block\/\d+)(?:\s[\s\S]*?)?-->\s*$/.exec(line);
    if (keep) {
      units.push({ t: 'keep', src: line, ref: keep[1] });
      continue;
    }
    if (/^<!--/.test(line)) fail(i, '<!-- --> 줄은 글로 쓸 수 없는 블록을 그대로 둘 때만 쓴다 (안의 blsee://block/N을 바꾸지 않는다).');

    const row = [...line.matchAll(IMG_TOKEN)];
    if (row.length > 1 && !line.replace(IMG_TOKEN, '').trim()) {
      if (row.length > STRIP_MAX) fail(i, `한 줄에 나란히 놓는 이미지는 ${STRIP_MAX}장까지다.`);
      units.push({ t: 'strip', src: line, imgs: row.map((m) => ({ uri: m[2], caption: plainMarkdown(m[1].replace(/\\(.)/g, '$1')) })) });
      continue;
    }
    const img = /^!\[((?:\\.|[^\]\\])*)\]\((\S+?)\)\s*$/.exec(line);
    if (img) {
      units.push({ t: 'img', src: line, uri: img[2], caption: plainMarkdown(img[1].replace(/\\(.)/g, '$1')) });
      continue;
    }

    const hr = /^-{3,}(?:\s+(\S+))?\s*$/.exec(line);
    if (hr) {
      const layout = hr[1] ?? 'default';
      if (!LINE_LAYOUTS.includes(layout)) fail(i, `구분선 모양은 ${LINE_LAYOUTS.join(', ')} 중 하나다.`);
      units.push({ t: 'hr', src: line, layout });
      continue;
    }

    const heading = /^(#{1,6})(?:\s+(.*?))?\s*$/.exec(line);
    if (heading) {
      units.push({ t: 'h', src: line, level: Math.min(heading[1].length, MAX_HEADING_LEVEL), para: paraOf(heading[2] ?? '') });
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      const inner = quote[1];
      const layout = /^\[!(\w+)\]\s*$/.exec(inner);
      if (layout) {
        const full = QUOTE_FULL(layout[1].toLowerCase());
        if (!QUOTATION_LAYOUTS.includes(full)) {
          fail(i, `인용구 모양은 ${QUOTATION_LAYOUTS.map(QUOTE_SHORT).join(', ')} 중 하나다.`);
        }
        units.push({ t: 'qlayout', src: line, layout: full });
        continue;
      }
      const source = /^(?:--|—)\s*출처\s*:\s*(.*)$/.exec(inner);
      if (source) {
        units.push({ t: 'qsrc', src: line, text: plainMarkdown(source[1].trim()) });
        continue;
      }
      units.push({ t: 'q', src: line, para: paraOf(inner.startsWith('\\') ? inner.slice(1) : inner) });
      continue;
    }

    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      units.push({ t: 'p', src: line, para: { ...paraOf(bullet[2]), bullet: Math.floor(bullet[1].replace(/\t/g, '  ').length / 2) } });
      continue;
    }

    units.push({ t: 'p', src: line, para: paraOf(line.startsWith('\\') ? line.slice(1) : line) });
  }
  return units;
}

/* ---------- 맞춰 보고 다시 만들기 ---------- */

export interface RebuildContext {
  /** 이미지 블록을 만든다 (보관 이미지는 넣기 대기 자리, 문서 이미지는 복사). */
  makeImage: (uri: string, id: string) => SeComponent;
}

/** 블록 종류마다 받을 수 있는 단위 (여러 단위로 된 블록만) */
const MULTI: Record<string, readonly BlsUnitKind[]> = {
  text: ['p'],
  wrappingParagraph: ['p'],
  sectionTitle: ['h'],
  quotation: ['q', 'qlayout', 'qsrc'],
};

/** 단위 하나로 새 블록을 만들 때의 블록 종류 */
const NEW_TYPE: Partial<Record<BlsUnitKind, string>> = {
  p: 'text',
  h: 'sectionTitle',
  q: 'quotation',
  qlayout: 'quotation',
  qsrc: 'quotation',
  code: 'code',
  table: 'table',
  formula: 'formula',
  hr: 'horizontalLine',
  img: 'image',
  strip: 'imageStrip',
};

/** 글에서 그대로 두어야 하는 블록 (지울 수 없다) */
const PROTECTED = (ctype: string) => !['text', 'sectionTitle', 'quotation', 'code', 'formula', 'table', 'horizontalLine'].includes(ctype);

interface OldEntry extends Entry {
  /** 원래 블록 순서 (old 안) */
  block: number;
  key: string;
}

interface Slot {
  unit: BlsUnit;
  key: string;
  /** 주인 블록: old의 순서(0 이상) 또는 새 블록(음수) */
  owner?: number;
  /** 글이 같은 원래 단위 (그대로 쓴다) */
  same?: OldEntry;
  /** 같은 자리에서 바뀐 원래 단위 (서식을 물려받는다) */
  was?: OldEntry;
}

function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

function nodeStyle(base: Record<string, unknown>, run: BlsRun, color: string | undefined): Record<string, unknown> | undefined {
  const s: Record<string, unknown> = { ...base };
  for (const k of ['bold', 'italic', 'underline', 'strikethrough', 'fontColor', '@ctype']) delete s[k];
  const fontColor = run.color ?? color;
  if (fontColor) s.fontColor = fontColor;
  if (run.bold) s.bold = true;
  if (run.italic) s.italic = true;
  if (run.underline) s.underline = true;
  if (run.strike) s.strikethrough = true;
  return Object.keys(s).length ? { ...s, '@ctype': 'nodeStyle' } : undefined;
}

interface Template {
  p?: SeParagraph;
  /** 그 문단이 있던 블록의 기본 글자색 */
  base?: string;
}

/** 새 문단을 만든다. 같은 자리 원래 문단의 정렬·글꼴·크기를 물려받는다. */
function buildParagraph(
  para: BlsPara,
  tpl: Template,
  pool: SeNode[],
  opts: { size?: number | null; list: boolean },
): SeParagraph {
  const textStyle = dominantStyle(tpl.p);
  if (opts.size === null) delete textStyle.fontSizeCode;
  else if (opts.size !== undefined) textStyle.fontSizeCode = `fs${opts.size}`;
  const nodes: SeNode[] = [];
  for (const run of para.runs) {
    run.text.split(INLINE_IMAGE_MARK).forEach((part, i) => {
      if (i > 0) {
        const inline = pool.shift();
        if (!inline) throw new EditError('글자처럼 넣은 이미지({이미지})는 새로 만들 수 없다. 원래 있던 {이미지}만 옮길 수 있다.');
        nodes.push(inline);
      }
      if (!part) return;
      const style = nodeStyle(textStyle, run, tpl.base);
      nodes.push({
        id: newId(),
        value: part,
        ...(style ? { style } : {}),
        ...(run.link ? { link: { url: run.link, '@ctype': 'urlLink' } } : {}),
        '@ctype': 'textNode',
      } as SeTextNode);
    });
  }
  if (!nodes.length) nodes.push({ id: newId(), value: '', '@ctype': 'textNode' });
  const style: Record<string, unknown> = { ...(tpl.p?.style ? cloneJson(tpl.p.style) : {}) };
  delete style['@ctype'];
  delete style.list;
  if (opts.list && para.bullet !== undefined) style.list = { type: 'bullet', level: para.bullet, '@ctype': 'paragraphListStyle' };
  const keep = Object.keys(style).length > 0;
  return { id: newId(), nodes, ...(keep ? { style: { ...style, '@ctype': 'paragraphStyle' } } : {}), '@ctype': 'paragraph' };
}

const inlineCount = (p: SeParagraph) => p.nodes.filter((n) => !isTextNode(n)).length;
const markCount = (para: BlsPara) => para.runs.reduce((n, r) => n + r.text.split(INLINE_IMAGE_MARK).length - 1, 0);

/**
 * 원래 블록들(old, 문서 순서로 이어진 범위)을 새 단위 목록으로 바꾼 블록들을 만든다.
 * old가 비어 있으면 모두 새 블록이다 (넣기).
 * 안 바뀐 단위는 원래 객체를, 같은 자리에서 바뀐 단위는 원래 블록 참조와 서식을 이어받는다.
 * 지울 수 없는 블록을 빠뜨리거나 받을 수 없는 단위가 있으면 EditError (이유를 함께 쓴다).
 */
export function rebuildBlocks(
  old: SeComponent[],
  oldRefs: string[],
  units: BlsUnit[],
  ctx: RebuildContext,
): { blocks: SeComponent[]; removed: SeComponent[] } {
  const olds: OldEntry[] = old.flatMap((c, block) =>
    entriesOf(c, oldRefs[block]).map((e) => ({ ...e, block, key: normalizeSrc(e.unit.src) })),
  );
  const slots: Slot[] = units.map((unit) => ({ unit, key: normalizeSrc(unit.src) }));
  const used = new Set<OldEntry>();
  const typeOf = (owner: number) => (owner >= 0 ? old[owner]['@ctype'] : newTypes[-owner - 1]);
  const newTypes: string[] = [];

  // 1. 글이 같은 단위를 순서대로 맞춘다.
  const matches = lcs(
    olds.map((e) => e.key),
    slots.map((s) => s.key),
  );
  for (const [i, j] of matches) {
    slots[j].same = olds[i];
    slots[j].owner = olds[i].block;
    used.add(olds[i]);
  }

  // 2. 자리를 옮긴 이미지·블록 표시는 같은 글끼리 맞춘다.
  for (const s of slots) {
    if (s.same || (s.unit.t !== 'img' && s.unit.t !== 'keep')) continue;
    const e = olds.find((o) => !used.has(o) && o.unit.t === s.unit.t && o.key === s.key);
    if (!e) continue;
    s.same = e;
    s.owner = e.block;
    used.add(e);
  }

  // 3. 맞춘 단위 사이(틈)에서 같은 종류끼리 짝지어 "바뀐 것"으로 본다.
  const bounds: [number, number][] = [[-1, -1], ...matches, [olds.length, slots.length]];
  for (let g = 0; g + 1 < bounds.length; g++) {
    const [oi, sj] = bounds[g];
    const [oe, se] = bounds[g + 1];
    let from = oi + 1;
    for (let j = sj + 1; j < se; j++) {
      const s = slots[j];
      if (s.owner !== undefined || s.unit.t === 'keep') continue;
      for (let i = from; i < oe; i++) {
        const e = olds[i];
        if (used.has(e) || e.unit.t !== s.unit.t) continue;
        // 감싸기 이미지는 바꿀 수 없으니 짝짓지 않는다.
        if (e.unit.t === 'img' && old[e.block]['@ctype'] !== 'image') continue;
        s.was = e;
        s.owner = e.block;
        used.add(e);
        from = i + 1;
        break;
      }
    }
  }

  // 4. 남은 단위는 앞(없으면 뒤) 블록에 붙이거나 새 블록을 만든다.
  const accepts = (owner: number | undefined, t: BlsUnitKind) => owner !== undefined && (MULTI[typeOf(owner)] ?? []).includes(t);
  slots.forEach((s, j) => {
    if (s.owner !== undefined) return;
    const t = s.unit.t;
    if (t === 'keep') {
      throw new EditError(
        `${s.unit.src}: 이 범위에 없는 블록 표시다. <!-- --> 줄은 읽은 그대로 두고, 새로 쓰거나 다른 블록 번호로 바꾸지 않는다.`,
      );
    }
    if (t === 'title') throw new EditError('<title> 줄은 글 제목 블록이 있는 범위에서 제목을 고칠 때만 쓴다.');
    const prev = slots[j - 1]?.owner;
    const next = slots[j + 1]?.owner;
    // 소제목과 인용구 모양 줄은 새 블록을 연다. 출처 줄 뒤의 인용 글도 새 인용구다.
    const opens = t === 'h' || t === 'qlayout' || (t === 'q' && slots[j - 1]?.unit.t === 'qsrc');
    if (!opens && accepts(prev, t)) s.owner = prev;
    else if (t !== 'h' && accepts(next, t) && next! >= 0) s.owner = next;
    else {
      newTypes.push(NEW_TYPE[t]!);
      s.owner = -newTypes.length;
    }
  });

  // 5. 이어진 단위를 블록으로 묶는다. 같은 원래 블록이 떨어져 나오면 뒤쪽은 새 블록이 된다.
  const groups: { owner: number; slots: Slot[] }[] = [];
  const seen = new Set<number>();
  for (const s of slots) {
    const last = groups.at(-1);
    if (last && last.owner === s.owner) {
      last.slots.push(s);
      continue;
    }
    let owner = s.owner!;
    if (owner >= 0 && seen.has(owner)) {
      newTypes.push(typeOf(owner));
      owner = -newTypes.length;
    }
    seen.add(owner);
    groups.push({ owner, slots: [s] });
  }

  // 6. 지울 수 없는 블록이 빠졌는지, 제목이 맨 앞에 남았는지 본다.
  const kept = new Set(groups.filter((g) => g.owner >= 0).map((g) => g.owner));
  const lost = old.flatMap((c, i) => (!kept.has(i) && PROTECTED(c['@ctype']) ? [`${oldRefs[i]}(${typeLabel(c['@ctype'])})`] : []));
  if (lost.length) {
    throw new EditError(
      `${lost.join(', ')}를 지울 수 없다. 이미지·이미지+글 감싸기·이미지 묶음·링크 카드·제목 블록의 줄(![…](…), <!-- … -->, <title>)은 ` +
        '고치는 글에서 빼지 않는다. 정말 지우려면 delete_block 작업으로 따로 지운다.',
    );
  }
  const titleAt = old.findIndex((c) => c['@ctype'] === 'documentTitle');
  if (titleAt >= 0 && groups[0]?.owner !== titleAt) throw new EditError('글 제목(<title> 줄)은 맨 앞에 둔다.');

  // 7. 글자처럼 넣은 이미지는 다시 만드는 문단들에서 모아 순서대로 다시 넣는다.
  const rebuilt = slots.filter((s) => !s.same && 'para' in s.unit);
  const pool: SeNode[] = olds
    .filter((e) => e.para && !slots.some((s) => s.same === e))
    .flatMap((e) => e.para!.nodes.filter((n) => !isTextNode(n)));
  const marks = rebuilt.reduce((n, s) => n + markCount((s.unit as { para: BlsPara }).para), 0);
  if (marks !== pool.length) {
    throw new EditError(
      `글자처럼 넣은 이미지({이미지})가 ${pool.length}개 있었는데 고친 글에는 ${marks}개다. {이미지}는 지우거나 새로 쓰지 않고 그대로 둔다.`,
    );
  }

  // 8. 블록을 만든다.
  const blocks = groups.map((g) => buildBlock(g.owner >= 0 ? old[g.owner] : undefined, typeOf(g.owner), g.slots, pool, ctx));
  const removed = old.filter((_, i) => !kept.has(i));
  return { blocks, removed };
}

/** 이 단위가 이어받을 서식: 바뀐 원래 단위, 없으면 같은 블록의 앞 문단 */
function templateOf(slot: Slot, prev: SeParagraph | undefined, owner: SeComponent | undefined): Template {
  const from = slot.was ?? slot.same;
  const p = from?.para ?? prev ?? (owner ? mainParas(owner)[0] : undefined);
  return { p, base: owner ? baseColorOf(mainParas(owner)) : undefined };
}

function mainParas(c: SeComponent): SeParagraph[] {
  switch (c['@ctype']) {
    case 'documentTitle':
    case 'sectionTitle':
      return paras(c.title);
    case 'text':
    case 'quotation':
      return paras(c.value);
    case 'wrappingParagraph':
      return paras(c.text);
    default:
      return [];
  }
}

function buildParas(
  slots: Slot[],
  t: 'p' | 'h' | 'q' | 'title',
  owner: SeComponent | undefined,
  pool: SeNode[],
): SeParagraph[] {
  let prev: SeParagraph | undefined;
  const out: SeParagraph[] = [];
  for (const s of slots) {
    if (s.unit.t !== t) continue;
    const u = s.unit as Extract<BlsUnit, { t: 'p' | 'h' | 'q' | 'title' }>;
    let p: SeParagraph;
    if (s.same?.para) {
      p = s.same.block !== undefined && owner && mainParas(owner).includes(s.same.para) ? s.same.para : cloneJson(s.same.para);
    } else {
      const tpl = templateOf(s, prev, owner);
      let size: number | null | undefined;
      if (u.t === 'h') {
        const was = tpl.p ? headingLevelOf(tpl.p) : undefined;
        if (was !== u.level) size = HEADING_LEVEL_SIZE[u.level] ?? null;
      }
      p = buildParagraph(u.para, tpl, pool, { size, list: u.t === 'p' });
    }
    out.push(p);
    prev = p;
  }
  return out;
}

/** 다시 만든 문단 목록이 원래와 같은 객체들이면 원래 값(null 등)을 그대로 둔다. */
function keepList(orig: unknown, built: SeParagraph[]): unknown {
  const list = paras(orig);
  if (list.length === built.length && list.every((p, i) => p === built[i])) return orig;
  return built;
}

function buildBlock(owner: SeComponent | undefined, ctype: string, slots: Slot[], pool: SeNode[], ctx: RebuildContext): SeComponent {
  const first = slots[0];
  // 하나로 된 블록: 글이 같으면 원래 블록 그대로
  if (!MULTI[ctype] && slots.length === 1 && first.same && owner) return owner;
  if (!MULTI[ctype] && slots.length > 1) {
    throw new EditError(`${typeLabel(ctype)} 블록 하나에 여러 줄을 둘 수 없다: ${slots.map((s) => s.unit.src).join(' / ').slice(0, 120)}`);
  }
  const c: SeComponent = owner ? cloneJson(owner) : (undefined as unknown as SeComponent);
  const u = first.unit;
  switch (ctype) {
    case 'documentTitle': {
      c.title = keepList(owner?.title, buildParas(slots, 'title', owner, pool));
      return c;
    }
    case 'text': {
      const value = buildParas(slots, 'p', owner, pool);
      if (owner) {
        c.value = keepList(owner.value, value);
        return c;
      }
      return { ...makeComponent('text', { paragraphs: [] }), value };
    }
    case 'wrappingParagraph': {
      if (slots[0].unit.t !== 'img' || !slots[0].same) {
        throw new EditError('이미지+글 감싸기 블록의 이미지 줄(![…](…/image))은 그 블록 글 바로 앞에 그대로 둔다.');
      }
      c.text = keepList(owner?.text, buildParas(slots, 'p', owner, pool));
      return c;
    }
    case 'sectionTitle': {
      const title = buildParas(slots, 'h', owner, pool);
      if (owner) {
        c.title = keepList(owner.title, title);
        return c;
      }
      return { ...makeComponent('sectionTitle', { paragraphs: [] }), title };
    }
    case 'quotation': {
      const value = buildParas(slots, 'q', owner, pool);
      const layout = (slots.find((s) => s.unit.t === 'qlayout')?.unit as { layout?: string } | undefined)?.layout ?? 'default';
      const sourceText = (slots.find((s) => s.unit.t === 'qsrc')?.unit as { text?: string } | undefined)?.text ?? '';
      if (!value.length && !owner) throw new EditError('새 인용구에는 "> 글" 줄이 하나 이상 있어야 한다.');
      const base = owner ? c : makeComponent('quotation', { paragraphs: [] });
      const oldSource = paras(base.source);
      const sameSource = normalizeSrc(oldSource.map(paragraphText).join(' ')).trim() === sourceText;
      return {
        ...base,
        layout: owner && layout === String(owner.layout ?? 'default') ? owner.layout : layout,
        value: owner ? keepList(owner.value, value) : value,
        source: sameSource ? base.source : sourceText ? [makeParagraph(sourceText)] : null,
      };
    }
    case 'code': {
      const text = (u as Extract<BlsUnit, { t: 'code' }>).text;
      if (owner) {
        c.codeContents = text;
        return c;
      }
      return makeComponent('code', { paragraphs: text.split('\n') });
    }
    case 'table': {
      const rows = (u as Extract<BlsUnit, { t: 'table' }>).rows;
      if (!rows) throw new EditError('표 HTML을 읽지 못했다.');
      if (owner) {
        applyTableChanges(c, [{ start: 1, delete: ((c.rows as unknown[]) ?? []).length, rows }]);
        return c;
      }
      return makeComponent('table', { table: rows });
    }
    case 'formula': {
      const latex = (u as Extract<BlsUnit, { t: 'formula' }>).latex;
      if (!latex.trim()) throw new EditError('수식 줄($$…$$)이 비었다.');
      if (owner) {
        c.latex = latex;
        c[PENDING_FORMULA_KEY] = true;
        return c;
      }
      return { id: newId(), layout: 'default', latex, fontSizeCode: 'fs15', fontFamily: 'system', '@ctype': 'formula', [PENDING_FORMULA_KEY]: true };
    }
    case 'horizontalLine': {
      const layout = (u as Extract<BlsUnit, { t: 'hr' }>).layout;
      if (owner) {
        c.layout = layout;
        return c;
      }
      return makeComponent('horizontalLine', { layout });
    }
    case 'image': {
      const img = u as Extract<BlsUnit, { t: 'img' }>;
      const caption = img.caption.trim();
      if (owner && first.was && img.uri === (first.was.unit as { uri: string }).uri) {
        // 캡션만 바뀌었다.
        if (caption) c.caption = [makeParagraph(caption)];
        else delete c.caption;
        return c;
      }
      const made = ctx.makeImage(img.uri, owner ? owner.id : newId());
      if (owner && owner.align !== undefined) made.align = owner.align;
      if (caption) made.caption = [makeParagraph(caption)];
      return made;
    }
    case 'imageStrip': {
      if (owner) return owner;
      const strip = u as Extract<BlsUnit, { t: 'strip' }>;
      const images = strip.imgs.map((img) => {
        const made = ctx.makeImage(img.uri, newId());
        delete made.align;
        made.caption = img.caption.trim() ? [makeParagraph(img.caption.trim())] : null;
        return made;
      });
      return fitStrip({ id: newId(), layout: 'default', contentMode: 'fit', images, caption: null, '@ctype': 'imageStrip' });
    }
    default:
      if (owner) return owner;
      throw new EditError(`${typeLabel(ctype)} 블록은 글로 새로 만들 수 없다.`);
  }
}
