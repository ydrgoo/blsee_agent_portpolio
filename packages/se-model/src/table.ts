/**
 * 표를 AI에게 HTML로 보여 주고, AI가 행 단위로 고친 내용(TableChange)을 표에 적용한다.
 * HTML에는 병합, 칸 배경색, 문단 정렬, 굵게·기울임·밑줄·취소선·글자색만 담는다.
 * 글꼴·크기·칸 높이처럼 HTML에 없는 값은 같은 자리(새 칸이면 이웃) 칸에서 물려받는다.
 */
import {
  EditError,
  INLINE_IMAGE_MARK,
  newId,
  type SeComponent,
  type SeNode,
  type SeParagraph,
  type SeTableCell,
  type SeTableRow,
  type SeTextNode,
} from './index';

export interface TableRun {
  text: string;
  bold?: true;
  italic?: true;
  underline?: true;
  strike?: true;
  /** 글자색 #rrggbb. 없으면 표의 기본 글자색 */
  color?: string;
}

export interface TableParagraph {
  runs: TableRun[];
  align?: 'center' | 'right' | 'justify';
}

export interface TableCellSpec {
  paragraphs: TableParagraph[];
  colSpan?: number;
  rowSpan?: number;
  /** 칸 배경색 #rrggbb. 없으면 배경색 없음 */
  background?: string;
}

export type TableRowSpec = TableCellSpec[];

/** 원래 표의 start번째 행(1부터)부터 delete개 행을 지우고 그 자리에 rows를 넣는다. */
export interface TableChange {
  start: number;
  delete: number;
  rows: TableRowSpec[];
}

export const HEX_COLOR = /^#[0-9a-f]{6}$/;
const ALIGNS = new Set(['center', 'right', 'justify']);
const FLAG_KEYS = ['bold', 'italic', 'underline', 'strike'] as const;

const isTextNode = (n: SeNode): n is SeTextNode => n['@ctype'] === 'textNode';
const cloneJson = <T>(v: T): T => JSON.parse(JSON.stringify(v));

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

const rowsOf = (c: SeComponent) => (c.rows as SeTableRow[] | undefined) ?? [];
const paragraphsOf = (cell: SeTableCell) => cell.value ?? [];

