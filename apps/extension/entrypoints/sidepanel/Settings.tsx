import { useEffect, useState } from 'react';
import type { HealthResponse } from '@blog-helper/shared';
import { clearConversations, listConversations } from '@/lib/conversations';
import { checkHealth, connection, type Connection } from '@/lib/server';
import { loadSettings, saveSettings, TEXT_SIZES, type UserSettings } from '@/lib/settings';
import { formatWood, WOOD_KINDS, woodToday, type WoodToday } from '@/lib/wood';
import { Header, Icon, IconButton } from './ui';
import { useWorkspaceState, WorkspaceSetting } from './Workspace';
import { alertDialog, confirmDialog } from '@/lib/dialog';

/** 계정 · 사용량 화면. 아래쪽에 이 PC의 설정을 둔다. */
export function Settings({
  onBack,
  onCleared,
  onAccountChanged,
}: {
  onBack: () => void;
  onCleared: () => void;
  /** 접근 키를 바꿨을 때 (대화 화면이 다시 확인하게 한다) */
  onAccountChanged: () => void;
}) {
  const [health, setHealth] = useState<HealthResponse | 'down' | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [prefs, setPrefs] = useState<UserSettings | null>(null);
  const [wood, setWood] = useState<WoodToday | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [keyError, setKeyError] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [conn, setConn] = useState<Connection | null>(null);
  const [workspace] = useWorkspaceState();

  const check = () => {
    setHealth(null);
    connection().then(setConn);
    checkHealth().then(setHealth, () => setHealth('down'));
  };

  const reloadCount = () => {
    setCount(null);
    listConversations().then(
      (l) => setCount(l.length),
      () => setCount(0),
    );
  };

  useEffect(() => {
    check();
    reloadCount();
    loadSettings().then(setPrefs);
    woodToday().then(setWood);
  }, []);

  const saveKey = async () => {
    const key = keyInput.trim();
    if (!key) return;
    setSavingKey(true);
    setKeyError('');
    try {
      // 접근 키는 상용 서버의 것이다. 개발 서버는 키를 검사하지 않으므로 상용 서버에서 확인한다.
      const res = await checkHealth(key, 'prod');
      if (!res.account) {
        setKeyError('맞지 않는 키예요. 받은 키를 다시 확인해 주세요.');
        return;
      }
      setPrefs(await saveSettings({ accessKey: key }));
      check();
      setKeyInput('');
      onAccountChanged();
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingKey(false);
    }
  };

  const removeKey = async () => {
    if (!(await confirmDialog('이 PC에서 접근 키를 지울까요?\n다시 쓰려면 키를 다시 넣어야 해요.', { ok: '지우기', danger: true }))) return;
    setPrefs(await saveSettings({ accessKey: '' }));
    check();
    onAccountChanged();
  };

  const clearAll = async () => {
    const where = workspace?.kind === 'ready' ? '작업공간 폴더의 대화 기록(글 폴더)' : '이 PC에 저장된 대화 기록';
    if (!(await confirmDialog(`${where}을 모두 지울까요?\n되돌릴 수 없어요.`, { ok: '모두 지우기', danger: true }))) return;
    try {
      await clearConversations();
      setCount(0);
    } catch (err) {
      await alertDialog(err instanceof Error ? err.message : String(err));
    }
    onCleared();
  };

  const storedWhere =
    workspace?.kind === 'ready'
      ? `작업공간 폴더(${workspace.name})에 있어요`
      : workspace && workspace.kind !== 'none'
        ? '작업공간에 연결되지 않았어요'
        : '이 PC의 브라우저 저장소에만 있어요';

  const account = health && health !== 'down' ? health.account : null;
  const unlimited = !!account?.unlimited;
  const hasKey = !!prefs?.accessKey;
  const pct = account?.granted ? Math.min(100, Math.floor((account.used / account.granted) * 100)) : 0;

  return (
    <>
      <Header title="계정 · 사용량" left={<IconButton name="back" label="뒤로" onClick={onBack} />} />
      <div className="page">
        <div className="account">
          <div className="avatar">
            <Icon name="user" />
          </div>
          <div className="account-text">
            <div className="account-name">
              {unlimited
                ? '개발 서버 (키 없이 사용)'
                : account
                  ? account.name
                  : health === null
                    ? '확인 중…'
                    : hasKey
                      ? '키를 확인할 수 없어요'
                      : '접근 키 없음'}
            </div>
            <div className="setting-sub">{storedWhere}</div>
          </div>
        </div>

        <div className="setting-group">
          <div className="setting-title">접근 키</div>
          <div className="setting-row">
            <div>
              <div className="setting-label">{hasKey ? '키 저장됨' : '발급받은 키를 넣어 주세요'}</div>
              <div className="setting-sub">
                {hasKey ? `${prefs!.accessKey.slice(0, 10)}…` : '키는 관리자에게 받을 수 있어요'}
                {conn?.server === 'local' && ' · 상용 서버용 (개발 서버는 키를 보지 않아요)'}
              </div>
            </div>
            {hasKey && <button onClick={removeKey}>지우기</button>}
          </div>
          <div className="key-row">
            <input
              type="password"
              placeholder={hasKey ? '새 키로 바꾸기' : 'blsee_…'}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveKey()}
            />
            <button className="primary" disabled={!keyInput.trim() || savingKey} onClick={saveKey}>
              {savingKey ? '확인 중…' : '저장'}
            </button>
          </div>
          {keyError && <div className="setting-sub error">{keyError}</div>}
        </div>

        <div className="setting-group usage">
          <div className="setting-title">남은 장작</div>
          <div className="usage-top">
            <span>{account && !unlimited ? `${pct}% 사용` : '—'}</span>
            <span>
              {unlimited
                ? '제한 없음'
                : account
                  ? `${formatWood(account.remaining)} / ${account.granted} 장작`
                  : '키를 넣으면 보여요'}
            </span>
          </div>
          <div className="usage-bar">
            {account && !unlimited && <div className="usage-seg edit" style={{ width: `${pct}%` }} />}
          </div>
          <div className="setting-sub">
            {unlimited ? '개발 서버는 장작을 세지 않아요' : '다 쓰면 충전을 요청해 주세요'}
          </div>
        </div>

        <div className="setting-group usage">
          <div className="setting-title">오늘 이 PC에서 쓴 장작</div>
          <div className="usage-legend">
            {WOOD_KINDS.map(({ kind, label }) => (
              <div key={kind}>
                <span className={`usage-swatch ${kind}`} />
                {label} {wood ? formatWood(wood.byKind[kind]) : '…'}
              </div>
            ))}
          </div>
          <div className="mini-stats">
            <div className="mini-stat">
              <strong>{wood ? formatWood(wood.used) : '…'}</strong>
              <span>오늘 쓴 장작</span>
            </div>
            <div className="mini-stat">
              <strong>{wood?.requests ?? '…'}</strong>
              <span>오늘 요청</span>
            </div>
          </div>
        </div>

        <div className="setting-group">
          <div className="setting-title">화면</div>
          <div className="setting-row">
            <div className="setting-label">글자 크기</div>
            <div className="segmented">
              {TEXT_SIZES.map((s) => (
                <button
                  key={s.value}
                  className={prefs?.textSize === s.value ? 'on' : ''}
                  disabled={!prefs}
                  onClick={async () => setPrefs(await saveSettings({ textSize: s.value }))}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-label">에디터 블씨 버튼</div>
              <div className="setting-sub">
                {prefs?.editorButton === false ? '숨겨 두었어요' : '글쓰기 화면에서 커서 옆에 보여요'}
              </div>
            </div>
            <button disabled={!prefs} onClick={async () => setPrefs(await saveSettings({ editorButton: !prefs?.editorButton }))}>
              {prefs?.editorButton === false ? '보이기' : '숨기기'}
            </button>
          </div>
        </div>

        <WorkspaceSetting
          onChanged={() => {
            reloadCount();
            onCleared();
          }}
        />

        <div className="setting-group">
          <div className="setting-title">대화 기록</div>
          <div className="setting-row">
            <div>
              <div className="setting-label">저장된 대화 {count ?? '…'}개</div>
              <div className="setting-sub">{storedWhere}</div>
            </div>
            <button onClick={clearAll} disabled={!count}>
              모두 지우기
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
