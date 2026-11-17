import iconSvg from '@/assets/icon.svg?raw';
import { PRESETS, presetBlockOf, presetsFor, type PresetId } from '@blog-helper/shared';
import { callMain, type CaretBlock } from '@/lib/main-bridge';
import type { BackgroundRequest, ContentResponse } from '@/lib/messages';
import { loadSettings, onSettingsChange, saveSettings } from '@/lib/settings';

/** 글쓰기 화면이 늦게 그려지므로 에디터가 생길 때까지 이 간격으로 찾아본다. */
const FIND_EDITOR_MS = 1000;
const FIND_EDITOR_TRIES = 60;
/** 커서를 따라가는 간격 */
const FOLLOW_MS = 300;
const TOAST_MS = 6000;
const SIZE = 48;
/** 블록 왼쪽 끝에서 띄우는 거리 */
const GAP = 16;
/** 화면 가장자리에서 띄우는 거리 */
const EDGE = 8;
const MENU_WIDTH = 170;

interface Ui {
  host: HTMLElement;
  menu: HTMLElement;
}

export default defineContentScript({
  matches: ['https://blog.naver.com/*'],
  allFrames: true,
  // 에디터가 클릭을 가로채므로, 에디터 스크립트보다 먼저 창 전체에서 포인터 이벤트를 받아야 버튼 조작을 알 수 있다.
  runAt: 'document_start',
  main() {
    let ui: Ui | null = null;
    let caret: CaretBlock | null = null;
    let enabled = false;
    let menuOpen = false;

    const inUi = (e: Event) => ui !== null && e.composedPath().includes(ui.host);
    const closeMenu = () => {
      menuOpen = false;
      if (ui) ui.menu.hidden = true;
    };

    const follow = async () => {
      if (!ui || menuOpen) return;
      const next =
        enabled && document.hasFocus() ? await callMain<CaretBlock | null>({ type: 'caret' }, 1000).catch(() => null) : null;
      if (menuOpen) return;
      caret = next && presetBlockOf(next.ctype) !== null ? next : null;
      place(ui, caret);
    };

    window.addEventListener(
      'pointerdown',
      (e) => {
        if (!inUi(e)) {
          if (menuOpen) closeMenu();
          return;
        }
        // 에디터가 포커스와 선택을 잃지 않게 기본 동작을 막는다. click은 그래도 일어난다.
        e.preventDefault();
        e.stopPropagation();
      },
      true,
    );
    window.addEventListener(
      'click',
      (e) => {
        if (!ui || !inUi(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const action = e.composedPath().find((n): n is HTMLElement => n instanceof HTMLElement && !!n.dataset.action)?.dataset.action;
        if (action === 'toggle') {
          if (menuOpen) closeMenu();
          else if (caret) {
            openMenu(ui, caret, () => (menuOpen = true));
            // 메뉴만 열고 패널이 닫혀 있으면 대화할 곳이 없으니 패널도 연다.
            openPanel();
          }
        } else if (action === 'close') {
          closeMenu();
          saveSettings({ editorButton: false }).catch(() => {});
          toast('블씨 버튼을 숨겼어요. 블씨 패널의 설정(계정 · 사용량) → 화면에서 다시 보이게 할 수 있어요.');
        } else if (action) {
          closeMenu();
          openPanel(action as PresetId);
        }
      },
      true,
    );
    window.addEventListener('keydown', (e) => e.key === 'Escape' && menuOpen && closeMenu(), true);
    window.addEventListener('scroll', () => void follow(), true);

    onSettingsChange((s) => {
      enabled = s.editorButton;
      void follow();
    });

    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      if (document.querySelector('.se-content')) {
        clearInterval(timer);
        enabled = (await loadSettings()).editorButton;
        ui = mount();
        setInterval(() => void follow(), FOLLOW_MS);
      } else if (tries >= FIND_EDITOR_TRIES) {
        clearInterval(timer);
      }
    }, FIND_EDITOR_MS);
  },
});

/** 커서가 있는 블록 왼쪽 여백, 커서 문단 높이에 붙인다. 커서가 없거나 화면 밖이면 숨긴다. */
function place(ui: Ui, caret: CaretBlock | null) {
  const top = caret ? caret.top - (SIZE - 24) / 2 : 0;
  const visible = !!caret && top >= 0 && top <= window.innerHeight - SIZE;
  ui.host.hidden = !visible;
  if (!visible) return;
  ui.host.style.left = `${Math.max(EDGE, caret!.left - GAP - SIZE)}px`;
  ui.host.style.top = `${top}px`;
}

