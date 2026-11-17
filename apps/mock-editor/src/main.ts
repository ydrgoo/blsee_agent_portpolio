/**
 * 모의 스마트에디터. 확장이 실제 편집기에 기대는 면만 흉내 낸다.
 *
 * - window.SmartEditor._editors.<key>: getDocumentData / setDocumentData / getSelection
 * - 화면: .se-content 안에 문서 순서대로 .se-component.se-<ctype> (id = 블록 ID)
 * - 붙여넣기: 이미지 파일이면 /upload에 올려 이미지 블록을 커서 뒤에 넣는다 (네이버처럼 imageLoaded를 나중에 한 번 더 쓴다).
 *   글이면 문단 블록으로 넣는다.
 * - 클릭으로 블록 선택, Shift+클릭으로 범위 선택 (getSelection이 돌려준다)
 *
 * 시험 코드는 window.__mock으로 글을 불러오고 블록을 고른다.
 */
import { makeComponent, renderHtml, type SeComponent, type SeDocumentData } from '@blog-helper/se-model';

const EDITOR_KEY = 'blogpc001';
/** 네이버 편집기 본문 폭에 맞춘 이미지 최대 폭 */
const IMAGE_MAX_WIDTH = 693;
/** 업로드 뒤 imageLoaded를 다시 쓰기까지 (실제 편집기가 사진을 불러오는 시간 흉내) */
const IMAGE_LOAD_MS = 400;

const content = document.getElementById('content') as HTMLDivElement;
const status = document.getElementById('status') as HTMLSpanElement;
const select = document.getElementById('doc') as HTMLSelectElement;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const newId = () => `SE-${crypto.randomUUID()}`;

let doc: SeDocumentData = emptyDoc();
let anchorId: string | null = null;
let focusId: string | null = null;

function emptyDoc(): SeDocumentData {
  return {
    document: {
      id: `MOCK${Date.now()}`,
      components: [
        {
          id: newId(),
          layout: 'default',
          title: [{ id: newId(), nodes: [{ id: newId(), value: '모의 글', '@ctype': 'textNode' }], '@ctype': 'paragraph' }],
          '@ctype': 'documentTitle',
        },
      ],
    },
    documentId: '',
  } as unknown as SeDocumentData;
}

/* ---------- 화면 ---------- */

function render() {
  content.replaceChildren();
  doc.document.components.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = `se-component se-${c['@ctype']}${c['@ctype'] === 'documentTitle' ? ' se-documentTitle' : ''}`;
    el.id = c.id;
    if (isSelected(i)) el.classList.add('selected');
    el.innerHTML = renderHtml(doc, i, i, { imageSrc: (s) => s });
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = c['@ctype'];
    el.prepend(tag);
    el.addEventListener('mousedown', (e) => {
      if (e.shiftKey && anchorId) focusId = c.id;
      else anchorId = focusId = c.id;
      render();
    });
    content.append(el);
  });
  status.textContent = `블록 ${doc.document.components.length}개`;
}

function isSelected(i: number): boolean {
  if (!anchorId || !focusId) return false;
  const ids = doc.document.components.map((c) => c.id);
  const a = ids.indexOf(anchorId);
  const f = ids.indexOf(focusId);
  if (a < 0 || f < 0) return false;
  return i >= Math.min(a, f) && i <= Math.max(a, f);
}

/* ---------- 편집기 객체 ---------- */

function firstParaId(c: SeComponent | undefined): string | undefined {
  const paras = (c?.value ?? c?.title) as { id?: string }[] | undefined;
  return Array.isArray(paras) ? paras[0]?.id : undefined;
}

