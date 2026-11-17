/**
 * 입력창 참조(@ 피커 · 이미지 참조)용 snippet·목록·합치기·hydrate.
 */
import {
  BlockRefs,
  blockImages,
  blockImageUri,
  blockText,
  paragraphText,
  parseUri,
  PENDING_IMAGE_KEY,
  rangeUri,
  typeLabel,
  type SeComponent,
  type SeDocumentData,
} from '@blog-helper/se-model';
import type { RefItem } from '@blog-helper/shared';
import type { EditorFocus } from './editor-client';
import type { ImageMeta } from './image-store';
import type { DocSession } from './doc-session';

export const SNIPPET_CHARS = 40;

export function clipSnippet(text: string, n = SNIPPET_CHARS): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 칩·피커용 종류 라벨 (번호 없음) */
export function kindLabelOf(ctype: string): string {
  const t = typeLabel(ctype);
  if (ctype === 'documentTitle') return '제목';
  if (ctype === 'sectionTitle') return '소제목';
  return t;
}

function captionOf(c: SeComponent, img?: Record<string, unknown>): string {
  const from = (x: unknown) =>
    Array.isArray(x) ? x.map((p) => paragraphText(p)).join(' ').trim() : '';
  return (img ? from(img.caption) : '') || from(c.caption);
}