function openMenu(ui: Ui, caret: CaretBlock, onOpen: () => void) {
  const ids = presetsFor(presetBlockOf(caret.ctype), caret.multiple);
  ui.menu.replaceChildren(...ids.map((id) => item(PRESETS[id].label, id)));
  // 오른쪽에 자리가 없으면 버튼 왼쪽으로 펼친다.
  const left = ui.host.getBoundingClientRect().left;
  ui.menu.classList.toggle('left', left + SIZE + 6 + MENU_WIDTH > window.innerWidth - EDGE);
  ui.menu.hidden = false;
  onOpen();
}

function item(label: string, action: string): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.dataset.action = action;
  return b;
}

function openPanel(preset?: PresetId) {
  browser.runtime
    .sendMessage({ type: 'open-panel', ...(preset ? { preset } : {}) } satisfies BackgroundRequest)
    .then((res: ContentResponse<null> | undefined) => {
      if (!res?.ok) throw new Error(res?.error ?? '응답 없음');
    })
    .catch((err) => {
      console.warn('[블씨] 사이드 패널을 열지 못했습니다:', err);
      toast('여기서는 패널을 열지 못했어요. 툴바의 블씨 아이콘이나 단축키(기본 ⌥⇧B)로 열어 주세요.');
    });
}

/** 화면 아래쪽에 잠깐 보이는 안내 (버튼을 숨긴 뒤에도 보이게 따로 띄운다) */
function toast(text: string) {
  const el = document.createElement('div');
  const root = el.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      p {
        position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%); z-index: 2147483000;
        max-width: 420px; margin: 0; padding: 10px 14px; border-radius: 8px;
        background: #173b3b; color: #fff; font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
      }
    </style>
    <p></p>
  `;
  root.querySelector('p')!.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), TOAST_MS);
}

/** 네이버 스타일과 섞이지 않게 shadow DOM에 둔다. 메뉴 항목을 창 전체 이벤트에서 알아보려고 open으로 연다. */
function mount(): Ui {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483000;';
  host.hidden = true;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      .open {
        width: ${SIZE}px; height: ${SIZE}px; padding: 8px;
        border: 1px solid #d8dee4; border-radius: 50%;
        background: #fff; cursor: pointer;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
        transition: transform 0.12s, box-shadow 0.12s;
      }
      .open:hover { transform: translateY(-2px); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2); }
      svg { display: block; width: 100%; height: 100%; pointer-events: none; }
      .close {
        position: absolute; top: -6px; right: -6px; width: 20px; height: 20px; padding: 0;
        border: 1px solid #d8dee4; border-radius: 50%;
        background: #fff; color: #57606a; font: 12px/18px sans-serif; text-align: center; cursor: pointer;
        opacity: 0; transition: opacity 0.12s;
      }
      :host(:hover) .close { opacity: 1; }
      .close:hover { background: #f6f8fa; color: #1f2328; }
      .menu {
        position: absolute; top: 0; left: ${SIZE + 6}px; width: ${MENU_WIDTH}px;
        padding: 4px; border: 1px solid #d8dee4; border-radius: 8px;
        background: #fff; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif;
      }
      .menu.left { left: auto; right: ${SIZE + 6}px; }
      .menu[hidden] { display: none; }
      .menu button {
        display: block; width: 100%; padding: 7px 10px; border: 0; border-radius: 5px;
        background: none; color: #1f2328; text-align: left; font: inherit; cursor: pointer;
      }
      .menu button:hover { background: #f0f5e0; }
      .menu hr { margin: 4px 2px; border: 0; border-top: 1px solid #eaeef2; }
    </style>
    <button class="open" type="button" data-action="toggle" title="블씨" aria-label="블씨 메뉴">${iconSvg}</button>
    <button class="close" type="button" data-action="close" title="버튼 숨기기" aria-label="버튼 숨기기">✕</button>
    <div class="menu" hidden></div>
  `;
  document.body.append(host);
  return { host, menu: root.querySelector('.menu')! };
}
