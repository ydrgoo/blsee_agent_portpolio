import {
  ISOLATED_SOURCE,
  MAIN_SOURCE,
  type DocumentDataResult,
  type EditorSelection,
  type ExploreEntry,
  type ExploreResult,
  type MainEnvelope,
  type MainReply,
  type MainRequest,
  type PageGlobal,
  type PostInfo,
  type SelectionModelProbe,
  type WriteTestResult,
  type CaretBlock,
  type CaretTestResult,
  type UploadTrace,
} from '@/lib/main-bridge';

/**
 * 페이지 컨텍스트(MAIN world)에서 실행된다.
 * 확장 API는 쓸 수 없고, 격리된 콘텐츠 스크립트와는 window.postMessage로만 통신한다.
 */
export default defineContentScript({
  // 개발 빌드에서는 모의 편집기(apps/mock-editor)에도 붙는다.
  matches: ['https://blog.naver.com/*', ...(import.meta.env.MODE !== 'production' ? ['http://localhost:5179/*'] : [])],
  allFrames: true,
  world: 'MAIN',
  runAt: 'document_idle',
  main() {
    window.addEventListener('message', (e: MessageEvent<MainEnvelope>) => {
      if (e.source !== window || e.data?.source !== ISOLATED_SOURCE) return;
      const { requestId, req } = e.data;

      Promise.resolve()
        .then(() => handle(req))
        .then(
          (result): MainReply => ({ source: MAIN_SOURCE, requestId, ok: true, result }),
          (err): MainReply => ({ source: MAIN_SOURCE, requestId, ok: false, error: String(err) }),
        )
        .then((reply) => window.postMessage(reply, '*'));
    });
  },
});

function handle(req: MainRequest): unknown {
  switch (req.type) {
    case 'probe-globals':
      return collectPageGlobals();
    case 'selection-probe':
      return probeSelectionModel();
    case 'selection':
      return getSelection();
    case 'caret':
      return caretBlock();
    case 'reveal-block':
      return revealBlock(req.id);
    case 'caret-test':
      return caretTest(req.compId);
    case 'trace-start':
      return traceStart();
    case 'trace-stop':
      return traceStop();
    case 'explore':
      return explore(req.path);
    case 'document-data':
      return getDocumentData();
    case 'post-info':
      return getPostInfo();
    case 'write-test':
      return writeTest();
    case 'write-restore':
      return writeRestore();
    case 'set-document': {
      const { editor } = getEditor();
      if (typeof editor.setDocumentData !== 'function') throw new Error('setDocumentData가 없습니다.');
      editor.setDocumentData(req.data);
      return { ok: true };
    }
  }
}

/** 빈 iframe의 window와 비교해서 페이지가 직접 추가한 전역 변수만 추린다. */
function collectPageGlobals(): PageGlobal[] {
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  document.documentElement.appendChild(iframe);
  const baseline = new Set(Object.getOwnPropertyNames(iframe.contentWindow!));
  iframe.remove();

  return Object.getOwnPropertyNames(window)
    .filter((name) => !baseline.has(name))
    .map((name) => {
      let type: string;
      try {
        type = typeof (window as unknown as Record<string, unknown>)[name];
      } catch {
        type = 'inaccessible';
      }
      return { name, type };
    });
}

