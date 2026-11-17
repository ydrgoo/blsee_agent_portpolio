/**
 * 스마트에디터 ONE 문서 데이터(getDocumentData / setDocumentData) 모델과 편집 연산.
 * 확인된 구조만 다루고, 모르는 필드는 원본을 그대로 보존한다.
 */
import { FONT_SIZES, fontByName, fontLabel, fontSizeOf } from './fonts';
import { PENDING_IMAGE_KEY } from './render';
import { applyTableChanges, checkTableRows, makeTableRows, type TableChange, type TableRowSpec } from './table';
import { rebuildBlocks, serializeBlock, type BlsUnit } from './blsee';
import { fitStrip } from './strip';

export * from './fonts';
export * from './table';
export * from './blsee';
export * from './strip';

export interface SeTextNode {
  id: string;
  value: string;
  style?: Record<string, unknown>;
  link?: Record<string, unknown>;
  '@ctype': 'textNode';
}

/** 문단 안의 글자가 아닌 노드 (글자처럼 취급한 이미지 imageNode 등) */
export interface SeInlineNode {
  id: string;
  '@ctype': string;
  [key: string]: unknown;
}

export type SeNode = SeTextNode | SeInlineNode;

export interface SeParagraph {
  id: string;
  nodes: SeNode[];
  /** 문단 정렬 등 (예: { align: 'left', '@ctype': 'paragraphStyle' }) */
  style?: Record<string, unknown>;
  '@ctype': 'paragraph';
}

/** AI에게 보여주는 문단 텍스트에서 글자처럼 취급한 이미지 자리 */
export const INLINE_IMAGE_MARK = '{이미지}';

export interface SeTableCell {
  id: string;
  colSpan: number;
  rowSpan: number;
  width: number;
  height: number;
  backgroundColor?: string;
  value: SeParagraph[] | null;
  '@ctype': 'tableCell';
}

export interface SeTableRow {
  cells: SeTableCell[];
  '@ctype': 'tableRow';
}

export interface SeComponent {
  id: string;
  layout?: string;
  '@ctype': string;
  [key: string]: unknown;
}

export interface SeDocumentData {
  document: { components: SeComponent[]; [key: string]: unknown };
  documentId?: string;
}

export type InsertableType = 'text' | 'sectionTitle' | 'quotation' | 'horizontalLine' | 'code' | 'table';

/** 에디터의 글 종류 메뉴 (본문/소제목/인용구). set_type으로 서로 바꿀 수 있다. */
export const TEXT_KINDS = ['text', 'sectionTitle', 'quotation'] as const;
export type TextKind = (typeof TEXT_KINDS)[number];

export const QUOTATION_LAYOUTS = [
  'default',
  'quotation_line',
  'quotation_bubble',
  'quotation_underline',
  'quotation_postit',
  'quotation_corner',
];

export const LINE_LAYOUTS = ['default', 'line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7'];

export const WRAP_LAYOUTS = ['inner-left', 'inner-right', 'inner-big-left', 'inner-big-right'];

const LAYOUTS: Record<string, string[]> = {
  quotation: QUOTATION_LAYOUTS,
  horizontalLine: LINE_LAYOUTS,
  wrappingParagraph: WRAP_LAYOUTS,
};

function checkLayout(ctype: string, layout: string | undefined): string {
  if (!layout) return 'default';
  const allowed = LAYOUTS[ctype];
  if (!allowed) throw new EditError(`${typeLabel(ctype)} 블록은 모양을 바꿀 수 없습니다.`);
  if (!allowed.includes(layout)) {
    throw new EditError(`${typeLabel(ctype)} 모양은 ${allowed.join(', ')} 중 하나여야 합니다.`);
  }
  return layout;
}

export class EditError extends Error {}

// ---------- 생성 ----------

export function newId(): string {
  return `SE-${crypto.randomUUID()}`;
}

export function makeParagraph(text: string): SeParagraph {
  return {
    id: newId(),
    nodes: [{ id: newId(), value: text, '@ctype': 'textNode' }],
    '@ctype': 'paragraph',
  };
}

function makeCell(text: string, width: number): SeTableCell {
  return {
    id: newId(),
    colSpan: 1,
    rowSpan: 1,
    width,
    height: 43,
    value: text ? text.split('\n').map(makeParagraph) : null,
    '@ctype': 'tableCell',
  };
}

function makeRows(rows: string[][]): { rows: SeTableRow[]; columnCount: number } {
  const columnCount = Math.max(1, ...rows.map((r) => r.length));
  const width = Math.round((100 / columnCount) * 100) / 100;
  return {
    columnCount,
    rows: rows.map((r) => ({
      cells: Array.from({ length: columnCount }, (_, i) => makeCell(r[i] ?? '', width)),
      '@ctype': 'tableRow',
    })),
  };
}

/** size: 글자 크기(px). 주면 글자 노드마다 지정한다. */
export function makeComponent(
  type: InsertableType,
  input: { paragraphs?: string[]; rows?: string[][]; table?: TableRowSpec[]; layout?: string; source?: string; size?: number },
): SeComponent {
  const paragraphs = input.paragraphs ?? [];
  const para = (text: string): SeParagraph => {
    const p = makeParagraph(text);
    if (input.size !== undefined) {
      for (const n of p.nodes) if (isTextNode(n)) n.style = { fontSizeCode: `fs${input.size}`, '@ctype': 'nodeStyle' };
    }
    return p;
  };
  switch (type) {
    case 'text':
      return { id: newId(), layout: 'default', value: paragraphs.map(para), '@ctype': 'text' };
    case 'sectionTitle':
      return { id: newId(), layout: 'default', title: paragraphs.map(para), '@ctype': 'sectionTitle' };
    case 'quotation':
      return {
        id: newId(),
        layout: checkLayout('quotation', input.layout),
        value: paragraphs.map(para),
        source: input.source ? [makeParagraph(input.source)] : null,
        '@ctype': 'quotation',
      };
    case 'horizontalLine':
      return { id: newId(), layout: checkLayout('horizontalLine', input.layout), '@ctype': 'horizontalLine' };
    case 'code':
      return {
        id: newId(),
        layout: 'default',
        fontSizeCode: 'fs13',
        codeContents: paragraphs.join('\n'),
        '@ctype': 'code',
      };
    case 'table': {
      if (!input.table?.length && !input.rows?.length) throw new EditError('표에는 rows가 필요합니다.');
      return {
        id: newId(),
        layout: 'default',
        width: 100,
        ...(input.table?.length ? makeTableRows(input.table) : makeRows(input.rows!)),
        borderStyleName: 'thinLine',
        '@ctype': 'table',
      };
    }
  }
}

// ---------- 텍스트 변환 ----------

function isTextNode(n: SeNode): n is SeTextNode {
  return n['@ctype'] === 'textNode';
}

export function paragraphText(p: SeParagraph): string {
  return p.nodes
    .map((n) => (isTextNode(n) ? n.value : n['@ctype'] === 'imageNode' ? INLINE_IMAGE_MARK : `{${n['@ctype']}}`))
    .join('');
}

function paragraphsText(ps: unknown): string[] {
  return Array.isArray(ps) ? (ps as SeParagraph[]).map(paragraphText) : [];
}

function cellText(cell: SeTableCell): string {
  return paragraphsText(cell.value).join(' / ');
}

export function tableRowsText(c: SeComponent): string[][] {
  return ((c.rows as SeTableRow[]) ?? []).map((r) => r.cells.map(cellText));
}
const TYPE_LABEL: Record<string, string> = {
  documentTitle: '제목',
  sectionTitle: '소제목',
  text: '문단',
  quotation: '인용구',
  code: '코드',
  table: '표',
  image: '이미지',
  imageStrip: '이미지 묶음',
  oglink: '링크 카드',
  horizontalLine: '구분선',
  formula: '수식',
  wrappingParagraph: '이미지+글 감싸기',
};

export function typeLabel(ctype: string): string {
  return TYPE_LABEL[ctype] ?? ctype;
}

/**
 * 사용자에게 보이는 블록 이름: 종류별로 문서 순서대로 센 번호 ("문단 3", "인용구 2", "이미지 4").
 * 제목은 하나뿐이라 번호 없이 "제목". 편집으로 블록이 늘거나 줄면 번호도 바뀐다.
 */
export function blockNames(doc: SeDocumentData): Map<string, string> {
  const counts = new Map<string, number>();
  const names = new Map<string, string>();
  for (const c of doc.document.components) {
    const t = c['@ctype'];
    if (t === 'documentTitle') {
      names.set(c.id, typeLabel(t));
      continue;
    }
    const n = (counts.get(t) ?? 0) + 1;
    counts.set(t, n);
    names.set(c.id, `${typeLabel(t)} ${n}`);
  }
  return names;
}