/** 표에서 가장 많이 쓴 글자색 (색을 안 쓴 글자가 가장 많으면 undefined). HTML에서는 이 색을 생략한다. */
function baseColor(c: SeComponent): string | undefined {
  const counts = new Map<string, number>();
  for (const r of rowsOf(c)) {
    for (const cell of r.cells) {
      for (const p of paragraphsOf(cell)) {
        for (const n of p.nodes) {
          if (!isTextNode(n) || !n.value) continue;
          const color = String(n.style?.fontColor ?? '');
          counts.set(color, (counts.get(color) ?? 0) + n.value.length);
        }
      }
    }
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return top || undefined;
}

/* ---------- 읽기: 표 → HTML ---------- */

function runOf(n: SeNode, base: string | undefined): TableRun {
  if (!isTextNode(n)) return { text: n['@ctype'] === 'imageNode' ? INLINE_IMAGE_MARK : `{${n['@ctype']}}` };
  const s = n.style ?? {};
  const color = String(s.fontColor ?? '').toLowerCase();
  return {
    text: n.value,
    ...(s.bold ? { bold: true } : {}),
    ...(s.italic ? { italic: true } : {}),
    ...(s.underline ? { underline: true } : {}),
    ...(s.strikethrough ? { strike: true } : {}),
    ...(color && color !== base?.toLowerCase() ? { color } : {}),
  };
}

const sameFlags = (a: TableRun, b: TableRun) => FLAG_KEYS.every((k) => a[k] === b[k]) && a.color === b.color;

/** 빈 글자를 빼고, 서식이 같은 이웃 글자를 합친다. */
export function normalizeRuns(runs: TableRun[]): TableRun[] {
  const out: TableRun[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = out.at(-1);
    if (last && sameFlags(last, r)) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

function paragraphOf(p: SeParagraph, base: string | undefined): TableParagraph {
  const align = String(p.style?.align ?? '');
  return { runs: normalizeRuns(p.nodes.map((n) => runOf(n, base))), ...(ALIGNS.has(align) ? { align: align as TableParagraph['align'] } : {}) };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function runHtml(r: TableRun): string {
  let html = esc(r.text);
  if (r.color) html = `<span style="color:${r.color}">${html}</span>`;
  if (r.strike) html = `<s>${html}</s>`;
  if (r.underline) html = `<u>${html}</u>`;
  if (r.italic) html = `<i>${html}</i>`;
  if (r.bold) html = `<b>${html}</b>`;
  return html;
}

function cellHtml(cell: SeTableCell, base: string | undefined): string {
  const ps = paragraphsOf(cell).map((p) => paragraphOf(p, base));
  const attrs = [
    cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : '',
    cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : '',
    cell.backgroundColor ? ` style="background:${cell.backgroundColor}"` : '',
  ];
  let inner: string;
  if (ps.length === 1) {
    if (ps[0].align) attrs.push(` align="${ps[0].align}"`);
    inner = ps[0].runs.map(runHtml).join('');
  } else {
    inner = ps.map((p) => `<p${p.align ? ` align="${p.align}"` : ''}>${p.runs.map(runHtml).join('')}</p>`).join('');
  }
  return `<td${attrs.join('')}>${inner}</td>`;
}

/** AI가 읽는 표 HTML. data-row는 행 번호(1부터)로, 고칠 때 이 번호로 행을 가리킨다. */
export function tableMarkup(c: SeComponent): string {
  const base = baseColor(c);
  const rows = rowsOf(c).map((r, i) => `<tr data-row="${i + 1}">${r.cells.map((cell) => cellHtml(cell, base)).join('')}</tr>`);
  return `<table>\n${rows.join('\n')}\n</table>`;
}

/* ---------- 쓰기: 행 변경 → 표 ---------- */

/** 칸에서 가장 많이 쓴 글자 서식 (글꼴·크기 등을 새 글자에 물려준다) */
function cellTextStyle(cell: SeTableCell | undefined): Record<string, unknown> {
  const counts = new Map<string, number>();
  for (const p of cell ? paragraphsOf(cell) : []) {
    for (const n of p.nodes) {
      if (!isTextNode(n) || !n.value) continue;
      const key = JSON.stringify(n.style ?? {});
      counts.set(key, (counts.get(key) ?? 0) + n.value.length);
    }
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return top ? JSON.parse(top) : {};
}

function nodeStyle(base: Record<string, unknown>, run: TableRun, color: string | undefined): Record<string, unknown> | undefined {
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

function buildParagraph(spec: TableParagraph, old: SeParagraph | undefined, textStyle: Record<string, unknown>, color: string | undefined): SeParagraph {
  const nodes: SeNode[] = spec.runs.map((r) => {
    const style = nodeStyle(textStyle, r, color);
    return { id: newId(), value: r.text, ...(style ? { style } : {}), '@ctype': 'textNode' };
  });
  if (!nodes.length) nodes.push({ id: newId(), value: '', '@ctype': 'textNode' });
  const style: Record<string, unknown> = { ...(old?.style ?? {}) };
  delete style.align;
  if (spec.align) style.align = spec.align;
  const keep = Object.keys(style).some((k) => k !== '@ctype');
  return { id: newId(), nodes, ...(keep ? { style: { ...style, '@ctype': 'paragraphStyle' } } : {}), '@ctype': 'paragraph' };
}

const sameParagraph = (a: TableParagraph, b: TableParagraph) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 칸 하나를 만든다. template은 같은 자리의 원래 칸(keepIds) 또는 본뜰 이웃 칸이다.
 * 내용이 그대로인 문단은 원래 문단을 그대로 써서 링크·이미지·세부 서식을 지킨다.
 */
function buildCell(spec: TableCellSpec, template: SeTableCell | undefined, keepIds: boolean, base: string | undefined): SeTableCell {
  const cell: SeTableCell = template
    ? keepIds
      ? cloneJson(template)
      : withNewIds(cloneJson(template))
    : { id: newId(), colSpan: 1, rowSpan: 1, width: 0, height: 43, value: null, '@ctype': 'tableCell' };
  const olds = paragraphsOf(cell);
  const textStyle = cellTextStyle(template);
  cell.colSpan = spec.colSpan ?? 1;
  cell.rowSpan = spec.rowSpan ?? 1;
  if (spec.background) cell.backgroundColor = spec.background;
  else delete cell.backgroundColor;

  const specs = spec.paragraphs.map((p) => ({ ...p, runs: normalizeRuns(p.runs) }));
  const empty = specs.every((p) => !p.runs.length);
  if (empty && specs.length <= 1) {
    cell.value = null;
    return cell;
  }
  const used = new Set<number>();
  cell.value = specs.map((p, i) => {
    const j = olds.findIndex((o, k) => !used.has(k) && sameParagraph(paragraphOf(o, base), p));
    if (j >= 0) {
      used.add(j);
      return olds[j];
    }
    return buildParagraph(p, olds[i] ?? olds[0], textStyle, base);
  });
  return cell;
}

/** 행마다 실제로 차지하는 열 수를 맞춰 보고 열 수를 돌려준다. 병합이 어긋나면 EditError */
function columnLayout(rows: SeTableRow[]): { columnCount: number; starts: number[][] } {
  const taken: number[] = [];
  const widths: number[] = [];
  const starts: number[][] = [];
  rows.forEach((r, i) => {
    let col = 0;
    const rowStarts: number[] = [];
    const skip = () => {
      while ((taken[col] ?? 0) > 0) col++;
    };
    for (const cell of r.cells) {
      skip();
      rowStarts.push(col);
      for (let k = 0; k < cell.colSpan; k++) {
        if ((taken[col + k] ?? 0) > 0) throw new EditError(`${i + 1}행의 병합 칸이 위 행의 병합 칸과 겹칩니다.`);
        taken[col + k] = cell.rowSpan;
      }
      col += cell.colSpan;
    }
    skip();
    widths.push(col);
    for (let k = 0; k < taken.length; k++) if (taken[k] > 0) taken[k]--;
    starts.push(rowStarts);
  });
  if (taken.some((n) => n > 0)) throw new EditError('rowspan이 표 아래로 넘칩니다.');
  const columnCount = Math.max(1, ...widths);
  const bad = widths.findIndex((w) => w !== columnCount);
  if (bad >= 0) throw new EditError(`${bad + 1}행의 칸 수가 다른 행과 다릅니다 (${widths[bad]}칸, 다른 행은 ${columnCount}칸). colspan·rowspan을 맞춘다.`);
  return { columnCount, starts };
}

/** 병합 없는 행에서 열 너비(%)를 읽는다. */
function columnWidths(rows: SeTableRow[], columnCount: number): number[] | null {
  const r = rows.find((row) => row.cells.length === columnCount && row.cells.every((cell) => cell.colSpan === 1));
  return r ? r.cells.map((cell) => cell.width) : null;
}

/** 표에 행 변경을 적용한다 (행 번호는 모두 원래 표 기준). */
export function applyTableChanges(c: SeComponent, changes: TableChange[]): void {
  const old = rowsOf(c);
  const base = baseColor(c);
  const sorted = [...changes].sort((a, b) => a.start - b.start);
  sorted.forEach((ch, i) => {
    if (!Number.isInteger(ch.start) || ch.start < 1 || ch.start > old.length + 1) {
      throw new EditError(`start ${ch.start}: 1부터 ${old.length + 1} 사이여야 합니다 (표는 ${old.length}행).`);
    }
    if (!Number.isInteger(ch.delete) || ch.delete < 0 || ch.start + ch.delete - 1 > old.length) {
      throw new EditError(`start ${ch.start}부터 ${ch.delete}행을 지울 수 없습니다 (표는 ${old.length}행).`);
    }
    const next = sorted[i + 1];
    if (next && (next.start < ch.start + ch.delete || next.start === ch.start)) {
      throw new EditError(`변경 범위가 겹칩니다 (start ${ch.start}, ${next.start}). 한 범위로 합친다.`);
    }
  });

  const oldColumns = Number(c.columnCount) || Math.max(0, ...old.map((r) => r.cells.reduce((n, cell) => n + cell.colSpan, 0)));
  const rows = [...old];
  for (const ch of [...sorted].reverse()) {
    const at = ch.start - 1;
    const neighbor = old[at + ch.delete - 1] ?? old[at - 1] ?? old[at];
    const built = ch.rows.map((spec, k) => {
      const same = k < ch.delete ? old[at + k] : undefined;
      const template = same ?? neighbor;
      return {
        cells: spec.map((cellSpec, j) =>
          buildCell(cellSpec, template?.cells[Math.min(j, template.cells.length - 1)], !!same && j < same.cells.length, base),
        ),
        '@ctype': 'tableRow' as const,
      };
    });
    rows.splice(at, ch.delete, ...built);
  }
  if (!rows.length) throw new EditError('표에는 행이 하나 이상 있어야 합니다.');
  if (rows.some((r) => !r.cells.length)) throw new EditError('칸이 없는 행이 있습니다.');

  const { columnCount, starts } = columnLayout(rows);
  const kept = columnCount === oldColumns ? columnWidths(old, columnCount) : null;
  const even = Math.round((100 / columnCount) * 100) / 100;
  const widthOf = (col: number) => kept?.[col] ?? even;
  rows.forEach((r, i) =>
    r.cells.forEach((cell, j) => {
      let w = 0;
      for (let k = 0; k < cell.colSpan; k++) w += widthOf(starts[i][j] + k);
      cell.width = Math.round(w * 100) / 100;
    }),
  );
  c.rows = rows;
  c.columnCount = columnCount;
}

/** 새 표의 행을 만든다. */
export function makeTableRows(rows: TableRowSpec[]): { rows: SeTableRow[]; columnCount: number } {
  const c: SeComponent = { id: '', '@ctype': 'table', rows: [] };
  applyTableChanges(c, [{ start: 1, delete: 0, rows }]);
  return { rows: c.rows as SeTableRow[], columnCount: c.columnCount as number };
}

/** 편집 명령 검사용 */
export function checkTableRows(rows: TableRowSpec[]): void {
  for (const r of rows) {
    if (!Array.isArray(r) || !r.length) throw new EditError('표의 행에는 칸이 하나 이상 있어야 합니다.');
    for (const cell of r) {
      for (const k of ['colSpan', 'rowSpan'] as const) {
        if (cell[k] !== undefined && !(Number.isInteger(cell[k]) && cell[k]! >= 1)) throw new EditError(`${k}는 1 이상의 정수여야 합니다.`);
      }
      if (cell.background !== undefined && !HEX_COLOR.test(cell.background)) throw new EditError(`배경색은 #rrggbb 형식이어야 합니다: ${cell.background}`);
      for (const p of cell.paragraphs ?? []) {
        for (const r2 of p.runs ?? []) {
          if (r2.color !== undefined && !HEX_COLOR.test(r2.color)) throw new EditError(`글자색은 #rrggbb 형식이어야 합니다: ${r2.color}`);
        }
      }
    }
  }
}