function resolvePath(path: string): unknown {
  let cur: unknown = window;
  for (const key of path.split('.').filter(Boolean)) {
    if (cur == null) throw new Error(`${path}: ${key} 이전 값이 비어 있습니다.`);
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function describeValue(v: unknown): { type: string; detail: string } {
  if (v === null) return { type: 'null', detail: '' };
  const type = Array.isArray(v) ? 'array' : typeof v;
  switch (type) {
    case 'function': {
      const fn = v as (...args: unknown[]) => unknown;
      return { type, detail: `${fn.name || '(anonymous)'}(${fn.length})` };
    }
    case 'array':
      return { type, detail: `length ${(v as unknown[]).length}` };
    case 'object':
      return {
        type,
        detail: (v as object).constructor?.name ?? 'Object',
      };
    case 'string':
      return { type, detail: JSON.stringify((v as string).slice(0, 80)) };
    default:
      return { type, detail: String(v) };
  }
}

function explore(path: string): ExploreResult {
  const target = resolvePath(path);
  const entries: ExploreEntry[] = [];
  const seen = new Set<string>();

  if (target !== null && (typeof target === 'object' || typeof target === 'function')) {
    let obj: object | null = target as object;
    let inherited = false;
    while (obj && obj !== Object.prototype && obj !== Function.prototype) {
      for (const name of Object.getOwnPropertyNames(obj)) {
        if (seen.has(name) || name === 'constructor') continue;
        seen.add(name);

        let value: unknown;
        try {
          const desc = Object.getOwnPropertyDescriptor(obj, name);
          // getter는 부작용이 있을 수 있어 호출하지 않는다.
          value = desc && 'value' in desc ? desc.value : undefined;
          if (desc && !('value' in desc)) {
            entries.push({ name, type: 'getter', detail: '', inherited });
            continue;
          }
        } catch {
          entries.push({ name, type: 'inaccessible', detail: '', inherited });
          continue;
        }
        entries.push({ name, ...describeValue(value), inherited });
      }
      obj = Object.getPrototypeOf(obj);
      inherited = true;
      if (entries.length > 500) break;
    }
  }

  return { path, ...describeValue(target), entries };
}

interface EditorLike {
  getDocumentData?: () => unknown;
  setDocumentData?: (data: unknown) => unknown;
  getSelection?: () => unknown;
}

interface SelectionPoint {
  compId?: string;
  paraId?: string | null;
  nodeId?: string | null;
  offset?: number;
}

interface SeDocumentData {
  document: { components: SeComponent[] };
}

interface SeComponent {
  id?: string;
  '@ctype': string;
  value?: unknown[];
  title?: unknown[];
}

function getEditors(): Record<string, EditorLike> {
  const editors = (window as unknown as { SmartEditor?: { _editors?: Record<string, EditorLike> } })
    .SmartEditor?._editors;
  if (!editors) {
    throw new Error('SmartEditor._editors 가 없습니다. 탐색 기능으로 SmartEditor 내부를 확인해 주세요.');
  }
  return editors;
}

function getEditor(): { key: string; editor: EditorLike } {
  for (const [key, editor] of Object.entries(getEditors())) {
    if (typeof editor?.getDocumentData === 'function') return { key, editor };
  }
  throw new Error('getDocumentData를 가진 에디터가 없습니다.');
}

/** postMessage로 넘기거나 원본과 분리하기 위해 순수 JSON으로 복사한다. */
function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function getDocumentData(): DocumentDataResult {
  const editors = getEditors();
  const { key, editor } = getEditor();
  return { editorKeys: Object.keys(editors), editorKey: key, data: cloneJson(editor.getDocumentData!()) };
}

function getSelection(): EditorSelection | null {
  const { editor } = getEditor();
  if (typeof editor.getSelection !== 'function') return null;
  const sel = editor.getSelection() as { anchor?: SelectionPoint; focus?: SelectionPoint; isCollapsed?: boolean } | null;
  const anchor = sel?.anchor;
  const focus = sel?.focus;
  if (!anchor?.compId || !focus?.compId) return null;
  const comps = (editor.getDocumentData!() as SeDocumentData).document.components;
  const from = comps.findIndex((c) => c.id === anchor.compId);
  const to = comps.findIndex((c) => c.id === focus.compId);
  if (from < 0 || to < 0) return null;
  const comp = from === to ? comps[from] : undefined;
  const inText = anchor.paraId != null || focus.paraId != null;
  return {
    anchorCompId: anchor.compId,
    focusCompId: focus.compId,
    blockCount: Math.abs(to - from) + 1,
    collapsed: !!sel?.isCollapsed,
    inText,
    component: comp ? cloneJson(comp) : null,
    ...(comp ? { ordinal: comps.slice(0, from + 1).filter((c) => c['@ctype'] === comp['@ctype']).length } : {}),
    ...(comp && inText ? selectionText(comp, anchor, focus, !!sel?.isCollapsed) : {}),
  };
}

/** 화면 클래스(se-text 등)로 읽는 블록 종류 */
const CARET_CTYPES = ['documentTitle', 'text', 'image', 'table'];

/**
 * 커서가 있는 블록의 화면 위치. 자주 불리므로 문서 데이터를 꺼내지 않고 화면 요소에서 읽는다.
 * 블록·문단 요소의 id가 모델 id와 같지 않으면 문서 순서로 찾는다.
 */
function caretBlock(): CaretBlock | null {
  const { editor } = getEditor();
  if (typeof editor.getSelection !== 'function') return null;
  const sel = editor.getSelection() as { anchor?: SelectionPoint; focus?: SelectionPoint } | null;
  const focus = sel?.focus;
  if (!focus?.compId || !sel?.anchor?.compId) return null;

  let comp = document.getElementById(focus.compId);
  if (!comp?.classList.contains('se-component')) {
    const comps = (editor.getDocumentData!() as SeDocumentData).document.components;
    comp = document.querySelectorAll<HTMLElement>('.se-component')[comps.findIndex((c) => c.id === focus.compId)] ?? null;
  }
  if (!comp) return null;
  const para = focus.paraId ? document.getElementById(focus.paraId) : null;
  const box = comp.getBoundingClientRect();
  return {
    ctype: CARET_CTYPES.find((t) => comp.classList.contains(`se-${t}`)) ?? 'other',
    multiple: sel.anchor.compId !== focus.compId,
    top: para && comp.contains(para) ? para.getBoundingClientRect().top : box.top,
    left: box.left,
  };
}

const REVEAL_FLASH_MS = 1500;

/** 블록을 화면 가운데로 스크롤하고 잠깐 테두리를 보여 준다. 화면의 .se-component 순서는 문서 블록 순서와 같다. */
function revealBlock(id: string): { ok: true } {
  const comps = (getEditor().editor.getDocumentData!() as SeDocumentData).document.components;
  const i = comps.findIndex((c) => c.id === id);
  if (i < 0) throw new Error('지금 글에 없는 블록입니다.');
  const el = document.querySelectorAll<HTMLElement>('.se-component')[i];
  if (!el) throw new Error('화면에서 블록을 찾지 못했습니다.');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const prev = { outline: el.style.outline, offset: el.style.outlineOffset };
  el.style.outline = '3px solid #f08010';
  el.style.outlineOffset = '4px';
  setTimeout(() => {
    el.style.outline = prev.outline;
    el.style.outlineOffset = prev.offset;
  }, REVEAL_FLASH_MS);
  return { ok: true };
}

interface ParaNode {
  id?: string;
  value?: string;
}

/** 블록 안의 문단을 문서 순서대로 모은다 (본문, 캡션, 표 칸, 인용 출처 등 어디에 있든). */
function collectParagraphs(x: unknown, out: { id: string; nodes: ParaNode[] }[] = []) {
  if (Array.isArray(x)) {
    for (const v of x) collectParagraphs(v, out);
  } else if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    if (o['@ctype'] === 'paragraph' && typeof o.id === 'string') {
      out.push({ id: o.id, nodes: (o.nodes as ParaNode[]) ?? [] });
      return out;
    }
    for (const v of Object.values(o)) collectParagraphs(v, out);
  }
  return out;
}

/** 문단 시작부터의 글자 위치. offset은 노드 안 위치로 보고, 노드가 없으면 문단 안 위치로 본다. */
function paraOffset(nodes: ParaNode[], p: SelectionPoint): number {
  if (!p.nodeId) return p.offset ?? 0;
  let pos = 0;
  for (const n of nodes) {
    if (n.id === p.nodeId) return pos + (p.offset ?? 0);
    pos += (n.value ?? '').length;
  }
  return pos;
}

/** 커서가 있는 문단 글과, 글자를 드래그했으면 그 글 */
function selectionText(
  comp: SeComponent,
  anchor: SelectionPoint,
  focus: SelectionPoint,
  collapsed: boolean,
): { paragraph?: string; selectedText?: string } {
  const paras = collectParagraphs(comp);
  const text = (i: number) => paras[i].nodes.map((n) => n.value ?? '').join('');
  const a = paras.findIndex((p) => p.id === anchor.paraId);
  const f = paras.findIndex((p) => p.id === focus.paraId);
  if (a < 0) return {};
  const paragraph = text(a);
  if (collapsed || f < 0) return { paragraph };

  let [s, e] = [
    { i: a, at: paraOffset(paras[a].nodes, anchor) },
    { i: f, at: paraOffset(paras[f].nodes, focus) },
  ];
  if (s.i > e.i || (s.i === e.i && s.at > e.at)) [s, e] = [e, s];
  const parts: string[] = [];
  for (let i = s.i; i <= e.i; i++) {
    const t = text(i);
    parts.push(t.slice(i === s.i ? s.at : 0, i === e.i ? e.at : t.length));
  }
  const selectedText = parts.join('\n');
  return selectedText.trim() ? { paragraph, selectedText } : { paragraph };
}

function getPostInfo(): PostInfo {
  const data = getEditor().editor.getDocumentData!() as SeDocumentData & {
    document: { id?: string };
    documentId?: string;
  };
  if (!data.document.id) throw new Error('문서 ID(document.id)가 없습니다.');
  const comps = data.document.components;
  const title = comps.find((c) => c['@ctype'] === 'documentTitle');
  const text = ((title?.title ?? []) as { nodes?: { value?: string }[] }[])
    .map((p) => (p.nodes ?? []).map((n) => n.value ?? '').join(''))
    .join(' ')
    .trim();
  return { key: data.document.id, title: text, documentId: data.documentId ?? '', blockCount: comps.length };
}

function listMethods(obj: object): string[] {
  const names = new Set<string>();
  for (let o: object | null = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const name of Object.getOwnPropertyNames(o)) {
      try {
        if (typeof (o as Record<string, unknown>)[name] === 'function') names.add(name);
      } catch {
        // getter가 예외를 던지는 경우 무시
      }
    }
  }
  return [...names].sort();
}

