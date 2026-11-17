import { useCallback, useEffect, useState } from 'react';
import { browserConversationCount, moveBrowserDataToWorkspace } from '@/lib/conversations';
import {
  forgetWorkspace,
  onWorkspaceChange,
  openConnectPage,
  pickWorkspace,
  SUBFOLDER,
  workspaceState,
  type WorkspaceState,
} from '@/lib/workspace';
import { loadSettings, onSettingsChange, saveSettings, type UserSettings } from '@/lib/settings';
import { Dot } from './ui';
import { confirmDialog } from '@/lib/dialog';

const CHECK_MS = 15000;

/** 작업공간 상태. 저장장치를 뺐을 때를 알아채도록 가끔, 그리고 패널에 돌아올 때 다시 본다. */
export function useWorkspaceState(): [WorkspaceState | null, () => void] {
  const [state, setState] = useState<WorkspaceState | null>(null);
  const refresh = useCallback(() => {
    workspaceState().then(
      (next) => setState((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next)),
      () => setState({ kind: 'none' }),
    );
  }, []);
  useEffect(() => {
    refresh();
    const off = onWorkspaceChange(refresh);
    const timer = setInterval(refresh, CHECK_MS);
    window.addEventListener('focus', refresh);
    return () => {
      off();
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);
  return [state, refresh];
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 폴더를 고른다 (버튼 클릭 안에서). 처음 고른 것이면 브라우저의 대화를 옮길지 묻는다. 취소하면 false */
async function chooseWorkspace(first: boolean, onProgress: (text: string) => void): Promise<boolean> {
  const root = await pickWorkspace((name) =>
    confirmDialog(`「${name}」 폴더에는 다른 파일이 있어요.\n이 안에 「${SUBFOLDER}」 폴더를 만들어(이미 있으면 그대로) 작업공간으로 쓸까요?`),
  );
  if (!root) return false;
  await saveSettings({ workspaceTip: 'done' });
  const count = await browserConversationCount();
  if (first && count && (await confirmDialog(`이 PC의 브라우저에 저장된 대화 ${count}개를 작업공간 폴더로 옮길까요?\n옮긴 뒤에는 브라우저에서 지워요.`, { ok: '옮기기' }))) {
    await moveBrowserDataToWorkspace((done, total) => onProgress(`옮기는 중… ${done}/${total}`));
  }
  return true;
}

/** 작업공간을 정하지 않았을 때 권하는 카드. 처음 한 번, 미룬 뒤 이미지가 쌓이면 한 번 더 띄운다. */
export function WorkspaceTip({ state, onChanged }: { state: WorkspaceState | null; onChanged: () => void }) {
  const [tip, setTip] = useState<UserSettings['workspaceTip'] | null>(null);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    loadSettings().then((s) => setTip(s.workspaceTip));
    return onSettingsChange((s) => setTip(s.workspaceTip));
  }, []);

  if (state?.kind !== 'none' || (tip !== 'new' && tip !== 'remind')) return null;

  const pick = async () => {
    setError('');
    setWorking('폴더 고르는 중…');
    try {
      if (await chooseWorkspace(true, setWorking)) onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setWorking('');
    }
  };

  return (
    <div className="workspace-tip">
      <div>
        <div className="workspace-tip-title">
          {tip === 'remind' ? '만든 이미지가 브라우저에만 저장되고 있어요' : '작업공간 폴더를 정해 두면 좋아요'}
        </div>
        <div className="setting-sub">
          {working ||
            '폴더를 정하면 대화와 이미지가 파일로 남아요. 정하지 않으면 브라우저에 저장되고, 확장을 지우면 함께 사라져요.'}
        </div>
        {error && <div className="setting-sub error">{error}</div>}
      </div>
      <div className="row-buttons">
        <button className="primary" disabled={!!working} onClick={pick}>
          폴더 고르기
        </button>
        <button disabled={!!working} onClick={() => saveSettings({ workspaceTip: tip === 'new' ? 'later' : 'done' })}>
          나중에
        </button>
      </div>
    </div>
  );
}

/**
 * 다시 연결: 권한이 풀렸으면 연결 탭을 연다 (사이드 패널에서는 권한 창이 뜨지 않는다).
 * 폴더를 못 찾았으면 다시 확인만 한다. 안내할 말을 돌려준다.
 */
async function reconnect(): Promise<string> {
  const state = await workspaceState();
  if (state.kind === 'prompt') {
    await openConnectPage();
    return '새 탭에서 연결을 마치면 이어서 저장해요.';
  }
  if (state.kind === 'missing') return '폴더를 찾지 못했어요. 저장장치가 연결됐는지 확인해 주세요.';
  return '';
}

/** 작업공간을 정했는데 쓸 수 없을 때 대화 위에 띄운다. 이때는 저장하지 않는다. */
export function WorkspaceBanner({ state, onChecked }: { state: WorkspaceState | null; onChecked: () => void }) {
  const [note, setNote] = useState('');
  if (!state || (state.kind !== 'prompt' && state.kind !== 'missing')) return null;

  const onClick = async () => {
    setNote(await reconnect().catch(errorText));
    onChecked();
  };

  return (
    <div className="workspace-banner">
      <div>
        <div className="workspace-banner-title">
          <Dot kind="warn" /> {state.kind === 'missing' ? '작업공간 폴더를 찾을 수 없어요' : '작업공간 폴더에 다시 연결해야 해요'} ·{' '}
          {state.name}
        </div>
        <div className="setting-sub">
          {state.kind === 'missing'
            ? '저장장치를 연결한 뒤 다시 연결을 눌러 주세요. 연결 전까지 대화는 저장되지 않아요.'
            : '크롬을 다시 켜거나 패널을 닫았다 열면 폴더 권한을 다시 받아야 해요. 연결 전까지 대화는 저장되지 않아요.'}
        </div>
        {note && <div className="setting-sub error">{note}</div>}
      </div>
      <button className="primary" onClick={onClick}>
        다시 연결
      </button>
    </div>
  );
}

/** 설정 화면의 작업공간 항목 */
export function WorkspaceSetting({ onChanged }: { onChanged: () => void }) {
  const [state, refresh] = useWorkspaceState();
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');

  const run = async (label: string, job: () => Promise<void>) => {
    setError('');
    setWorking(label);
    try {
      await job();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setWorking('');
      refresh();
      onChanged();
    }
  };

  const pick = () =>
    run('폴더 고르는 중…', async () => {
      await chooseWorkspace(state?.kind === 'none', setWorking);
    });

  const onReconnect = () =>
    run('연결 중…', async () => {
      const note = await reconnect();
      if (note) throw new Error(note);
    });

  const forget = async () => {
    if (!(await confirmDialog('작업공간을 해제할까요?\n폴더의 파일은 그대로 두고, 이제부터 대화는 이 PC의 브라우저에 저장해요.', { ok: '해제' }))) return;
    run('해제하는 중…', async () => {
      await forgetWorkspace();
      await saveSettings({ workspaceTip: 'done' });
    });
  };

  const status =
    state === null
      ? '확인 중…'
      : state.kind === 'none'
        ? '정하지 않음'
        : state.kind === 'ready'
          ? state.name
          : `${state.name} (${state.kind === 'missing' ? '찾을 수 없음' : '다시 연결 필요'})`;

  return (
    <div className="setting-group">
      <div className="setting-title">작업공간</div>
      <div className="setting-row">
        <div>
          <div className="setting-label">
            {state && state.kind !== 'none' && <Dot kind={state.kind === 'ready' ? 'on' : 'warn'} />} {status}
            {state?.kind === 'none' && <span className="server-badge local">권장</span>}
          </div>
          <div className="setting-sub">
            {working ||
              (state?.kind === 'none'
                ? '폴더를 고르면 대화와 이미지를 그 폴더에 저장해요 (이동식 저장장치도 돼요)'
                : state?.kind === 'prompt' || state?.kind === 'missing'
                  ? '다시 연결이 안 되면 「바꾸기」로 같은 폴더를 다시 골라 주세요'
                  : '대화와 이미지를 이 폴더에 저장해요. 바꾸거나 해제해도 폴더의 파일은 남아요')}
          </div>
        </div>
        <div className="row-buttons">
          {(state?.kind === 'prompt' || state?.kind === 'missing') && (
            <button className="primary" disabled={!!working} onClick={onReconnect}>
              다시 연결
            </button>
          )}
          <button disabled={!state || !!working} onClick={pick}>
            {state?.kind === 'none' ? '폴더 고르기' : '바꾸기'}
          </button>
          {state && state.kind !== 'none' && (
            <button disabled={!!working} onClick={forget}>
              해제
            </button>
          )}
        </div>
      </div>
      {error && <div className="setting-sub error">{error}</div>}
    </div>
  );
}