/** 블록 하나를 AI/사람이 읽을 수 있는 텍스트로 만든다. */
export function blockText(c: SeComponent): string {
  switch (c['@ctype']) {
    case 'documentTitle':
    case 'sectionTitle':
      return paragraphsText(c.title).join('\n');
    case 'text':
      return paragraphsText(c.value).join('\n');
    case 'quotation': {
      const source = paragraphsText(c.source).join(' ');
      return paragraphsText(c.value).join('\n') + (source ? `\n— 출처: ${source}` : '');
    }
    case 'code':
      return String(c.codeContents ?? '');
    case 'formula':
      return `(수식: ${c.latex ?? ''})`;
    case 'table':
      return tableRowsText(c)
        .map((r) => `| ${r.join(' | ')} |`)
        .join('\n');
    case 'image': {
      const caption = paragraphsText(c.caption).join(' ');
      const pending = c[PENDING_IMAGE_KEY];
      const name = typeof pending === 'string' ? `새 이미지 ${pending}` : String(c.fileName ?? '');
      return `(이미지: ${name}${caption ? `, 캡션: ${caption}` : ''})`;
    }
    case 'wrappingParagraph': {
      const img = c.wrappedSection as SeComponent | undefined;
      return `(이미지: ${img?.fileName ?? ''})\n${paragraphsText(c.text).join('\n')}`;
    }
    case 'imageStrip': {
      const imgs = (c.images as SeComponent[]) ?? [];
      const each = imgs.map((img, i) => {
        const pending = img[PENDING_IMAGE_KEY];
        const name = typeof pending === 'string' ? `새 이미지 ${pending}` : String(img.fileName ?? '');
        const cap = paragraphsText(img.caption).join(' ');
        return `${i + 1}번 ${name}${cap ? `(캡션: ${cap})` : ''}`;
      });
      const caption = paragraphsText(c.caption).join(' ');
      return `(이미지 ${imgs.length}장 한 줄 묶음: ${each.join(', ')}${caption ? `; 묶음 캡션: ${caption}` : ''})`;
    }
    case 'oglink':
      return `(링크 카드: ${c.title ?? ''} - ${c.link ?? ''})`;
    case 'horizontalLine':
      return '(구분선)';
    default: {
      // 구조를 확인하지 못한 블록도 글 문단이 있으면 읽어 준다.
      const paras = [c.title, c.value, c.text].find(Array.isArray);
      return paras ? paragraphsText(paras).join('\n') : `(${typeLabel(c['@ctype'])})`;
    }
  }
}

/** 블록의 본문 문단 (제목·소제목·문단·인용구 본문·감싸기 글). 캡션, 출처, 표 칸은 뺀다. */
function mainParagraphs(c: SeComponent): SeParagraph[] {
  switch (c['@ctype']) {
    case 'documentTitle':
    case 'sectionTitle':
      return Array.isArray(c.title) ? (c.title as SeParagraph[]) : [];
    case 'text':
    case 'quotation':
      return Array.isArray(c.value) ? (c.value as SeParagraph[]) : [];
    case 'wrappingParagraph':
      return Array.isArray(c.text) ? (c.text as SeParagraph[]) : [];
    default:
      return [];
  }
}

/** 글자 노드의 글꼴·크기 (예: "나눔명조 19"). 지정이 없으면 "기본" */
function nodeFont(n: SeTextNode): string {
  const s = n.style ?? {};
  return [s.fontFamily ? fontLabel(s.fontFamily) : '', fontSizeOf(s.fontSizeCode) ?? ''].filter(Boolean).join(' ') || '기본';
}

/** 문단의 글꼴·크기. 빈 문단은 undefined, 글자마다 다르면 "섞임(…)" */
function paragraphFont(p: SeParagraph): string | undefined {
  const fonts = [...new Set(p.nodes.filter(isTextNode).filter((n) => n.value.trim()).map(nodeFont))];
  if (!fonts.length) return undefined;
  return fonts.length === 1 ? fonts[0] : `섞임(${fonts.join(', ')})`;
}

/**
 * read_blocks에 덧붙이는 글꼴·크기 메모 (예: "(서식: 1~3번째 줄 나눔고딕 15, 4번째 줄 나눔명조 19)").
 * 블록 전체가 에디터 기본값이면 빈 문자열.
 */
function styleNote(c: SeComponent): string {
  const per = mainParagraphs(c).map(paragraphFont);
  const used = per.filter((f): f is string => f !== undefined);
  if (!used.length || used.every((f) => f === '기본')) return '';
  if (new Set(used).size === 1) return `(서식: ${used[0]})`;
  const groups: { from: number; to: number; font: string }[] = [];
  per.forEach((font, i) => {
    const last = groups.at(-1);
    if (font === undefined || font === last?.font) {
      if (last) last.to = i;
      return;
    }
    groups.push({ from: i, to: i, font });
  });
  const lines = (g: (typeof groups)[number]) => (g.from === g.to ? `${g.from + 1}` : `${g.from + 1}~${g.to + 1}`);
  return `(서식: ${groups.map((g) => `${lines(g)}번째 줄 ${g.font}`).join(', ')})`;
}

function blockLabel(c: SeComponent, names: Map<string, string>): string {
  const layout = LAYOUTS[c['@ctype']] ? ` 모양=${c.layout ?? 'default'}` : '';
  return `<${names.get(c.id) ?? typeLabel(c['@ctype'])}${layout}>`;
}

// ---------- 문서 URI ----------

/**
 * 에이전트가 문서 안의 것을 가리키는 주소. 블록 참조도 이 URI 자체다.
 * - blsee://block/3           : 블록 하나. 번호는 위치가 아니라 고정 번호라 편집 후에도 같은 블록을 가리킨다.
 * - blsee://block?from=3&to=5 : 문서 순서로 블록 3부터 5까지 (양 끝 포함)
 * - blsee://block/4/image     : 블록 4의 이미지 (블록에 이미지가 하나일 때)
 * - blsee://block/4/image/2   : 블록 4 안의 2번째 이미지 (이미지 묶음, 감싸기, 글자처럼 배치된 이미지)
 * - blsee://lib/images/k3x9qa2m : 블씨가 보관한 이미지 (만든 이미지, 붙여넣은 이미지, 라이브러리 이미지). 영소문자·숫자 8자 무작위 ID
 * - blsee://lib/infographics/k3x9qa2m : 인포그래픽 HTML 원본. 영소문자·숫자 8자 무작위 ID
 * - blsee://lib/html/k3x9qa2m   : 예전 인포 HTML 경로 (읽기 호환)
 * - blsee://gen/k3x9qa        : 예전 대화의 만든 이미지 (6자 ID). 읽기만 한다.
 */
export type DocUri =
  | { kind: 'block'; ref: string }
  | { kind: 'range'; from: string; to: string }
  | { kind: 'image'; ref: string; index: number }
  | { kind: 'gen'; id: string }
  | { kind: 'html'; id: string };

/** 정규식 조각 (앵커 없음) */
const LEGACY_GEN_ID_LENGTH = 6;
const GEN_PATH_SRC = String.raw`(?:lib/images/[a-z0-9]+|gen/[a-z0-9]{${LEGACY_GEN_ID_LENGTH}}(?![a-z0-9]))`;
const HTML_PATH_SRC = String.raw`lib/(?:infographics|html)/[a-z0-9]+`;

export const GEN_URI_SRC = String.raw`blsee://${GEN_PATH_SRC}`;
export const HTML_URI_SRC = String.raw`blsee://${HTML_PATH_SRC}`;
export const DOC_URI_SRC = String.raw`blsee://(?:block(?:/\d+(?:/image(?:/\d+)?)?|\?from=\d+&to=\d+)|${GEN_PATH_SRC}|${HTML_PATH_SRC})`;
export const BLOCK_URI_SRC = String.raw`blsee://block/\d+`;
export const RANGE_URI_SRC = String.raw`blsee://block\?from=\d+&to=\d+`;
export const IMAGE_URI_SRC = String.raw`blsee://(?:block/\d+/image(?:/\d+)?|${GEN_PATH_SRC})`;

export const blockUri = (n: number | string) => `blsee://block/${n}`;
export const rangeUri = (from: string, to: string) => `blsee://block?from=${blockNumber(from)}&to=${blockNumber(to)}`;
/** 예전 6자 ID는 예전 주소(blsee://gen/…)로 돌려준다. */
export const genImageUri = (id: string) =>
  id.length === LEGACY_GEN_ID_LENGTH ? `blsee://gen/${id}` : `blsee://lib/images/${id}`;
