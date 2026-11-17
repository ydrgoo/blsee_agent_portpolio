import type {
  BroadcastMessage,
  ClipboardDump,
  ComponentInfo,
  ContentRequest,
  ContentResponse,
  EditorProbe,
  ElementInfo,
  ImagePasteAttempt,
  PasteTestResult,
  SelectionDomProbe,
  SelectionProbe,
} from '@/lib/messages';
import { callMain, type PageGlobal, type SelectionModelProbe } from '@/lib/main-bridge';

const EDITOR_SELECTOR = '.se-component, .se-content, .se-documentTitle';

export default defineContentScript({
  // 개발 빌드에서는 모의 편집기(apps/mock-editor)에도 붙는다.
  matches: ['https://blog.naver.com/*', ...(import.meta.env.MODE !== 'production' ? ['http://localhost:5179/*'] : [])],
  allFrames: true,
  // 에디터 입력용 숨은 iframe(about:blank 등)에도 들어가야 붙여넣기를 볼 수 있다.
  matchAboutBlank: true,
  matchOriginAsFallback: true,
  // 에디터 스크립트보다 먼저 리스너를 등록해야 stopPropagation에 막히지 않는다.
  runAt: 'document_start',
  main() {
    if (import.meta.env.DEV) {
      window.addEventListener('copy', (e) => record('copy', e), true);
      window.addEventListener('paste', (e) => record('paste', e), true);
    }
    window.addEventListener(
      'keydown',
      (e) => {
        // 한글 입력 상태에서는 e.key가 'ㅍ'이 되므로 e.code로 판별한다.
        if ((e.metaKey || e.ctrlKey) && e.code === 'KeyV') {
          broadcast({ type: 'paste-key', frameUrl: location.href, at: new Date().toISOString() });
        }
      },
      true,
    );

    browser.runtime.onMessage.addListener(
      (msg: ContentRequest, _sender, sendResponse) => {
        let task: Promise<unknown>;
        if (
          msg?.type === 'probe' ||
          msg?.type === 'explore' ||
          msg?.type === 'document-data' ||
          msg?.type === 'post-info' ||
          msg?.type === 'write-test' ||
          msg?.type === 'write-restore' ||
          msg?.type === 'set-document' ||
          msg?.type === 'selection' ||
          msg?.type === 'reveal-block' ||
          msg?.type === 'caret-test' ||
          msg?.type === 'trace-start' ||
          msg?.type === 'trace-stop'
        ) {
          // 글쓰기 화면은 iframe 안에 있으므로 에디터가 없는 프레임은 응답하지 않는다.
          if (!hasEditor()) return;
          task = msg.type === 'probe' ? probe() : callMain(msg, msg.type === 'caret-test' ? 10_000 : undefined);
        } else if (msg?.type === 'paste-test') {
          // 사이드 패널이 붙여넣기가 일어난 프레임을 지정해서 보낸다.
          task = pasteTest(msg.data);
        } else if (msg?.type === 'image-paste-test') {
          if (!hasEditor()) return;
          task = imagePasteTest(msg.dataUrl);
        } else if (msg?.type === 'selection-probe') {
          if (!hasEditor()) return;
          task = selectionProbe();
        } else if (msg?.type === 'my-blog-id' || msg?.type === 'blog-api' || msg?.type === 'post-exists') {
          // 블로그 페이지 맨 위 프레임 하나만 응답한다. 모바일 API는 이 출처의 로그인 요청을 허용한다(CORS).
          if (window !== window.top || location.hostname !== 'blog.naver.com') return;
          task =
            msg.type === 'my-blog-id' ? myBlogId() : msg.type === 'blog-api' ? blogApi(msg.path) : postExists(msg.blogId, msg.logNo);
        } else {
          return;
        }

        task.then(
          (result) => sendResponse({ ok: true, result } satisfies ContentResponse<unknown>),
          (err) =>
            sendResponse({ ok: false, error: String(err) } satisfies ContentResponse<unknown>),
        );
        return true;
      },
    );
  },
});

const BLOG_ID = /^[A-Za-z0-9_-]+$/;

/** MyBlog.naver는 로그인한 사용자의 블로그로 이동한다. 로그인하지 않았으면 로그인 페이지(다른 출처)로 가서 실패한다. */
async function myBlogId(): Promise<string> {
  let url: URL;
  try {
    url = new URL((await fetch('/MyBlog.naver', { credentials: 'include' })).url);
  } catch {
    throw new Error('네이버에 로그인한 뒤 다시 시도해 주세요.');
  }
  const id = url.searchParams.get('blogId') ?? url.pathname.split('/')[1] ?? '';
  if (url.hostname !== 'blog.naver.com' || !BLOG_ID.test(id) || id.endsWith('.naver')) {
    throw new Error('내 블로그 주소를 찾지 못했습니다. 네이버에 로그인했는지 확인해 주세요.');
  }
  return id;
}

