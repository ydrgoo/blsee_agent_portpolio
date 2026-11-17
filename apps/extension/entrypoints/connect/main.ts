/**
 * 작업공간 폴더 권한을 다시 받는 탭. 사이드 패널에서는 크롬이 권한 창을 띄우지 않아서 여기서 받는다.
 * 권한은 확장 전체에 걸리므로 여기서 받으면 사이드 패널에서도 쓸 수 있다.
 * 받지 못하면 사이드 패널의 작업공간 설정을 띄워 폴더를 다시 고르게 한다.
 */
import '../sidepanel/style.css';
import './style.css';
import { reconnectWorkspace, requestWorkspaceSettings, workspaceState } from '@/lib/workspace';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const folder = $('folder');
const connectButton = $<HTMLButtonElement>('connect');
const note = $('note');

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function done() {
  note.textContent = '연결했어요. 이 탭은 곧 닫혀요.';
  connectButton.disabled = true;
  setTimeout(() => window.close(), 800);
}

function failed(reason: string) {
  requestWorkspaceSettings();
  note.textContent = `${reason} 블씨 사이드 패널의 설정 › 작업공간에서 「바꾸기」로 폴더를 다시 골라 주세요.`;
}

async function show() {
  const state = await workspaceState();
  if (state.kind === 'none') {
    folder.textContent = '작업공간을 정하지 않았어요. 블씨 설정에서 폴더를 골라 주세요.';
    connectButton.hidden = true;
    return;
  }
  folder.textContent = `폴더: ${state.name}`;
  if (state.kind === 'ready') done();
}

connectButton.addEventListener('click', async () => {
  note.textContent = '';
  try {
    const state = await reconnectWorkspace();
    if (state.kind === 'ready') return done();
    failed(state.kind === 'missing' ? '폴더를 찾지 못했어요.' : '권한을 받지 못했어요.');
  } catch (err) {
    failed(errorText(err));
  }
});

show().catch((err) => (note.textContent = errorText(err)));