/** index를 주지 않으면 블록의 (하나뿐인) 이미지 */
export const blockImageUri = (ref: string, index?: number) => `${ref}/image${index !== undefined ? `/${index}` : ''}`;

export function isBlockRef(v: unknown): v is string {
  return typeof v === 'string' && /^blsee:\/\/block\/\d+$/.test(v);
}

function blockNumber(ref: string): string {
  return ref.slice('blsee://block/'.length);
}

export function parseUri(uri: string): DocUri | null {
  let m = /^blsee:\/\/block\/(\d+)$/.exec(uri);
  if (m) return { kind: 'block', ref: blockUri(m[1]) };
  m = /^blsee:\/\/block\/(\d+)\/image(?:\/(\d+))?$/.exec(uri);
  if (m) return { kind: 'image', ref: blockUri(m[1]), index: m[2] ? Number(m[2]) : 1 };
  m = /^blsee:\/\/block\?from=(\d+)&to=(\d+)$/.exec(uri);
  if (m) return { kind: 'range', from: blockUri(m[1]), to: blockUri(m[2]) };
  m = /^blsee:\/\/(?:lib\/images\/([a-z0-9]+)|gen\/([a-z0-9]{6}))$/.exec(uri);
  if (m) return { kind: 'gen', id: m[1] ?? m[2] };
  m = /^blsee:\/\/lib\/(?:infographics|html)\/([a-z0-9]+)$/.exec(uri);
  if (m) return { kind: 'html', id: m[1] };
  return null;
}

/** 블록을 가리키는 URI(블록, 범위, 블록 이미지)를 문서 순서의 블록 참조 목록으로 펼친다. order: 문서 순서의 블록 참조 */
export function expandUri(uri: string, order: readonly string[]): string[] {
  const u = parseUri(uri);
  if (!u || u.kind === 'gen' || u.kind === 'html') throw new EditError(`${uri}: 블록을 가리키는 URI가 아닙니다.`);
  const pos = (ref: string) => {
    const i = order.indexOf(ref);
    if (i < 0) throw new EditError(`${ref}: 문서에 없는 블록입니다.`);
    return i;
  };
  if (u.kind !== 'range') return [order[pos(u.ref)]];
  const [a, b] = [pos(u.from), pos(u.to)];
  if (b < a) throw new EditError(`${uri}: ${u.to}가 ${u.from}보다 앞에 있습니다.`);
  return order.slice(a, b + 1);
}

/** 개요 글에서 문서 순서의 블록 참조를 꺼낸다. */
export function outlineRefs(outlineText: string): string[] {
  return [...outlineText.matchAll(/^(blsee:\/\/block\/\d+) /gm)].map((m) => m[1]);
}

/** 개요 글에서 블록 참조 → 블록 종류(@ctype)를 꺼낸다. */
export function outlineTypes(outlineText: string): Map<string, string> {
  const byLabel = new Map(Object.entries(TYPE_LABEL).map(([ctype, label]) => [label, ctype]));
  const types = new Map<string, string>();
  for (const m of outlineText.matchAll(/^(blsee:\/\/block\/\d+) <(.+?)(?: \d+)?(?: 모양=\S+)?>/gm)) {
    types.set(m[1], byLabel.get(m[2]) ?? m[2]);
  }
  return types;
}

// ---------- 블록 참조 ----------

/**
 * 에디터 블록 ID ↔ 에이전트가 쓰는 블록 참조(blsee://block/1, blsee://block/2, …).
 * 에디터는 setDocumentData 전후로 블록 ID를 유지하므로, 한 번 붙인 참조는 편집 후에도 같은 블록을 가리킨다.
 */
export interface BlockRefsData {
  next: number;
  /** [블록 ID, 참조] */
  entries: [string, string][];
}

export class BlockRefs {
  private refById = new Map<string, string>();
  private idByRef = new Map<string, string>();
  private next = 1;

  /** 형식이 다른 참조가 들어 있으면 버리고 새로 시작한다. */
  static fromJSON(data?: BlockRefsData): BlockRefs {
    const refs = new BlockRefs();
    if (!data || !data.entries.every(([, ref]) => isBlockRef(ref))) return refs;
    for (const [id, ref] of data.entries) {
      refs.refById.set(id, ref);
      refs.idByRef.set(ref, id);
    }
    refs.next = data.next;
    return refs;
  }

  toJSON(): BlockRefsData {
    return { next: this.next, entries: [...this.refById] };
  }

  /** 아직 참조가 없는 블록에 문서 순서대로 참조를 붙인다. */
  sync(doc: SeDocumentData): void {
    for (const c of doc.document.components) this.refOf(c.id);
  }

  refOf(id: string): string {
    let ref = this.refById.get(id);
    if (!ref) {
      ref = blockUri(this.next++);
      this.refById.set(id, ref);
      this.idByRef.set(ref, id);
    }
    return ref;
  }

  idOf(ref: string): string | undefined {
    return this.idByRef.get(ref);
  }
}

function findByRef(doc: SeDocumentData, refs: BlockRefs, ref: string): number {
  const id = refs.idOf(ref);
  const i = id ? doc.document.components.findIndex((c) => c.id === id) : -1;
  if (i < 0) throw new EditError(`${ref}: 문서에 없는 블록입니다.`);
  return i;
}

// ---------- 읽기 ----------

const PREVIEW_CHARS = 30;
const READ_LIMIT_CHARS = 8000;
const FIND_MAX_RESULTS = 20;
const FIND_CONTEXT_CHARS = 20;
const TEXT_BLOCK_TYPES = new Set(['documentTitle', 'sectionTitle', 'text', 'quotation', 'code', 'table', 'wrappingParagraph']);

/** 문서 개요: 블록마다 참조, 종류, 글자 수, 앞부분 몇 글자. 본문 전체는 넣지 않는다. */
export function outline(doc: SeDocumentData, refs: BlockRefs): string {
  refs.sync(doc);
  const names = blockNames(doc);
  return doc.document.components
    .map((c) => {
      const text = blockText(c);
      const flat = text.replace(/\s+/g, ' ').trim();
      const preview = flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
      const size = TEXT_BLOCK_TYPES.has(c['@ctype']) ? ` ${text.length}자` : '';
      const ref = refs.refOf(c.id);
      return `${ref} ${blockLabel(c, names)}${size}${imageUrisOf(c, ref)} | ${preview}`;
    })
    .join('\n');
}

export interface ReadBlocksArgs {
  /** 블록, 범위, 블록 이미지 URI. 없으면 문서 전체 */
  uris?: string[];
  /** 블록 머리줄 없이 블씨 마크다운 본문만 이어 붙인다 (고칠 영역 원문). 글자 수로 끊지 않는다. */
  source?: boolean;
}

/** 문서 순서의 블록 참조 */
export function docOrder(doc: SeDocumentData, refs: BlockRefs): string[] {
  refs.sync(doc);
  return doc.document.components.map((c) => refs.refOf(c.id));
}

/** 블록 전문을 읽는다. 너무 길면 중간에서 끊고 이어 읽을 위치를 알려준다. */
export function readBlocks(doc: SeDocumentData, refs: BlockRefs, args: ReadBlocksArgs): string {
  const order = docOrder(doc, refs);
  const comps = doc.document.components;
  const wanted = args.uris?.length ? [...new Set(args.uris.flatMap((u) => expandUri(u, order)))] : order;
  const picked = wanted.map((r) => comps[findByRef(doc, refs, r)]);

  if (args.source) return picked.map((c) => serializeBlock(c, refs.refOf(c.id))).join('\n');
  const names = blockNames(doc);
  const parts: string[] = [];
  let used = 0;
  for (const c of picked) {
    const ref = refs.refOf(c.id);
    const note = styleNote(c);
    const part = `${ref} ${blockLabel(c, names)}${imageUrisOf(c, ref)}${note ? ` ${note}` : ''}\n${serializeBlock(c, ref)}`;
    if (parts.length && used + part.length > READ_LIMIT_CHARS) {
      parts.push(`(글자 수 제한으로 여기까지. ${ref}부터 이어서 읽는다.)`);
      break;
    }
    parts.push(part);
    used += part.length;
  }
  return parts.join('\n\n');
}

export interface FindResult {
  text: string;
  count: number;
}