async function blogApi(path: string): Promise<unknown> {
  const res = await fetch(`https://m.blog.naver.com/api/${path}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`블로그 정보를 받지 못했습니다 (HTTP ${res.status}).`);
  const body = (await res.json()) as { isSuccess?: boolean; result?: unknown };
  if (!body.isSuccess) throw new Error('블로그 정보를 받지 못했습니다.');
  return body.result;
}

/** 지운 글은 PostView가 404로 답한다. 그 밖의 실패는 있는 것으로 본다. */
async function postExists(blogId: string, logNo: string): Promise<boolean> {
  const q = new URLSearchParams({ blogId, logNo });
  const res = await fetch(`/PostView.naver?${q}`, { credentials: 'include' });
  return res.status !== 404;
}

function hasEditor(): boolean {
  return document.querySelector(EDITOR_SELECTOR) !== null;
}

function describe(el: Element | null): ElementInfo | null {
  if (!el) return null;
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id,
    className: String(el.className).slice(0, 200),
  };
}

function componentType(el: Element): string {
  const cls = [...el.classList].find(
    (c) =>
      c.startsWith('se-') &&
      c !== 'se-component' &&
      !c.startsWith('se-l-') &&
      !c.startsWith('se-section'),
  );
  return cls ?? 'unknown';
}

function collectComponents(): ComponentInfo[] {
  return [...document.querySelectorAll('.se-component')].map((el, index) => ({
    index,
    type: componentType(el),
    className: String(el.className),
    textPreview: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
  }));
}

async function probe(): Promise<EditorProbe> {
  return {
    url: location.href,
    isTopFrame: window === window.top,
    title:
      document.querySelector('.se-documentTitle')?.textContent?.trim() ?? null,
    components: collectComponents(),
    editables: [
      ...document.querySelectorAll('[contenteditable="true"], textarea, input[type="text"]'),
    ]
      .slice(0, 30)
      .map((el) => describe(el)!),
    activeElement: describe(document.activeElement),
    pageGlobals: await requestPageGlobals(),
  };
}

function requestPageGlobals(): Promise<PageGlobal[]> {
  return callMain<PageGlobal[]>({ type: 'probe-globals' }).catch(() => []);
}

function readDataTransfer(dt: DataTransfer | null): Pick<ClipboardDump, 'data' | 'files'> {
  const data: Record<string, string> = {};
  if (!dt) return { data, files: 0 };
  for (const type of dt.types) {
    if (type === 'Files') continue;
    data[type] = dt.getData(type);
  }
  return { data, files: dt.files.length };
}

function broadcast(msg: BroadcastMessage) {
  browser.runtime.sendMessage(msg).catch(() => {});
}

function record(event: ClipboardDump['event'], e: ClipboardEvent) {
  broadcast({
    type: 'clipboard-dump',
    dump: {
      event,
      isTrusted: e.isTrusted,
      at: new Date().toISOString(),
      frameUrl: location.href,
      ...readDataTransfer(e.clipboardData),
    },
  });
}

/** 입력용 iframe 안에서 호출될 수 있으므로, 에디터가 있는 상위 프레임까지 올라가며 센다. */
function countComponents(): number {
  let w: Window = window;
  while (true) {
    try {
      const n = w.document.querySelectorAll('.se-component').length;
      if (n > 0 || w === w.parent) return n;
    } catch {
      return 0;
    }
    w = w.parent;
  }
}

async function pasteTest(data: Record<string, string>): Promise<PasteTestResult> {
  const target =
    (document.activeElement && document.activeElement !== document.body
      ? document.activeElement
      : document.querySelector('.se-content')) ?? document.body;

  const componentsBefore = countComponents();

  const dt = new DataTransfer();
  for (const [type, value] of Object.entries(data)) {
    dt.setData(type, value);
  }
  const event = new ClipboardEvent('paste', {
    clipboardData: dt,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  const notCanceled = target.dispatchEvent(event);

  await new Promise((r) => setTimeout(r, 500));

  return {
    frameUrl: location.href,
    target: describe(target),
    editorHandled: !notCanceled,
    componentsBefore,
    componentsAfter: countComponents(),
  };
}

function componentIndexOf(node: Node | null): number | null {
  const el = node instanceof Element ? node : node?.parentElement;
  const comp = el?.closest('.se-component');
  if (!comp) return null;
  return [...document.querySelectorAll('.se-component')].indexOf(comp);
}

function nodeLabel(node: Node | null): string {
  if (!node) return '';
  if (node.nodeType === Node.TEXT_NODE) return `"${(node.textContent ?? '').slice(0, 40)}"`;
  const el = node as Element;
  return `<${el.tagName?.toLowerCase()} class="${String(el.className ?? '').slice(0, 60)}">`;
}

const MARK_CLASS = /select|caret|cursor|focus|activ|highlight/i;

/** 이 프레임과 입력용 iframe의 선택 영역, 선택/커서 표시 요소를 모은다. */
function probeSelectionDom(): SelectionDomProbe {
  const frames: [string, Document | null | undefined][] = [
    ['에디터 프레임', document],
    ['입력용 iframe', document.querySelector<HTMLIFrameElement>('iframe[id^="input_buffer"]')?.contentDocument],
  ];
  const selections = frames.flatMap(([frame, doc]) => {
    const sel = doc?.getSelection();
    if (!sel) return [];
    return [
      {
        frame,
        type: sel.type,
        text: sel.toString().slice(0, 100),
        anchor: nodeLabel(sel.anchorNode),
        anchorOffset: sel.anchorOffset,
        focusOffset: sel.focusOffset,
        component: doc === document ? componentIndexOf(sel.anchorNode) : null,
      },
    ];
  });

  const marks: SelectionDomProbe['marks'] = [];
  const seen = new Set<string>();
  for (const el of document.querySelectorAll('.se-content *, .se-component')) {
    const cls = [...el.classList].filter((c) => MARK_CLASS.test(c));
    if (!cls.length) continue;
    const key = `${cls.join(' ')}|${componentIndexOf(el)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    marks.push({
      className: cls.join(' '),
      component: componentIndexOf(el),
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
    });
    if (marks.length >= 40) break;
  }
  return { selections, marks };
}

async function selectionProbe(): Promise<SelectionProbe> {
  const dom = probeSelectionDom();
  const model = await callMain<SelectionModelProbe>({ type: 'selection-probe' }).catch((e) => ({
    error: String(e),
  }));
  return { dom, model };
}

function countImages(): number {
  return document.querySelectorAll('.se-component.se-image, .se-image-resource').length;
}

/**
 * 이미지 파일만 담은 붙여넣기 이벤트를 보내 본다 (화면 캡처 붙여넣기와 같은 형태).
 * 에디터 입력용 숨은 iframe(input_buffer…)을 먼저 시도하고, 안 되면 에디터 본문에 보낸다.
 */
/** 에디터가 붙여넣기를 취소하지 않았을 때, 다음 대상으로 넘어가기 전에 이미지가 생기는지 지켜보는 시간 */
const PASTE_FALLBACK_MS = 1500;

async function imagePasteTest(dataUrl: string): Promise<ImagePasteAttempt[]> {
  const blob = await (await fetch(dataUrl)).blob();
  const type = blob.type || 'image/png';
  const file = new File([blob], `blog-helper.${type.split('/')[1] ?? 'png'}`, { type });

  const buffer = document.querySelector<HTMLIFrameElement>('iframe[id^="input_buffer"]');
  const bufferDoc = buffer?.contentDocument;
  const targets: [string, EventTarget | null | undefined][] = [
    ['input_buffer iframe (activeElement)', bufferDoc?.activeElement ?? bufferDoc?.body],
    ['에디터 본문 (.se-content)', document.querySelector('.se-content')],
  ];

  const attempts: ImagePasteAttempt[] = [];
  for (const [where, target] of targets) {
    if (!target) {
      attempts.push({ where: `${where} - 대상 없음`, editorHandled: false, imagesBefore: 0, imagesAfter: 0 });
      continue;
    }
    const dt = new DataTransfer();
    dt.items.add(file);
    const imagesBefore = countImages();
    const notCanceled = target.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true }),
    );
    // 에디터가 붙여넣기를 받았으면(취소했으면) 업로드 완료는 부르는 쪽이 문서를 보며 기다린다.
    if (!notCanceled) {
      attempts.push({ where, editorHandled: true, imagesBefore, imagesAfter: countImages() });
      break;
    }
    const deadline = Date.now() + PASTE_FALLBACK_MS;
    while (countImages() <= imagesBefore && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    const imagesAfter = countImages();
    attempts.push({ where, editorHandled: false, imagesBefore, imagesAfter });
    if (imagesAfter > imagesBefore) break;
  }
  return attempts;
}