const SETTER_TOPIC = /select|caret|cursor|range|focus/i;
const SETTER_VERB = /^(set|move|select|focus|place|restore|change|update|collapse)/i;

/**
 * 커서를 블록 첫 글자 앞으로 옮기는 방법을 차례로 시도한다.
 * 에디터의 setSelection(있으면)을 먼저, 안 되면 그 블록 글자를 누르는 마우스 이벤트를 보낸다.
 */
async function caretTest(compId: string): Promise<CaretTestResult> {
  const { key, editor } = getEditor();
  const comps = (editor.getDocumentData!() as SeDocumentData).document.components;
  const index = comps.findIndex((c) => c.id === compId);
  if (index < 0) throw new Error('지금 글에 없는 블록입니다.');
  const c = comps[index];
  const para = (c.value ?? c.title)?.[0] as { id?: string; nodes?: { id?: string }[] } | undefined;
  const point = { compId, paraId: para?.id ?? null, nodeId: para?.nodes?.[0]?.id ?? null, offset: 0 };

  const root = `SmartEditor._editors.${key}`;
  const objects: [string, Record<string, unknown>][] = [[root, editor as Record<string, unknown>]];
  for (const prop of Object.keys(editor as object).slice(0, 80)) {
    try {
      const child = (editor as Record<string, unknown>)[prop];
      if (child && typeof child === 'object' && !(child instanceof Node)) objects.push([`${root}.${prop}`, child as Record<string, unknown>]);
    } catch {
      // 접근할 수 없는 속성
    }
  }
  const setters = objects.flatMap(([path, obj]) =>
    listMethods(obj)
      .filter((n) => SETTER_TOPIC.test(n) && SETTER_VERB.test(n))
      .map((n) => `${path}.${n}(${(obj[n] as (...a: unknown[]) => unknown).length})`),
  );

  const current = () => (editor.getSelection?.() as { anchor?: { compId?: string } } | null) ?? null;
  const tried: CaretTestResult['tried'] = [];
  const attempt = async (how: string, run: () => unknown) => {
    let ok = true;
    let error: string | undefined;
    try {
      await run();
    } catch (e) {
      ok = false;
      error = String(e);
    }
    await new Promise((r) => setTimeout(r, 200));
    const landed = current()?.anchor?.compId === compId;
    tried.push({ how, ok, ...(error ? { error } : {}), selection: preview(current(), 400), landed });
    return landed;
  };

  const focusById = (editor as Record<string, unknown>).focusComponentById;
  if (typeof focusById === 'function') {
    if (await attempt(`${root}.focusComponentById(id)`, () => focusById.call(editor, compId))) {
      return { setters, tried, landedBy: tried.at(-1)!.how };
    }
  }

  for (const [path, obj] of objects) {
    const fn = obj.setSelection;
    if (typeof fn !== 'function') continue;
    if (await attempt(`${path}.setSelection({anchor, focus, isCollapsed})`, () => fn.call(obj, { anchor: point, focus: point, isCollapsed: true }))) {
      return { setters, tried, landedBy: tried.at(-1)!.how };
    }
    if (await attempt(`${path}.setSelection(anchor, focus)`, () => fn.call(obj, point, point))) {
      return { setters, tried, landedBy: tried.at(-1)!.how };
    }
  }

  if (await attempt('표시 블록 글자 클릭 이벤트', () => clickBlockText(index))) {
    return { setters, tried, landedBy: tried.at(-1)!.how };
  }
  return { setters, tried };
}