/** 대소문자 구분 없이 글자를 찾아 블록 참조와 앞뒤 문맥을 돌려준다. */
export function findText(doc: SeDocumentData, refs: BlockRefs, query: string): FindResult {
  if (!query) throw new EditError('query가 비어 있습니다.');
  refs.sync(doc);
  const q = query.toLowerCase();
  const hits: string[] = [];
  let count = 0;
  for (const c of doc.document.components) {
    for (const line of blockText(c).split('\n')) {
      const lower = line.toLowerCase();
      for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) {
        count++;
        if (hits.length >= FIND_MAX_RESULTS) continue;
        const s = Math.max(0, at - FIND_CONTEXT_CHARS);
        const e = Math.min(line.length, at + q.length + FIND_CONTEXT_CHARS);
        hits.push(`${refs.refOf(c.id)}: ${s > 0 ? '…' : ''}${line.slice(s, e)}${e < line.length ? '…' : ''}`);
      }
    }
  }
  if (!count) return { text: `"${query}"를 찾지 못했습니다.`, count };
  const more = count > hits.length ? `\n(전체 ${count}건 중 ${hits.length}건만 표시)` : '';
  return { text: hits.join('\n') + more, count };
}

// ---------- 편집 연산 ----------

/** 넣거나 옮길 위치: 블록 뒤(after) 또는 앞(before). 묶음을 실행하기 전부터 있던 블록이어야 한다. */
export type Placement = { after: string; before?: never } | { before: string; after?: never };

/**
 * 편집 명령 하나. ref/after/before는 블록 참조(blsee://block/N)이며, 묶음 안에서 삽입/삭제/이동이 있어도 같은 블록을 가리킨다.
 * 에이전트가 직접 쓰지 않고, 서버가 작업을 이 명령으로 바꾼다.
 */
export type EditOp =
  | { op: 'replace_block'; ref: string; paragraphs: string[] }
  /** skipMissing: 찾지 못하거나 여러 곳이라 정할 수 없으면 실패하지 않고 건너뛴다 (점검 결과를 옮길 때, 그새 글이 바뀌었을 수 있다) */
  | { op: 'replace_text'; ref: string; find: string; replace: string; all?: boolean; skipMissing?: boolean }
  | ({
      op: 'insert_block';
      type: InsertableType;
      paragraphs?: string[];
      rows?: string[][];
      /** 표: 칸 서식까지 담은 행 (있으면 rows 대신 쓴다) */
      table?: TableRowSpec[];
      layout?: string;
      source?: string;
      /** 글자 크기(px), 문단·소제목·인용구만 */
      size?: number;
    } & Placement)
  | { op: 'set_layout'; ref: string; layout: string }
  | { op: 'set_quote_source'; ref: string; source: string }
  | { op: 'delete_block'; ref: string }
  | ({ op: 'move_block'; ref: string } & Placement)
  /** 블록을 서식까지 통째로 복제해 놓는다. */
  | ({ op: 'copy_block'; ref: string } & Placement)
  /** 표의 행 범위를 바꾼다 (행 번호는 원래 표 기준, 범위끼리 겹치지 않는다). */
  | { op: 'edit_table'; ref: string; changes: TableChange[] }
  | ({ op: 'insert_image'; image: string } & Placement)
  /** image: 넣을 이미지, target: 바꿀 이미지 (blsee://block/N/image[/k]) */
  | { op: 'replace_image'; target: string; image: string }
  /** 본문/소제목/인용구 사이에서 블록 종류를 바꾼다. line이 있으면 그 줄만 바꾸고 블록을 나눈다. */
  | { op: 'set_type'; ref: string; type: TextKind; line?: number }
  /** font: 글꼴 메뉴 이름, size: 글자 크기(px). find가 있으면 블록 안의 그 글자에만 */
  | { op: 'set_font'; ref: string; font?: string; size?: number; find?: string }
  /** 수식 블록을 넣는다. 수식 그림은 에디터에 쓰기 직전에 확장이 그려서 올린다. */
  | ({ op: 'insert_formula'; latex: string } & Placement)
  | { op: 'set_formula'; ref: string; latex: string }
  /**
   * 블씨 마크다운 단위로 블록을 쓴다. refs(문서 순서로 이어진 블록)가 있으면 그 범위를 단위대로 바꾸고
   * (안 바뀐 것은 그대로 둔다), 비어 있으면 after/before 위치에 새로 넣는다.
   */
  | ({ op: 'write_blocks'; refs: string[]; units: BlsUnit[] } & Partial<Placement>);

export const INSERTABLE_TYPES = [
  'text',
  'sectionTitle',
  'quotation',
  'horizontalLine',
  'code',
  'table',
] as const satisfies readonly InsertableType[];

/** 모델이 넘긴 명령에 그 종류에 필요한 필드가 있는지 확인한다. 틀리면 EditError를 던진다. */
export function checkFields(op: EditOp): void {
  const o = op as Record<string, unknown>;
  const need = (key: string, ok: (v: unknown) => boolean) => {
    if (!ok(o[key])) throw new EditError(`${op.op}에는 ${key}가 필요합니다.`);
  };
  const isRef = isBlockRef;
  const isStr = (v: unknown) => typeof v === 'string';
  const isArr = (v: unknown) => Array.isArray(v);
  const needPlace = () => {
    if ((o.after === undefined) === (o.before === undefined)) {
      throw new EditError(`${op.op}에는 after나 before 중 하나가 필요합니다.`);
    }
    need(o.after !== undefined ? 'after' : 'before', isRef);
  };
  const isImage = (v: unknown) => {
    const u = isStr(v) ? parseUri(v as string) : null;
    return u?.kind === 'image' || u?.kind === 'gen';
  };
  switch (op.op) {
    case 'replace_block':
      need('ref', isRef);
      need('paragraphs', isArr);
      break;
    case 'replace_text':
      need('ref', isRef);
      need('find', (v) => isStr(v) && (v as string).length > 0);
      need('replace', isStr);
      if (op.replace.includes('\n')) {
        throw new EditError('replace_text로는 문단을 나눌 수 없습니다. 줄을 바꾸려면 replace_block을 쓴다.');
      }
      break;
    case 'insert_block':
      needPlace();
      need('type', (v) => INSERTABLE_TYPES.includes(v as InsertableType));
      if (o.size !== undefined && !(FONT_SIZES as readonly number[]).includes(o.size as number)) {
        throw new EditError(`글자 크기는 ${FONT_SIZES.join(', ')} 중 하나여야 합니다.`);
      }
      if (o.table !== undefined) checkTableRows(o.table as TableRowSpec[]);
      break;
    case 'set_layout':
      need('ref', isRef);
      need('layout', isStr);
      break;
    case 'set_quote_source':
      need('ref', isRef);
      need('source', isStr);
      break;
    case 'delete_block':
      need('ref', isRef);
      break;
    case 'move_block':
    case 'copy_block':
      need('ref', isRef);
      needPlace();
      break;
    case 'edit_table':
      need('ref', isRef);
      need('changes', (v) => isArr(v) && (v as unknown[]).length > 0);
      for (const ch of op.changes) checkTableRows(ch.rows ?? []);
      break;
    case 'insert_image':
      needPlace();
      need('image', isImage);
      break;
    case 'replace_image':
      need('target', (v) => isStr(v) && parseUri(v as string)?.kind === 'image');
      need('image', isImage);
      break;
    case 'set_type':
      need('ref', isRef);
      need('type', (v) => TEXT_KINDS.includes(v as TextKind));
      if (o.line !== undefined) need('line', (v) => Number.isInteger(v) && (v as number) >= 1);
      break;
    case 'set_font':
      need('ref', isRef);
      if (o.font === undefined && o.size === undefined) throw new EditError('set_font에는 font나 size가 필요합니다.');
      if (o.font !== undefined && !fontByName(String(o.font))) {
        throw new EditError(`글꼴 "${o.font}"은 메뉴에 없습니다.`);
      }
      if (o.size !== undefined && !(FONT_SIZES as readonly number[]).includes(o.size as number)) {
        throw new EditError(`글자 크기는 ${FONT_SIZES.join(', ')} 중 하나여야 합니다.`);
      }
      if (o.find !== undefined) need('find', (v) => isStr(v) && (v as string).length > 0 && !(v as string).includes('\n'));
      break;
    case 'insert_formula':
      needPlace();
      need('latex', (v) => isStr(v) && (v as string).trim().length > 0);
      break;
    case 'set_formula':
      need('ref', isRef);
      need('latex', (v) => isStr(v) && (v as string).trim().length > 0);
      break;
    case 'write_blocks':
      need('refs', (v) => isArr(v) && (v as unknown[]).every(isRef));
      need('units', isArr);
      if (!op.refs.length) {
        needPlace();
        if (!op.units.length) throw new EditError('write_blocks로 넣을 글이 비었습니다.');
      }
      break;
    default:
      throw new EditError(`알 수 없는 명령입니다: ${(op as { op: string }).op}`);
  }
}