function neighborText(doc: SeDocumentData, index: number): string {
  const comps = doc.document.components;
  for (const i of [index - 1, index + 1, index - 2, index + 2]) {
    const c = comps[i];
    if (!c) continue;
    const t = blockText(c)
      .replace(/^\((.*)\)$/s, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (t && !t.startsWith('이미지') && t !== '구분선') return t;
  }
  return '';
}

/** 문서 블록 snippet */
export function snippetOfBlock(doc: SeDocumentData, c: SeComponent, imageIndex = 1): string {
  const ctype = c['@ctype'];
  if (ctype === 'formula') return clipSnippet(String(c.latex ?? '') || '수식');
  if (ctype === 'table') {
    return clipSnippet(
      blockText(c)
        .replace(/^\|/gm, '')
        .replace(/\|$/gm, '')
        .replace(/\s*\|\s*/g, ' ')
        .replace(/\n/g, ' · '),
    );
  }
  const imgs = blockImages(c);
  if (imgs.length) {
    const img = imgs[Math.max(0, imageIndex - 1)];
    const cap = captionOf(c, img);
    if (cap) return clipSnippet(cap);
    const i = doc.document.components.indexOf(c);
    const near = neighborText(doc, i);
    return clipSnippet(near || '이미지');
  }
  const type = typeLabel(ctype);
  const body = blockText(c)
    .replace(/^\((.*)\)$/s, '$1')
    .replace(new RegExp(`^${type}:?\\s*`), '')
    .replace(/\s+/g, ' ')
    .trim();
  return clipSnippet(body || type);
}

export function labelOf(kind: string, snippet: string, current?: boolean): string {
  const base = `${kind}: ${snippet}`;
  return current ? `현재 위치 · ${base}` : base;
}

export type PickerItem = {
  kind: string;
  snippet: string;
  label: string;
  doc: string;
  /** 이미지 행이면 미리보기용 */
  image?: boolean;
  /** pending 또는 나중에 hydrate */
  lib?: string;
  current?: boolean;
};

function docUriForComponent(c: SeComponent, refs: BlockRefs, imageIndex?: number): string {
  const ref = refs.refOf(c.id);
  const imgs = blockImages(c);
  if (imgs.length) {
    if (imgs.length === 1) return blockImageUri(ref);
    return blockImageUri(ref, imageIndex ?? 1);
  }
  return ref;
}

/** @ 피커 목록 (문서만). 「현재 위치」는 호출 쪽에서 맨 앞에 붙인다. */
export function docPickerItems(doc: SeDocumentData, refs: BlockRefs): PickerItem[] {
  const items: PickerItem[] = [];
  for (const c of doc.document.components) {
    const kind = kindLabelOf(c['@ctype']);
    const imgs = blockImages(c);
    if (imgs.length > 1) {
      imgs.forEach((img, i) => {
        const snippet = snippetOfBlock(doc, c, i + 1);
        const pending = img[PENDING_IMAGE_KEY];
        items.push({
          kind,
          snippet,
          label: labelOf(kind, snippet),
          doc: docUriForComponent(c, refs, i + 1),
          image: true,
          ...(typeof pending === 'string' ? { lib: pending } : {}),
        });
      });
      continue;
    }
    const snippet = snippetOfBlock(doc, c);
    const img0 = imgs[0];
    const pending = img0?.[PENDING_IMAGE_KEY];
    items.push({
      kind,
      snippet,
      label: labelOf(kind, snippet),
      doc: docUriForComponent(c, refs),
      ...(imgs.length ? { image: true } : {}),
      ...(typeof pending === 'string' ? { lib: pending } : {}),
    });
  }
  return items;
}

/** live 포커스 → 현재 선택 칩. 이미지 묶음이면 안의 이미지를 한 장씩 돌려준다. */
export function currentPickerItems(
  focus: EditorFocus,
  doc: SeDocumentData,
  refs: BlockRefs,
): PickerItem[] {
  const comps = doc.document.components;
  const from = comps.findIndex((c) => c.id === focus.anchorId);
  if (from < 0 || focus.blockCount > 1) {
    const one = currentPickerItem(focus, doc, refs);
    return one ? [one] : [];
  }
  const c = comps[from];
  const imgs = blockImages(c);
  if (imgs.length <= 1) {
    const one = currentPickerItem(focus, doc, refs);
    return one ? [one] : [];
  }
  const kind = kindLabelOf(c['@ctype']);
  return imgs.map((img, i) => {
    const snippet = `${snippetOfBlock(doc, c, i + 1)} (${i + 1}/${imgs.length})`;
    const pending = img[PENDING_IMAGE_KEY];
    return {
      kind,
      snippet,
      label: labelOf(kind, snippet, true),
      doc: docUriForComponent(c, refs, i + 1),
      image: true,
      ...(typeof pending === 'string' ? { lib: pending } : {}),
      current: true,
    };
  });
}

/** live 포커스 → 「현재 위치」 피커 항목 */
export function currentPickerItem(
  focus: EditorFocus,
  doc: SeDocumentData,
  refs: BlockRefs,
): PickerItem | null {
  const comps = doc.document.components;
  const from = comps.findIndex((c) => c.id === focus.anchorId);
  const to = comps.findIndex((c) => c.id === focus.focusId);
  if (from < 0) return null;

  if (focus.blockCount > 1 && to >= 0) {
    const a = refs.refOf(comps[Math.min(from, to)].id);
    const b = refs.refOf(comps[Math.max(from, to)].id);
    const snippet = clipSnippet(focus.selectedText || focus.label.replace(/^블록\s*\d+개/, '') || `${focus.blockCount}개 블록`);
    const kind = '범위';
    return {
      kind,
      snippet,
      label: labelOf(kind, snippet, true),
      doc: rangeUri(a, b),
      current: true,
    };
  }

  const c = comps[from];
  const kind = kindLabelOf(c['@ctype']);
  const imgs = blockImages(c);
  let snippet: string;
  if (focus.selectedText) snippet = clipSnippet(focus.selectedText);
  else if (focus.paragraph !== undefined) snippet = clipSnippet(focus.paragraph || '(빈 문단)');
  else snippet = snippetOfBlock(doc, c);
  const pending = imgs[0]?.[PENDING_IMAGE_KEY];
  return {
    kind,
    snippet,
    label: labelOf(kind, snippet, true),
    doc: docUriForComponent(c, refs),
    ...(imgs.length ? { image: true } : {}),
    ...(typeof pending === 'string' ? { lib: pending } : {}),
    current: true,
  };
}

export function refKey(r: Pick<RefItem, 'doc' | 'lib'>): string {
  if (r.doc) return `doc:${r.doc}`;
  if (r.lib) return `lib:${r.lib}`;
  return '';
}

const stripCurrent = (label: string) => label.replace(/^현재 위치 · /, '');

/** 위 줄의 현재 선택 칩만 합친다. 인라인 칩에는 쓰지 않는다. */
export function mergeRef(list: RefItem[], next: RefItem): RefItem[] {
  const key = refKey(next);
  if (!key) return list;
  const clearCurrent = (r: RefItem): RefItem =>
    r.current ? { ...r, current: undefined, label: stripCurrent(r.label) } : r;
  const i = list.findIndex((r) => refKey(r) === key);
  if (i < 0) {
    const base = next.current ? list.map(clearCurrent) : list;
    return [...base, next];
  }
  const prev = list[i];
  const current = !!(next.current || prev.current);
  const baseLabel = stripCurrent(next.label || prev.label);
  const merged: RefItem = {
    label: current ? `현재 위치 · ${baseLabel}` : baseLabel,
    ...(next.doc ?? prev.doc ? { doc: next.doc ?? prev.doc } : {}),
    ...(next.lib ?? prev.lib ? { lib: next.lib ?? prev.lib } : {}),
    ...(current ? { current: true } : {}),
  };
  return list.map((r, j) => {
    if (j === i) return merged;
    return current ? clearCurrent(r) : r;
  });
}

export function libSnippetFromMeta(meta: ImageMeta | null | undefined, fallback: string): string {
  const s = meta?.name || meta?.caption || meta?.instruction || fallback;
  return clipSnippet(s);
}

export function refFromLib(uri: string, meta: ImageMeta | null | undefined, name?: string): RefItem {
  if (/blsee:\/\/lib\/research\//.test(uri)) {
    return { label: labelOf('자료', clipSnippet(name || '검색 자료')), lib: uri };
  }
  const kind = meta?.htmlUri ? '인포그래픽' : '이미지';
  const snippet = libSnippetFromMeta(meta, name || kind);
  return { label: labelOf(kind, snippet), lib: uri };
}

export function pickerToRef(item: PickerItem): RefItem {
  return {
    label: item.label,
    doc: item.doc,
    ...(item.lib ? { lib: item.lib } : {}),
    ...(item.current ? { current: true } : {}),
  };
}

/** 글 안 이미지인데 lib가 없으면 세션으로 채운다. */
export async function hydrateRefs(
  items: RefItem[],
  session: DocSession,
  blockRefs: BlockRefs,
  focusImageSrc?: string | null,
): Promise<RefItem[]> {
  const out: RefItem[] = [];
  for (const r of items) {
    if (r.lib || !r.doc) {
      out.push(r);
      continue;
    }
    const u = parseUri(r.doc);
    if (u?.kind !== 'image' && u?.kind !== 'block') {
      out.push(r);
      continue;
    }
    const blockRef = u.kind === 'image' || u.kind === 'block' ? u.ref : undefined;
    const id = blockRef ? blockRefs.idOf(blockRef) : undefined;
    const c = id ? session.working.document.components.find((x) => x.id === id) : undefined;
    const imgs = c ? blockImages(c) : [];
    if (!imgs.length && u.kind === 'block') {
      out.push(r);
      continue;
    }
    const idx = u.kind === 'image' ? u.index - 1 : 0;
    const img = imgs[idx];
    const pending = img?.[PENDING_IMAGE_KEY];
    if (typeof pending === 'string') {
      out.push({ ...r, lib: pending });
      continue;
    }
    const src = typeof img?.src === 'string' ? img.src : r.current ? focusImageSrc : undefined;
    if (typeof src === 'string') {
      const lib = await session.ensurePointedLib(src, id);
      out.push(lib ? { ...r, lib } : r);
      continue;
    }
    out.push(r);
  }
  return out;
}

/** 문장에 넣을 URI. 보관본이 있으면 그 URI, 없으면 문서 위치. */
export function refUri(r: Pick<RefItem, 'doc' | 'lib'>): string | undefined {
  return r.lib || r.doc;
}

/** 인라인 칩. 현재 선택 표시는 떼고, 위 줄 칩과 합치지 않는다. */
export function asInlineRef(r: RefItem): RefItem {
  const { current: _current, ...rest } = r;
  return { ...rest, label: stripCurrent(rest.label) };
}

/**
 * 사용자 문장 안의 URI를 refs 순서대로 칩 자리로 가른다.
 * 같은 URI가 여러 번이면 앞에서부터 하나씩 대응한다.
 * 보낸 뒤 lib가 채워져도 문장에 남은 doc URI를 찾는다.
 */
export function splitInlineRefs(
  text: string,
  refs: RefItem[],
): Array<{ type: 'text'; text: string } | { type: 'ref'; ref: RefItem }> {
  const parts: Array<{ type: 'text'; text: string } | { type: 'ref'; ref: RefItem }> = [];
  let cursor = 0;
  for (const r of refs) {
    const candidates = [r.doc, r.lib].filter((u): u is string => !!u);
    let best: { i: number; len: number } | null = null;
    for (const uri of candidates) {
      const i = text.indexOf(uri, cursor);
      if (i < 0) continue;
      if (!best || i < best.i || (i === best.i && uri.length > best.len)) best = { i, len: uri.length };
    }
    if (!best) continue;
    if (best.i > cursor) parts.push({ type: 'text', text: text.slice(cursor, best.i) });
    parts.push({ type: 'ref', ref: r });
    cursor = best.i + best.len;
  }
  if (cursor < text.length) parts.push({ type: 'text', text: text.slice(cursor) });
  return parts;
}