/** 화면의 index번째 블록 첫 글자를 누르는 마우스 이벤트를 보낸다. */
async function clickBlockText(index: number): Promise<void> {
  const el = document.querySelectorAll<HTMLElement>('.se-component')[index];
  const text = el?.querySelector<HTMLElement>('.se-text-paragraph') ?? el;
  if (!text) throw new Error('화면에서 블록을 찾지 못했습니다.');
  text.scrollIntoView({ block: 'center' });
  await new Promise((r) => setTimeout(r, 300));
  const rect = text.getBoundingClientRect();
  const x = rect.left + 1;
  const y = rect.top + rect.height / 2;
  const target = document.elementFromPoint(x, y) ?? text;
  const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: window };
  target.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1, pointerType: 'mouse' }));
  target.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
  const node = text.querySelector('span')?.firstChild ?? text.firstChild;
  if (node) window.getSelection()?.collapse(node, 0);
  target.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerType: 'mouse' }));
  target.dispatchEvent(new MouseEvent('mouseup', init));
  target.dispatchEvent(new MouseEvent('click', init));
}

let tracing: { trace: UploadTrace; observer: PerformanceObserver; timer: number } | null = null;

/** 블록마다 바뀐 키를 짧게 적는다. */
function describeChange(prev: SeComponent[], next: SeComponent[]): string {
  const rec = (c: SeComponent) => c as unknown as Record<string, unknown>;
  const before = new Map(prev.map((c) => [c.id, c]));
  const parts: string[] = [];
  next.forEach((c, i) => {
    const old = before.get(c.id);
    before.delete(c.id);
    if (!old) {
      const src = typeof rec(c).src === 'string' ? ` src=${String(rec(c).src).slice(0, 40)}` : '';
      parts.push(`[${i}] ${c['@ctype']} 새로 생김${src}`);
      return;
    }
    if (JSON.stringify(old) === JSON.stringify(c)) return;
    const keys = [...new Set([...Object.keys(old), ...Object.keys(c)])].filter(
      (k) => JSON.stringify(rec(old)[k]) !== JSON.stringify(rec(c)[k]),
    );
    const src = keys.includes('src') ? ` src=${String(rec(c).src).slice(0, 40)}` : '';
    parts.push(`[${i}] ${c['@ctype']} 바뀜: ${keys.join(', ')}${src}`);
  });
  for (const c of before.values()) parts.push(`${c['@ctype']} ${String(c.id).slice(0, 11)} 사라짐`);
  return parts.join(' / ') || '(블록 내용은 같고 문서 다른 곳만 바뀜)';
}