/** 문단의 글자 노드가 모두 같은 서식이면 그 서식을, 섞여 있으면 undefined를 돌려준다. */
function uniformTextStyle(p: SeParagraph): Record<string, unknown> | undefined {
  const styles = p.nodes
    .filter(isTextNode)
    .filter((n) => n.value)
    .map((n) => JSON.stringify(n.style ?? null));
  if (!styles.length || styles.some((s) => s !== styles[0])) return undefined;
  return JSON.parse(styles[0]) ?? undefined;
}

/**
 * 새 문단을 만든다. 같은 자리에 있던 기존 문단(template)의 문단 정렬과 (통일된) 글자 서식을 물려받고,
 * 텍스트 안의 {이미지} 자리에는 기존 문단들에서 빠진 인라인 노드를 순서대로 다시 넣는다.
 */
function buildParagraph(text: string, inlinePool: SeNode[], template?: SeParagraph): SeParagraph {
  const style = template ? uniformTextStyle(template) : undefined;
  const nodes: SeNode[] = [];
  text.split(INLINE_IMAGE_MARK).forEach((part, i) => {
    if (i > 0) {
      const inline = inlinePool.shift();
      if (inline) nodes.push(inline);
    }
    if (part) {
      nodes.push({
        id: newId(),
        value: part,
        ...(style ? { style: cloneJson(style) } : {}),
        '@ctype': 'textNode',
      });
    }
  });
  if (!nodes.length) nodes.push({ id: newId(), value: '', '@ctype': 'textNode' });
  return {
    id: newId(),
    nodes,
    ...(template?.style ? { style: cloneJson(template.style) } : {}),
    '@ctype': 'paragraph',
  };
}

/** 텍스트가 같은 문단은 기존 문단 객체(서식 포함)를 그대로 재사용한다. */
function reuseParagraphs(old: unknown, texts: string[]): SeParagraph[] {
  const olds = Array.isArray(old) ? (old as SeParagraph[]) : [];
  const used = new Set<number>();

  const reused = texts.map((t) => {
    const i = olds.findIndex((p, j) => !used.has(j) && paragraphText(p) === t);
    if (i < 0) return null;
    used.add(i);
    return olds[i];
  });

  const inlinePool = olds
    .filter((_, j) => !used.has(j))
    .flatMap((p) => p.nodes.filter((n) => !isTextNode(n)));

  return reused.map((p, i) => {
    if (p) return p;
    const template = olds[i] && !used.has(i) ? olds[i] : undefined;
    if (template) used.add(i);
    return buildParagraph(texts[i], inlinePool, template);
  });
}

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/** 블록 안의 모든 에디터 ID(SE-…)를 새로 붙인다. 에디터는 ID가 겹치면 블록을 하나로 본다. */
function withNewIds<T>(v: T): T {
  if (Array.isArray(v)) return v.map(withNewIds) as T;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const [k, val] of Object.entries(o)) {
      o[k] = k === 'id' && typeof val === 'string' && val.startsWith('SE-') ? newId() : withNewIds(val);
    }
  }
  return v;
}

/** 블록 하나의 내용/모양을 직접 고친다. 위치는 바꾸지 않는다. 결과 설명을 돌려준다. */
function editBlock(
  c: SeComponent,
  op: Extract<EditOp, { op: 'replace_block' | 'set_layout' | 'set_quote_source' | 'edit_table' }>,
): string {
  switch (op.op) {
    case 'replace_block': {
      switch (c['@ctype']) {
        case 'documentTitle':
          c.title = reuseParagraphs(c.title, [op.paragraphs.join(' ')]);
          break;
        case 'sectionTitle':
          c.title = reuseParagraphs(c.title, op.paragraphs);
          break;
        case 'text':
        case 'quotation':
          c.value = reuseParagraphs(c.value, op.paragraphs);
          break;
        case 'wrappingParagraph':
          c.text = reuseParagraphs(c.text, op.paragraphs);
          break;
        case 'code':
          c.codeContents = op.paragraphs.join('\n');
          break;
        default:
          throw new EditError(
            `${op.ref} ${typeLabel(c['@ctype'])} 블록은 replace_block으로 바꿀 수 없습니다.`,
          );
      }
      return `${op.ref} 내용을 바꿨습니다.`;
    }
    case 'set_layout': {
      c.layout = checkLayout(c['@ctype'], op.layout);
      return `${op.ref} 모양을 ${c.layout}(으)로 바꿨습니다.`;
    }
    case 'set_quote_source': {
      if (c['@ctype'] !== 'quotation') throw new EditError(`${op.ref}는 인용구가 아닙니다.`);
      c.source = op.source ? reuseParagraphs(c.source, [op.source]) : null;
      return `${op.ref} 인용구 출처를 ${op.source ? '바꿨' : '지웠'}습니다.`;
    }
    case 'edit_table': {
      if (c['@ctype'] !== 'table') throw new EditError(`${op.ref}는 표가 아닙니다.`);
      try {
        applyTableChanges(c, op.changes);
      } catch (err) {
        if (err instanceof EditError) throw new EditError(`${op.ref}: ${err.message}`);
        throw err;
      }
      const rows = (c.rows as SeTableRow[]).length;
      return `${op.ref} 표를 고쳤습니다 (${rows}행 ${c.columnCount}열).`;
    }
  }
}

// ---------- 글자 치환 ----------

function countOf(text: string, find: string): number {
  return text.split(find).length - 1;
}

/** 블록 안에서 글이 들어 있는 문단 목록들 (제목, 본문, 인용구 출처, 캡션, 표 칸) */
function paragraphLists(c: SeComponent): SeParagraph[][] {
  const lists: unknown[] = [];
  switch (c['@ctype']) {
    case 'documentTitle':
    case 'sectionTitle':
      lists.push(c.title);
      break;
    case 'text':
      lists.push(c.value);
      break;
    case 'quotation':
      lists.push(c.value, c.source);
      break;
    case 'wrappingParagraph':
      lists.push(c.text);
      break;
    case 'image':
      lists.push(c.caption);
      break;
    case 'table':
      for (const r of (c.rows as SeTableRow[]) ?? []) for (const cell of r.cells) lists.push(cell.value);
      break;
  }
  return lists.filter(Array.isArray) as SeParagraph[][];
}

function countInBlock(c: SeComponent, find: string): number {
  if (c['@ctype'] === 'code') return countOf(String(c.codeContents ?? ''), find);
  return paragraphLists(c)
    .flat()
    .reduce((n, p) => n + countOf(paragraphText(p), find), 0);
}

/**
 * 블록 안의 find를 모두 replace로 바꾼다. 찾은 글자가 글자 노드 하나 안에 있으면 그 노드만 고쳐서
 * 굵게/색 같은 서식을 지키고, 서식 경계에 걸쳐 있으면 그 문단만 다시 만든다.
 */
function replaceInBlock(c: SeComponent, find: string, replace: string): void {
  if (c['@ctype'] === 'code') {
    c.codeContents = String(c.codeContents ?? '').split(find).join(replace);
    return;
  }
  for (const list of paragraphLists(c)) {
    list.forEach((p, i) => {
      const total = countOf(paragraphText(p), find);
      if (!total) return;
      const textNodes = p.nodes.filter(isTextNode);
      if (textNodes.reduce((n, t) => n + countOf(t.value, find), 0) === total) {
        for (const t of textNodes) t.value = t.value.split(find).join(replace);
      } else {
        list[i] = reuseParagraphs([p], [paragraphText(p).split(find).join(replace)])[0];
      }
    });
  }
}

// ---------- 글 종류, 글꼴 ----------

function withoutFontSize(ps: SeParagraph[]): SeParagraph[] {
  for (const p of ps) {
    for (const n of p.nodes) {
      if (isTextNode(n) && n.style) delete n.style.fontSizeCode;
    }
  }
  return ps;
}

/** 문단 목록으로 kind 블록을 만든다. 소제목은 크기가 따로 정해져 있어서, 소제목으로/에서 바꿀 때는 글자 크기 지정을 지운다. */
function textBlock(id: string, kind: TextKind, paras: SeParagraph[], from: string): SeComponent {
  const ps = kind === 'sectionTitle' || from === 'sectionTitle' ? withoutFontSize(paras) : paras;
  switch (kind) {
    case 'text':
      return { id, layout: 'default', value: ps, '@ctype': 'text' };
    case 'sectionTitle':
      return { id, layout: 'default', title: ps, '@ctype': 'sectionTitle' };
    case 'quotation':
      return { id, layout: 'default', value: ps, source: null, '@ctype': 'quotation' };
  }
}