const editor = {
  getDocumentData: () => clone(doc),
  setDocumentData: (data: SeDocumentData) => {
    doc = clone(data);
    const ids = new Set(doc.document.components.map((c) => c.id));
    if (anchorId && !ids.has(anchorId)) anchorId = null;
    if (focusId && !ids.has(focusId)) focusId = null;
    render();
  },
  getSelection: () => {
    if (!anchorId || !focusId) return null;
    const comps = doc.document.components;
    const point = (id: string) => ({ compId: id, paraId: firstParaId(comps.find((c) => c.id === id)), offset: 0 });
    return { anchor: point(anchorId), focus: point(focusId), isCollapsed: anchorId === focusId };
  },
};

(window as unknown as { SmartEditor: unknown }).SmartEditor = { _editors: { [EDITOR_KEY]: editor } };

/* ---------- 붙여넣기 ---------- */

/** 커서(선택 끝) 뒤에 블록을 넣는다. 커서가 없으면 끝에 넣는다. */
function insertAfterCaret(c: SeComponent) {
  const comps = doc.document.components;
  const at = focusId ? comps.findIndex((x) => x.id === focusId) : -1;
  comps.splice(at >= 0 ? at + 1 : comps.length, 0, c);
  anchorId = focusId = c.id;
  render();
}

async function imageSize(blob: Blob): Promise<{ w: number; h: number }> {
  try {
    const bmp = await createImageBitmap(blob);
    const size = { w: bmp.width, h: bmp.height };
    bmp.close();
    return size;
  } catch {
    return { w: 600, h: 400 };
  }
}

async function pasteImage(file: File) {
  const res = await fetch('/upload', { method: 'POST', headers: { 'content-type': file.type || 'image/png' }, body: file });
  const { url } = (await res.json()) as { url: string };
  const { w, h } = await imageSize(file);
  const width = Math.min(w, IMAGE_MAX_WIDTH);
  const c = {
    id: newId(),
    layout: 'default',
    src: url,
    internalResource: true,
    represent: false,
    path: new URL(url).pathname,
    domain: new URL(url).origin,
    fileSize: file.size,
    width,
    height: Math.round((width * h) / w),
    originalWidth: w,
    originalHeight: h,
    fileName: file.name,
    caption: null,
    format: 'normal',
    displayFormat: 'normal',
    imageLoaded: false,
    contentMode: 'normal',
    origin: { srcFrom: 'local', '@ctype': 'imageOrigin' },
    ai: false,
    '@ctype': 'image',
  } as unknown as SeComponent;
  insertAfterCaret(c);
  // 실제 편집기처럼 사진을 불러온 뒤 imageLoaded를 한 번 더 쓴다.
  setTimeout(() => {
    const found = doc.document.components.find((x) => x.id === c.id);
    if (found) {
      found.imageLoaded = true;
      render();
    }
  }, IMAGE_LOAD_MS);
}

content.addEventListener('paste', (e) => {
  const dt = e.clipboardData;
  if (!dt) return;
  const images = [...dt.files].filter((f) => f.type.startsWith('image/'));
  e.preventDefault();
  if (images.length) {
    for (const f of images) void pasteImage(f);
    return;
  }
  const text = dt.getData('text/plain');
  if (text) insertAfterCaret(makeComponent('text', { paragraphs: text.split('\n') }));
});

/* ---------- 글 불러오기 ---------- */

async function load(name: string) {
  const res = await fetch(`/test-data/${encodeURIComponent(name)}`);
  const json = (await res.json()) as { data?: SeDocumentData } & SeDocumentData;
  doc = clone(json.data ?? json);
  anchorId = focusId = null;
  render();
}

function selectBlock(id: string, toId?: string) {
  anchorId = id;
  focusId = toId ?? id;
  render();
}

(window as unknown as { __mock: unknown }).__mock = { load, selectBlock, editorKey: EDITOR_KEY };

void (async () => {
  const files = (await (await fetch('/test-data')).json()) as string[];
  select.replaceChildren(...files.map((f) => Object.assign(document.createElement('option'), { value: f, textContent: f })));
  document.getElementById('load')!.addEventListener('click', () => void load(select.value));
  const want = new URLSearchParams(location.search).get('doc');
  if (want) await load(want);
  else render();
})();