/** 네트워크 요청(리소스 기록)과 문서 변경(100ms마다)을 기록하기 시작한다. */
function traceStart(): { t0: number } {
  if (tracing) traceStop();
  const t0 = performance.timeOrigin + performance.now();
  const rel = (perfTime: number) => Math.round(performance.timeOrigin + perfTime - t0);
  const trace: UploadTrace = { t0, network: [], doc: [] };
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries() as PerformanceResourceTiming[]) {
      if (/^(data|blob):/.test(e.name)) continue;
      trace.network.push({
        start: rel(e.startTime),
        end: rel(e.responseEnd),
        url: e.name,
        initiator: e.initiatorType,
        status: (e as { responseStatus?: number }).responseStatus || undefined,
        size: e.transferSize || undefined,
      });
    }
  });
  observer.observe({ type: 'resource' });
  const { editor } = getEditor();
  const read = () => (editor.getDocumentData!() as SeDocumentData).document.components;
  let prev = cloneJson(read());
  let prevJson = JSON.stringify(prev);
  const timer = window.setInterval(() => {
    const now = read();
    const json = JSON.stringify(now);
    if (json === prevJson) return;
    const next = JSON.parse(json) as SeComponent[];
    trace.doc.push({
      t: Math.round(Date.now() - t0),
      summary: `블록 ${next.length}개`,
      changed: describeChange(prev, next),
    });
    prev = next;
    prevJson = json;
  }, 100);
  tracing = { trace, observer, timer };
  return { t0 };
}