/**
 * 블록 종류를 바꾼 블록들을 돌려준다. line이 있으면 그 줄(문단)만 바꾸고, 앞뒤 줄은 원래 종류의 블록으로 나눈다.
 * 바뀐 블록은 원래 id(=참조)를 이어받는다.
 */
function convertBlock(c: SeComponent, kind: TextKind, line?: number): SeComponent[] {
  const from = c['@ctype'];
  if (!(TEXT_KINDS as readonly string[]).includes(from)) {
    throw new EditError(`${typeLabel(from)} 블록은 종류를 바꿀 수 없습니다 (본문·소제목·인용구만).`);
  }
  const paras = cloneJson(mainParagraphs(c));
  if (line === undefined || paras.length <= 1) return [textBlock(c.id, kind, paras, from)];
  if (line < 1 || line > paras.length) throw new EditError(`line은 1~${paras.length} 사이여야 합니다.`);
  const keep = (ps: SeParagraph[]) => (ps.length ? [textBlock(newId(), from as TextKind, ps, from)] : []);
  return [
    ...keep(paras.slice(0, line - 1)),
    textBlock(c.id, kind, [paras[line - 1]], from),
    ...keep(paras.slice(line)),
  ];
}

function fontStyle(op: Extract<EditOp, { op: 'set_font' }>, old?: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(old ?? {}),
    ...(op.font !== undefined ? { fontFamily: fontByName(op.font)!.code } : {}),
    ...(op.size !== undefined ? { fontSizeCode: `fs${op.size}` } : {}),
    '@ctype': 'nodeStyle',
  };
}

/** 블록의 글자(find가 있으면 그 글자만)에 글꼴·크기를 지정한다. 바꾼 곳 수를 돌려준다. */
function setFont(c: SeComponent, op: Extract<EditOp, { op: 'set_font' }>): number {
  const lists = paragraphLists(c);
  if (!lists.length) throw new EditError(`${typeLabel(c['@ctype'])} 블록은 글꼴을 바꿀 수 없습니다.`);
  let count = 0;
  for (const p of lists.flat()) {
    const texts = p.nodes.filter(isTextNode);
    if (op.find === undefined) {
      for (const n of texts) n.style = fontStyle(op, n.style);
      count += texts.length ? 1 : 0;
      continue;
    }
    const find = op.find;
    const total = countOf(paragraphText(p), find);
    if (!total) continue;
    if (texts.reduce((k, n) => k + countOf(n.value, find), 0) !== total) {
      throw new EditError(`"${find}"가 서식이 다른 글자에 걸쳐 있습니다. 더 짧게 찾거나 블록 전체에 지정한다.`);
    }
    p.nodes = p.nodes.flatMap((n) => {
      if (!isTextNode(n) || !n.value.includes(find)) return [n];
      const parts = n.value.split(find);
      const out: SeNode[] = [];
      parts.forEach((part, i) => {
        if (part) out.push({ ...cloneJson(n), id: out.length ? newId() : n.id, value: part });
        if (i < parts.length - 1) {
          out.push({ ...cloneJson(n), id: out.length ? newId() : n.id, value: find, style: fontStyle(op, n.style) });
        }
      });
      return out;
    });
    count += total;
  }
  if (op.find !== undefined && !count) throw new EditError(`"${op.find}"를 ${op.ref}에서 찾지 못했습니다.`);
  return count;
}

function fontChange(op: Extract<EditOp, { op: 'set_font' }>): string {
  return [op.font, op.size !== undefined ? `${op.size}` : ''].filter(Boolean).join(' ');
}

// ---------- 묶음 적용 ----------

export interface BatchResult {
  document: SeDocumentData;
  /** 명령별 결과 설명 (명령 순서와 같다) */
  messages: string[];
}

/**
 * 편집 명령 묶음을 트랜잭션으로 적용한다. doc은 건드리지 않고 고친 사본을 돌려준다.
 * 새로 만든 블록에는 refs에 새 참조가 붙는다.
 * 명령 하나라도 실패하면 EditError를 던지고, 그때까지 고친 내용은 모두 버려진다.
 */
export interface BatchOptions {
  /** 만든 이미지에 반드시 달 캡션 (웹 이미지의 출처). 있으면 넣거나 바꿀 때 원래 캡션 대신 이것을 단다. */
  genCaption?: (id: string) => string | undefined;
  /** AI로 만든 이미지인지. 맞으면 에디터의 "AI 활용" 표시(ai: true)를 켠다. */
  genAi?: (id: string) => boolean;
}

export function applyBatch(
  doc: SeDocumentData,
  ops: EditOp[],
  refs: BlockRefs,
  options: BatchOptions = {},
): BatchResult {
  if (!ops.length) throw new EditError('operations가 비어 있습니다.');
  refs.sync(doc);

  const draft = cloneDoc(doc);
  const comps = draft.document.components;
  const originalIds = new Set(comps.map((c) => c.id));
  const deleted = new Set<string>();
  /** 원래 블록 id → 같은 묶음에서 그 뒤에 마지막으로 놓은 블록 id (여러 개를 넣어도 명령 순서대로 쌓이게) */
  const tails = new Map<string, string>();
  /** 원래 블록 id → 같은 묶음에서 그 앞에 마지막으로 놓은 블록 id */
  const heads = new Map<string, string>();

  const posOf = (id: string) => comps.findIndex((c) => c.id === id);
  const idOf = (ref: string): string => {
    const id = refs.idOf(ref);
    if (!id || !originalIds.has(id)) throw new EditError(`${ref}: 문서에 없는 블록입니다.`);
    if (deleted.has(id)) throw new EditError(`${ref}는 이 묶음에서 이미 지운 블록입니다.`);
    return id;
  };
  const blockOf = (ref: string) => comps[posOf(idOf(ref))];

  const detach = (c: SeComponent) => {
    comps.splice(posOf(c.id), 1);
    for (const [anchor, tail] of tails) if (tail === c.id) tails.delete(anchor);
    for (const [anchor, head] of heads) if (head === c.id) heads.delete(anchor);
  };
  /** 위치에 블록을 놓고 "… 뒤에" / "… 앞에"를 돌려준다. 같은 자리에 여러 개를 놓으면 명령 순서대로 이어진다. */
  const place = (at: Placement, c: SeComponent): string => {
    if (at.after !== undefined) {
      const anchorId = idOf(at.after);
      const tail = tails.get(anchorId);
      comps.splice(posOf(tail && posOf(tail) >= 0 ? tail : anchorId) + 1, 0, c);
      tails.set(anchorId, c.id);
      return `${at.after} 뒤에`;
    }
    const anchorId = idOf(at.before);
    if (comps[posOf(anchorId)]['@ctype'] === 'documentTitle') throw new EditError('제목 블록 앞에는 놓을 수 없습니다.');
    const head = heads.get(anchorId);
    comps.splice(head && posOf(head) >= 0 ? posOf(head) + 1 : posOf(anchorId), 0, c);
    heads.set(anchorId, c.id);
    return `${at.before} 앞에`;
  };
  const anchorOf = (at: Placement) => at.after ?? at.before;

  const replaceText = (op: Extract<EditOp, { op: 'replace_text' }>): string => {
    const c = blockOf(op.ref);
    const total = countInBlock(c, op.find);
    if (!total && op.skipMissing) return `${op.ref}에서 "${op.find}"를 찾지 못해 건너뛰었습니다.`;
    if (total > 1 && !op.all && op.skipMissing) return `${op.ref}에 "${op.find}"가 ${total}곳 있어 어느 곳인지 몰라 건너뛰었습니다.`;
    if (!total) throw new EditError(`"${op.find}"를 ${op.ref}에서 찾지 못했습니다.`);
    if (total > 1 && !op.all) {
      const contexts = blockText(c)
        .split('\n')
        .filter((l) => l.includes(op.find))
        .slice(0, 5)
        .map((l) => `- ${l.slice(0, 80)}`);
      throw new EditError(
        `"${op.find}"가 ${op.ref}에 ${total}곳 있습니다.\n${contexts.join('\n')}\n` +
          '한 곳만 바꾸려면 앞뒤 글자를 더 넣어 find가 한 곳에만 맞게 쓴다.',
      );
    }
    replaceInBlock(c, op.find, op.replace);
    return `${op.ref}에서 "${op.find}"를 ${total}곳 바꿨습니다.`;
  };

  /** 넣을 이미지 블록을 만든다. lib/만든 이미지는 대기 자리로, 문서에 있던 이미지는 복사한다. */
  const imageComponent = (uri: string, id: string): SeComponent => {
    const parsed = parseUri(uri);
    if (parsed?.kind !== 'gen' && parsed?.kind !== 'image') throw new EditError(`${uri}: 이미지 URI가 아닙니다.`);
    if (parsed.kind === 'gen') {
      const caption = options.genCaption?.(parsed.id);
      return {
        id,
        layout: 'default',
        align: 'center',
        '@ctype': 'image',
        [PENDING_IMAGE_KEY]: genImageUri(parsed.id),
        ai: options.genAi?.(parsed.id) ?? false,
        ...(caption ? { caption: caption.split('\n').map(makeParagraph) } : {}),
      };
    }
    const img = findBlockImage(draft, refs, parsed);
    if (typeof img[PENDING_IMAGE_KEY] === 'string') {
      return { id, layout: 'default', align: 'center', '@ctype': 'image', [PENDING_IMAGE_KEY]: img[PENDING_IMAGE_KEY] };
    }
    if (img['@ctype'] !== 'image') {
      throw new EditError(`${uri}: 글자처럼 배치된 이미지는 블록으로 복사할 수 없습니다.`);
    }
    const copy = { ...cloneJson(img), id, '@ctype': 'image' } as SeComponent;
    // 묶음 안 이미지를 꺼내면 묶음 전용 폭 비율은 버리고 원래 크기로 둔다.
    delete copy.widthPercentage;
    return copy;
  };

  const label = (c: SeComponent) => `${refs.refOf(c.id)} ${typeLabel(c['@ctype'])}${originalIds.has(c.id) ? '' : '(새 블록)'}`;
  const writeBlocks = (op: Extract<EditOp, { op: 'write_blocks' }>): string => {
    const ctx = { makeImage: imageComponent };
    if (!op.refs.length) {
      const { blocks } = rebuildBlocks([], [], op.units, ctx);
      let where = '';
      for (const c of blocks) where = place(op as Placement, c);
      return `${where} 블록 ${blocks.length}개를 넣었습니다: ${blocks.map(label).join(', ')}`;
    }
    const old = op.refs.map(blockOf);
    const at = posOf(old[0].id);
    old.forEach((c, i) => {
      if (posOf(c.id) !== at + i) throw new EditError(`${op.refs.join(', ')}는 문서에서 이어진 범위가 아닙니다.`);
    });
    const { blocks, removed } = rebuildBlocks(old, op.refs, op.units, ctx);
    for (const c of old) detach(c);
    comps.splice(at, 0, ...blocks);
    for (const c of removed) deleted.add(c.id);
    const range = op.refs.length > 1 ? `${op.refs[0]}~${op.refs[op.refs.length - 1]}` : op.refs[0];
    const gone = removed.length ? ` (지운 블록: ${removed.map((c) => op.refs[old.indexOf(c)]).join(', ')})` : '';
    return `${range}를 고쳤습니다. 지금 블록: ${blocks.map(label).join(', ') || '없음'}${gone}`;
  };

  const applyOne = (op: EditOp): string => {
    checkFields(op);
    switch (op.op) {
      case 'insert_image': {
        const c = imageComponent(op.image, newId());
        return `${place(op, c)} 이미지 블록 ${refs.refOf(c.id)}(${op.image})를 넣었습니다.`;
      }
      case 'replace_image': {
        const t = parseUri(op.target) as Extract<DocUri, { kind: 'image' }>;
        const old = blockOf(t.ref);
        if (old['@ctype'] === 'imageStrip') {
          const imgs = (old.images as SeComponent[]) ?? [];
          const i = t.index - 1;
          if (!imgs[i]) throw new EditError(`${t.ref}는 이미지 ${imgs.length}장 묶음입니다. ${blockImageUri(t.ref, 1)}처럼 몇 번째인지 가리킨다.`);
          const next = imageComponent(op.image, imgs[i].id);
          imgs[i] = stripImage(next, imgs[i]);
          if (next.caption !== undefined) imgs[i].caption = next.caption;
          if (next.ai !== undefined) imgs[i].ai = next.ai;
          fitStrip(old);
          return `${op.target}를 ${op.image}(으)로 바꿨습니다.`;
        }
        if (old['@ctype'] !== 'image') throw new EditError(`${t.ref}는 이미지 블록이나 이미지 묶음이 아닙니다.`);
        const c = imageComponent(op.image, old.id);
        if (old.caption !== undefined && c.caption === undefined) c.caption = cloneJson(old.caption);
        if (old.align !== undefined) c.align = old.align;
        comps[posOf(old.id)] = c;
        return `${op.target}를 ${op.image}(으)로 바꿨습니다.`;
      }
      case 'insert_block': {
        const c = makeComponent(op.type, op);
        return `${place(op, c)} ${typeLabel(op.type)} 블록 ${refs.refOf(c.id)}를 넣었습니다.`;
      }
      case 'delete_block': {
        const c = blockOf(op.ref);
        if (c['@ctype'] === 'documentTitle') throw new EditError('제목 블록은 지울 수 없습니다.');
        detach(c);
        deleted.add(c.id);
        return `${op.ref} 블록을 지웠습니다.`;
      }
      case 'move_block': {
        const c = blockOf(op.ref);
        if (c['@ctype'] === 'documentTitle') throw new EditError('제목 블록은 옮길 수 없습니다.');
        if (op.ref === anchorOf(op)) throw new EditError('블록을 자기 자신 옆으로 옮길 수 없습니다.');
        detach(c);
        return `${op.ref} 블록을 ${place(op, c)} 옮겼습니다.`;
      }
      case 'copy_block': {
        const src = blockOf(op.ref);
        if (src['@ctype'] === 'documentTitle') throw new EditError('제목 블록은 복사할 수 없습니다.');
        const c = withNewIds(cloneJson(src));
        return `${op.ref} 블록을 복사해 ${place(op, c)} ${refs.refOf(c.id)}로 넣었습니다.`;
      }
      case 'replace_text':
        return replaceText(op);
      case 'set_type': {
        const old = blockOf(op.ref);
        if (old['@ctype'] === op.type) return `${op.ref}는 이미 ${typeLabel(op.type)}입니다.`;
        const lost = old['@ctype'] === 'quotation' && paragraphsText(old.source).join('').trim() ? ' (인용구 출처는 지웠습니다)' : '';
        const blocks = convertBlock(old, op.type, op.line);
        comps.splice(posOf(old.id), 1, ...blocks);
        const parts = blocks.map((b) => `${refs.refOf(b.id)} ${typeLabel(b['@ctype'])}`).join(', ');
        return blocks.length > 1
          ? `${op.ref}의 ${op.line}번째 줄을 ${typeLabel(op.type)}(으)로 바꾸고 블록을 나눴습니다: ${parts}${lost}`
          : `${op.ref}를 ${typeLabel(op.type)}(으)로 바꿨습니다${lost}.`;
      }
      case 'set_font': {
        const n = setFont(blockOf(op.ref), op);
        return op.find !== undefined
          ? `${op.ref}의 "${op.find}" ${n}곳을 ${fontChange(op)}(으)로 바꿨습니다.`
          : `${op.ref} 글자를 ${fontChange(op)}(으)로 바꿨습니다.`;
      }
      case 'insert_formula': {
        const c: SeComponent = {
          id: newId(),
          layout: 'default',
          latex: op.latex,
          fontSizeCode: 'fs15',
          fontFamily: 'system',
          '@ctype': 'formula',
          [PENDING_FORMULA_KEY]: true,
        };
        return `${place(op, c)} 수식 블록 ${refs.refOf(c.id)}를 넣었습니다.`;
      }
      case 'write_blocks':
        return writeBlocks(op);
      case 'set_formula': {
        const c = blockOf(op.ref);
        if (c['@ctype'] !== 'formula') throw new EditError(`${op.ref}는 수식 블록이 아닙니다.`);
        if (c.latex === op.latex) return `${op.ref} 수식이 이미 같습니다.`;
        c.latex = op.latex;
        c[PENDING_FORMULA_KEY] = true;
        return `${op.ref} 수식을 바꿨습니다.`;
      }
      default:
        return editBlock(blockOf(op.ref), op);
    }
  };

  const messages = ops.map((op, i) => {
    try {
      return applyOne(op);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new EditError(`${i + 1}번째 명령(${op.op}) 실패: ${reason}`);
    }
  });

  return { document: draft, messages };
}

// ---------- 변경 비교 ----------

export interface BlockChange {
  kind: 'added' | 'removed' | 'modified' | 'moved';
  type: string;
  before?: string;
  after?: string;
  /** 변경 후 문서 기준 위치 (removed는 변경 전 위치) */
  index: number;
}