function traceStop(): UploadTrace {
  if (!tracing) throw new Error('추적 중이 아닙니다.');
  const { trace, observer, timer } = tracing;
  for (const e of observer.takeRecords() as PerformanceResourceTiming[]) {
    if (/^(data|blob):/.test(e.name)) continue;
    trace.network.push({
      start: Math.round(performance.timeOrigin + e.startTime - trace.t0),
      end: Math.round(performance.timeOrigin + e.responseEnd - trace.t0),
      url: e.name,
      initiator: e.initiatorType,
    });
  }
  observer.disconnect();
  clearInterval(timer);
  tracing = null;
  return trace;
}

const SELECTION_NAME = /select|caret|cursor|range|focus|position|activ/i;
const CALLABLE_NAME = /^(get|is|has)\w*(select|caret|cursor|range|focus|position|activ)/i;

/** 순환 참조와 깊이를 제한한 짧은 JSON (DOM 노드는 태그와 클래스만) */
function preview(v: unknown, max = 1200): string {
  const seen = new WeakSet<object>();
  const walk = (x: unknown, depth: number): unknown => {
    if (x === null || typeof x !== 'object') return typeof x === 'function' ? `[fn ${(x as { name?: string }).name ?? ''}]` : x;
    if (x instanceof Node) {
      const el = x as Element;
      return `[${x.nodeName}${el.className ? `.${String(el.className).split(' ')[0]}` : ''}${x.nodeType === 3 ? ` "${x.textContent?.slice(0, 30)}"` : ''}]`;
    }
    if (seen.has(x)) return '[순환]';
    seen.add(x);
    if (depth > 3) return `[${(x as object).constructor?.name ?? 'Object'}]`;
    if (Array.isArray(x)) return x.slice(0, 10).map((i) => walk(i, depth + 1));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x).slice(0, 25)) {
      try {
        out[k] = walk((x as Record<string, unknown>)[k], depth + 1);
      } catch {
        out[k] = '[접근 불가]';
      }
    }
    return out;
  };
  try {
    const s = JSON.stringify(walk(v, 0));
    return s === undefined ? String(v) : s.length > max ? `${s.slice(0, max)}…` : s;
  } catch (e) {
    return `[직렬화 실패 ${String(e)}]`;
  }
}

/**
 * 에디터 객체와 그 바로 아래 하위 객체들에서 선택/커서 관련 메서드를 찾고,
 * 이름이 get/is/has…Selection 같은 인자 없는 메서드만 불러 본다 (부작용 가능성이 낮은 것만).
 */
function probeSelectionModel(): SelectionModelProbe {
  const { key, editor } = getEditor();
  const methods: string[] = [];
  const calls: SelectionModelProbe['calls'] = [];

  const scan = (obj: object, path: string) => {
    for (const name of listMethods(obj)) {
      if (!SELECTION_NAME.test(name)) continue;
      const fn = (obj as Record<string, (...a: unknown[]) => unknown>)[name];
      methods.push(`${path}.${name}(${fn.length})`);
      if (fn.length === 0 && CALLABLE_NAME.test(name) && calls.length < 40) {
        try {
          calls.push({ path: `${path}.${name}()`, ok: true, value: preview(fn.call(obj)) });
        } catch (e) {
          calls.push({ path: `${path}.${name}()`, ok: false, value: String(e) });
        }
      }
    }
  };

  const root = `SmartEditor._editors.${key}`;
  scan(editor as object, root);
  for (const prop of Object.keys(editor as object).slice(0, 80)) {
    let child: unknown;
    try {
      child = (editor as Record<string, unknown>)[prop];
    } catch {
      continue;
    }
    if (child && typeof child === 'object' && !(child instanceof Node)) scan(child, `${root}.${prop}`);
  }
  return { methods: methods.slice(0, 200), calls };
}

let writeBackup: unknown = null;

function newId(): string {
  return `SE-${crypto.randomUUID()}`;
}

function writeTest(): WriteTestResult {
  const { editor } = getEditor();
  if (typeof editor.setDocumentData !== 'function') {
    const candidates = listMethods(editor).filter((n) => /document|set|insert|component|update/i.test(n));
    throw new Error(`setDocumentData가 없습니다. 후보 메서드: ${candidates.join(', ')}`);
  }

  const original = cloneJson(editor.getDocumentData!()) as SeDocumentData;
  writeBackup ??= cloneJson(original);

  const marker = `[블씨 쓰기 테스트 ${new Date().toLocaleTimeString()}]`;
  const paragraph = {
    id: newId(),
    nodes: [{ id: newId(), value: marker, '@ctype': 'textNode' }],
    '@ctype': 'paragraph',
  };

  const next = cloneJson(original);
  const components = next.document.components;
  const lastText = [...components].reverse().find((c) => c['@ctype'] === 'text');
  if (lastText?.value) {
    lastText.value.push(paragraph);
  } else {
    components.push({ id: newId(), layout: 'default', value: [paragraph], '@ctype': 'text' } as SeComponent);
  }

  editor.setDocumentData(next);

  return {
    marker,
    componentsBefore: original.document.components.length,
    componentsAfter: (editor.getDocumentData!() as SeDocumentData).document.components.length,
    inModel: JSON.stringify(editor.getDocumentData!()).includes(marker),
    inDom: document.body.innerText.includes(marker),
  };
}

function writeRestore(): { restored: boolean } {
  if (!writeBackup) throw new Error('되돌릴 백업이 없습니다.');
  getEditor().editor.setDocumentData!(writeBackup);
  writeBackup = null;
  return { restored: true };
}