export function diffDocuments(before: SeDocumentData, after: SeDocumentData): BlockChange[] {
  const beforeComps = before.document.components;
  const afterComps = after.document.components;
  const beforeById = new Map(beforeComps.map((c, i) => [c.id, { c, i }]));
  const afterIds = new Set(afterComps.map((c) => c.id));
  const changes: BlockChange[] = [];

  const moved = findMoved(
    beforeComps.filter((c) => afterIds.has(c.id)).map((c) => c.id),
    afterComps.filter((c) => beforeById.has(c.id)).map((c) => c.id),
  );

  afterComps.forEach((c, i) => {
    const prev = beforeById.get(c.id);
    if (!prev) {
      changes.push({ kind: 'added', type: c['@ctype'], after: blockText(c), index: i });
      return;
    }
    if (JSON.stringify(prev.c) !== JSON.stringify(c)) {
      changes.push({
        kind: 'modified',
        type: c['@ctype'],
        before: blockText(prev.c),
        after: blockText(c),
        index: i,
      });
    } else if (moved.has(c.id)) {
      changes.push({ kind: 'moved', type: c['@ctype'], after: blockText(c), index: i });
    }
  });

  beforeComps.forEach((c, i) => {
    if (!afterIds.has(c.id)) {
      changes.push({ kind: 'removed', type: c['@ctype'], before: blockText(c), index: i });
    }
  });

  return changes;
}

/** 순서가 유지된 최장 부분열(LIS)에 속하지 않는 블록을 "이동"으로 본다. */
function findMoved(beforeOrder: string[], afterOrder: string[]): Set<string> {
  const pos = new Map(beforeOrder.map((id, i) => [id, i]));
  const seq = afterOrder.map((id) => pos.get(id)!);

  const tails: number[] = [];
  const tailIdx: number[] = [];
  const prev: number[] = new Array(seq.length).fill(-1);
  seq.forEach((v, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = v;
    tailIdx[lo] = i;
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
  });

  const inLis = new Set<number>();
  for (let i = tailIdx[tails.length - 1] ?? -1; i >= 0; i = prev[i]) inLis.add(i);
  return new Set(afterOrder.filter((_, i) => !inLis.has(i)));
}

export function cloneDoc(doc: SeDocumentData): SeDocumentData {
  return cloneJson(doc);
}

export { renderHtml, imageSources, RENDER_WIDTH, PENDING_IMAGE_KEY, type RenderOptions } from './render';

// ---------- 이미지 URI ----------

/** 이미지를 가리키는 URI (블록 이미지 또는 만든 이미지). 바이트나 네이버 이미지 주소는 에이전트에게 주지 않는다. */
export type ImageUri = Extract<DocUri, { kind: 'image' | 'gen' }>;

export function parseImageUri(uri: string): ImageUri | null {
  const u = parseUri(uri);
  return u?.kind === 'image' || u?.kind === 'gen' ? u : null;
}

const GEN_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const GEN_ID_LENGTH = 8;

/** 보관할 이미지의 새 ID (영소문자·숫자 8자, 라이브러리 전체에서 겹치지 않을 만큼). taken에 있는 ID는 피한다. */
export function newGenImageId(taken: ReadonlySet<string> = new Set()): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(GEN_ID_LENGTH));
    const id = [...bytes].map((b) => GEN_ID_CHARS[b % GEN_ID_CHARS.length]).join('');
    if (!taken.has(id)) return id;
  }
}

/** 블록 안의 이미지 객체들 (문서 순서). 이미지 컴포넌트, 묶음 안 이미지, 감싸기 이미지, 인라인 imageNode. */
export function blockImages(c: SeComponent): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const t = o['@ctype'];
      if ((t === 'image' || t === 'imageNode') && (typeof o.src === 'string' || typeof o[PENDING_IMAGE_KEY] === 'string')) {
        out.push(o);
        return;
      }
      Object.values(o).forEach(walk);
    }
  };
  walk(c);
  return out;
}

function imageUrisOf(c: SeComponent, ref: string): string {
  const imgs = blockImages(c);
  if (!imgs.length) return '';
  const uris = imgs.map((img, i) => {
    const pending = img[PENDING_IMAGE_KEY];
    if (typeof pending === 'string') return `${pending}(넣기 대기)`;
    return blockImageUri(ref, imgs.length === 1 ? undefined : i + 1);
  });
  return ` [${uris.join(', ')}]`;
}

/** 블록 이미지 URI가 가리키는 이미지 객체. */
export function findBlockImage(
  doc: SeDocumentData,
  refs: BlockRefs,
  uri: Extract<ImageUri, { kind: 'image' }>,
): Record<string, unknown> {
  const c = doc.document.components[findByRef(doc, refs, uri.ref)];
  const img = blockImages(c)[uri.index - 1];
  if (!img) throw new EditError(`${blockImageUri(uri.ref, uri.index)}: 이미지가 없습니다.`);
  return img;
}

/** 그림을 다시 그려 올려야 하는 수식 블록 표시. 에디터는 latex가 아니라 html·thumbnail 그림을 보여 준다. */
export const PENDING_FORMULA_KEY = '__pendingFormula';

export function pendingFormulas(doc: SeDocumentData): { id: string; latex: string }[] {
  return doc.document.components.flatMap((c) =>
    c[PENDING_FORMULA_KEY] ? [{ id: c.id, latex: String(c.latex ?? '') }] : [],
  );
}

/** 올린 수식 그림으로 대기 중인 수식 블록을 채운다. */
export function fillPendingFormula(
  doc: SeDocumentData,
  id: string,
  rendered: { html: string; thumbnail: Record<string, unknown> },
): SeDocumentData {
  const draft = cloneDoc(doc);
  const c = draft.document.components.find((x) => x.id === id);
  if (!c) throw new EditError(`수식 블록 ${id}가 없습니다.`);
  c.html = rendered.html;
  c.thumbnail = rendered.thumbnail;
  delete c[PENDING_FORMULA_KEY];
  return draft;
}

/** 넣기 대기 중인 이미지 자리들 (이미지 블록, 또는 묶음 안 이미지) */
export function pendingImages(doc: SeDocumentData): { id: string; uri: string }[] {
  return doc.document.components.flatMap((c) =>
    [c, ...((c['@ctype'] === 'imageStrip' ? c.images : []) as SeComponent[])].flatMap((x) =>
      typeof x[PENDING_IMAGE_KEY] === 'string' ? [{ id: x.id, uri: x[PENDING_IMAGE_KEY] as string }] : [],
    ),
  );
}

/**
 * 묶음 안 자리(slot)에 들어갈 이미지로 맞춘다. 자리의 id, 캡션, 폭 비율을 물려받고,
 * 높이는 새 이미지 비율로 다시 잡는다 (대기 이미지는 크기를 모르므로 자리 크기를 그대로 둔다).
 */
function stripImage(img: SeComponent, slot: SeComponent): SeComponent {
  const out: SeComponent = { ...img, id: slot.id };
  for (const key of ['caption', 'align', 'widthPercentage', 'layout']) {
    if (slot[key] !== undefined) out[key] = cloneJson(slot[key]);
  }
  const ow = Number(img.originalWidth ?? img.width);
  const oh = Number(img.originalHeight ?? img.height);
  const w = Number(slot.width);
  if (w && ow && oh) {
    out.width = w;
    out.height = Math.round((w * oh) / ow);
  } else if (slot.width !== undefined) {
    out.width = slot.width;
    out.height = slot.height;
  }
  return out;
}

/**
 * 업로드된 이미지 컴포넌트로 대기 자리를 바꾼다. 자리의 id(=참조)와 캡션/정렬을 물려받는다.
 * 묶음 안 자리면 묶음 안의 그 이미지만 바꾼다.
 */
export function fillPendingImage(doc: SeDocumentData, id: string, uploaded: SeComponent): SeDocumentData {
  const draft = cloneDoc(doc);
  const comps = draft.document.components;
  const i = comps.findIndex((c) => c.id === id);
  if (i >= 0) {
    const slot = comps[i];
    comps[i] = {
      ...cloneJson(uploaded),
      id,
      ...(slot.caption !== undefined ? { caption: slot.caption } : {}),
      ...(slot.align !== undefined ? { align: slot.align } : {}),
      ...(typeof slot.ai === 'boolean' ? { ai: slot.ai } : {}),
    };
    return draft;
  }
  for (const c of comps) {
    if (c['@ctype'] !== 'imageStrip') continue;
    const imgs = c.images as SeComponent[];
    const k = imgs.findIndex((x) => x.id === id);
    if (k >= 0) {
      const slot = imgs[k];
      imgs[k] = stripImage(cloneJson(uploaded), slot);
      if (typeof slot.ai === 'boolean') imgs[k].ai = slot.ai;
      fitStrip(c);
      return draft;
    }
  }
  throw new EditError('넣을 이미지 자리가 문서에 없습니다.');
}
