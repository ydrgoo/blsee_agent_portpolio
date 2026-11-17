import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadConversation, resetConversation, type Conversation } from '@/lib/conversations';
import { getCurrentPost, type CurrentPost } from '@/lib/editor-client';
import { findViewedPost, forgetViewedPost, type ViewedPost } from '@/lib/blog';
import type { ImageMeta } from '@/lib/image-store';
import { clearBadge } from '@/lib/notify';
import { checkHealth } from '@/lib/server';
import { watchTextSize } from '@/lib/settings';
import { BlockedComposer, Chat } from './Chat';
import { DevTools } from './DevTools';
import { postStatus } from './History';
import { NavPanel, type NavTab } from './Nav';
import { Settings } from './Settings';
import { AVAIL, Header, IconButton, type Avail } from './ui';
import { useWorkspaceState, WorkspaceBanner, WorkspaceTip } from './Workspace';
import { onWorkspaceSettingsRequest } from '@/lib/workspace';
import { alertDialog, confirmDialog, DialogHost } from '@/lib/dialog';

type Screen = 'chat' | 'nav' | 'settings' | 'dev';

const SERVER_POLL_MS = 30000;

function samePost(a: CurrentPost | null | undefined, b: CurrentPost | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.key === b.key &&
    a.title === b.title &&
    a.documentId === b.documentId &&
    a.blockCount === b.blockCount &&
    a.url === b.url
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('chat');
  /** undefined: 확인 중, null: 블로그 글쓰기 화면 아님 */
  const [post, setPost] = useState<CurrentPost | null | undefined>(undefined);
  const [server, setServer] = useState<'ok' | 'down' | 'no-key' | 'no-wood' | null>(null);
  /**
   * 화면 고정. null이면 활성 탭을 따라가고, 있으면 그 대화만 보여 준다.
   * 기록에서 고른 다른 글도 여기로 둔다.
   */
  const [pinKey, setPinKey] = useState<string | null>(null);
  /** 핀으로 다른 글을 볼 때 헤더용 */
  const [pinnedConv, setPinnedConv] = useState<Conversation | null>(null);
  /** convKey → 새 대화 리셋 횟수 (해당 Chat만 리마운트) */
  const [chatEpochs, setChatEpochs] = useState<Record<string, number>>({});
  /** 마운트 유지 중인 대화 (busy인 것은 숨겨도 유지) */
  const [mountedKeys, setMountedKeys] = useState<string[]>([]);
  /** 글쓰기 화면이 아니고 글 보기 화면이면 그 글 */
  const [viewing, setViewing] = useState<ViewedPost | null>(null);
  /** 예전에 연 글 정보 (숨은 Chat이 저장·적용할 때) */
  const [postCache, setPostCache] = useState<Record<string, CurrentPost>>({});
  const busyKeys = useRef(new Set<string>());
  const [, bumpBusy] = useState(0);
  /** convKey → 요청 중단 */
  const abortByKey = useRef(new Map<string, () => void>());
  /** tabId → convKey (작업 중인 에디터 탭) */
  const keyByTab = useRef(new Map<number, string>());

  const refreshPost = useCallback(async () => {
    let next: CurrentPost | null;
    try {
      next = await getCurrentPost();
    } catch {
      next = null;
    }
    const view = next ? null : await findViewedPost().catch(() => null);
    setPost((prev) => (samePost(prev, next) ? prev : next));
    if (next) setPostCache((c) => (samePost(c[next.key], next) ? c : { ...c, [next.key]: next }));
    setViewing((prev) => (prev?.url === view?.url && prev?.convKey === view?.convKey ? prev : view));
  }, []);

  const refreshServer = useCallback(async () => {
    try {
      const { account } = await checkHealth();
      setServer(!account ? 'no-key' : account.remaining <= 0 ? 'no-wood' : 'ok');
    } catch {
      setServer('down');
    }
  }, []);

  useEffect(() => watchTextSize(), []);

  // 패널을 다시 보면 배지 알림을 지운다.
  useEffect(() => {
    const clear = () => {
      if (document.visibilityState === 'visible') void clearBadge();
    };
    clear();
    document.addEventListener('visibilitychange', clear);
    return () => document.removeEventListener('visibilitychange', clear);
  }, []);

  useEffect(() => {
    refreshPost();
    refreshServer();
    const serverTimer = setInterval(refreshServer, SERVER_POLL_MS);
    const onTabChange = () => refreshPost();
    browser.tabs.onActivated.addListener(onTabChange);
    browser.tabs.onUpdated.addListener(onTabChange);
    browser.windows.onFocusChanged.addListener(onTabChange);
    return () => {
      clearInterval(serverTimer);
      browser.tabs.onActivated.removeListener(onTabChange);
      browser.tabs.onUpdated.removeListener(onTabChange);
      browser.windows.onFocusChanged.removeListener(onTabChange);
    };
  }, [refreshPost, refreshServer]);

  const followKey = post?.key ?? viewing?.convKey ?? null;
  const shownKey = pinKey ?? followKey;
  const isCurrent = !!post && shownKey === post.key;
  const isViewing = !post && !!viewing?.convKey && shownKey === viewing.convKey;
  const isPinnedAway = !!pinKey && pinKey !== followKey;

  useEffect(() => {
    if (!pinKey || pinKey === post?.key) {
      setPinnedConv(null);
      return;
    }
    let cancelled = false;
    loadConversation(pinKey).then(
      (c) => {
        if (!cancelled) setPinnedConv(c);
      },
      () => {
        if (!cancelled) setPinnedConv(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pinKey, post?.key, chatEpochs[pinKey ?? '']]);

  /** shownKey가 생기면 풀에 넣고, 안 보이고 busy도 아닌 키는 뺀다. */
  useEffect(() => {
    setMountedKeys((prev) => {
      let next = prev;
      if (shownKey && !prev.includes(shownKey)) next = [...prev, shownKey];
      const pruned = next.filter((k) => k === shownKey || busyKeys.current.has(k));
      if (pruned.length === next.length && next === prev) return prev;
      if (pruned.length === prev.length && pruned.every((k, i) => k === prev[i])) return prev;
      return pruned;
    });
  }, [shownKey, bumpBusy]);

  const [workspace, refreshWorkspace] = useWorkspaceState();
  const onReconnected = () => {
    // 진행 중인 Chat은 epoch를 올리지 않는다.
    setChatEpochs((prev) => {
      const next = { ...prev };
      for (const k of mountedKeys) {
        if (!busyKeys.current.has(k)) next[k] = (next[k] ?? 0) + 1;
      }
      return next;
    });
  };
  useEffect(() => onWorkspaceSettingsRequest(() => setScreen('settings')), []);
  const lastKind = useRef(workspace?.kind);
  useEffect(() => {
    const prev = lastKind.current;
    lastKind.current = workspace?.kind;
    if ((prev === 'prompt' || prev === 'missing') && workspace?.kind === 'ready') onReconnected();
  }, [workspace?.kind]);

  const onBusyChange = useCallback((key: string, busy: boolean) => {
    const had = busyKeys.current.has(key);
    if (busy) busyKeys.current.add(key);
    else busyKeys.current.delete(key);
    if (had !== busy) bumpBusy((n) => n + 1);
  }, []);

  const onRegisterAbort = useCallback((key: string, fn: () => void) => {
    abortByKey.current.set(key, fn);
  }, []);

  const onRunTab = useCallback((key: string, tabId: number | null) => {
    for (const [t, k] of keyByTab.current) {
      if (k === key) keyByTab.current.delete(t);
    }
    if (tabId !== null) keyByTab.current.set(tabId, key);
  }, []);

  /** 에디터와 문서 ID, 서버를 다시 확인하고 따라가기로 돌아간다. */
  const refresh = () => {
    forgetViewedPost();
    setPinKey(null);
    setPost(undefined);
    setServer(null);
    refreshPost();
    refreshServer();
  };

  const avail: Avail =
    post === undefined || server === null
      ? 'checking'
      : !post
        ? isViewing
          ? 'viewing'
          : 'not-editor'
        : !isCurrent
          ? 'other-post'
          : server === 'ok'
            ? 'ready'
            : server === 'down'
              ? 'server-down'
              : server;

  const openFromHistory = (key: string) => {
    setPinKey(key === post?.key ? null : key);
    setScreen('chat');
  };

  const togglePin = () => {
    if (pinKey) {
      setPinKey(null);
      refreshPost();
      return;
    }
    if (shownKey) setPinKey(shownKey);
  };

  const startOver = async () => {
    if (!shownKey) return;
    if (busyKeys.current.has(shownKey)) {
      await alertDialog('요청을 처리하는 중이에요. 끝난 뒤에 새 대화를 시작해 주세요.');
      return;
    }
    if (!(await confirmDialog('이 글의 대화를 비우고 새로 시작할까요?\n만든 이미지는 그대로 남아요.', { ok: '새로 시작' }))) return;
    try {
      await resetConversation(shownKey);
    } catch (err) {
      await alertDialog(err instanceof Error ? err.message : String(err));
      return;
    }
    setChatEpochs((prev) => ({ ...prev, [shownKey]: (prev[shownKey] ?? 0) + 1 }));
  };

  const onHistoryDeleted = (key: string) => {
    forgetViewedPost();
    if (key === viewing?.convKey) setViewing(null);
    if (key === pinKey) setPinKey(null);
    if (mountedKeys.includes(key) && !busyKeys.current.has(key)) {
      setMountedKeys((prev) => prev.filter((k) => k !== key));
    }
    if (key === shownKey) {
      setChatEpochs((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
    }
  };

  useEffect(() => {
    const onRemoved = (tabId: number) => {
      const key = keyByTab.current.get(tabId);
      if (key) {
        keyByTab.current.delete(tabId);
        abortByKey.current.get(key)?.();
        if (pinKey === key) setPinKey(null);
      }
      void refreshPost();
    };
    browser.tabs.onRemoved.addListener(onRemoved);
    return () => browser.tabs.onRemoved.removeListener(onRemoved);
  }, [pinKey, refreshPost]);

  const [navTab, setNavTab] = useState<NavTab | undefined>();
  const referLib = useRef<((uri: string, meta: ImageMeta | null, name?: string) => void) | null>(null);
  const registerReferLib = useCallback((fn: (uri: string, meta: ImageMeta | null, name?: string) => void) => {
    referLib.current = fn;
  }, []);
  const openNav = (tab?: NavTab) => {
    setNavTab(tab);
    setScreen('nav');
  };

  const header = isCurrent
    ? { title: post.title || '제목 없음', meta: `${postStatus(post.documentId)} · 블록 ${post.blockCount}개` }
    : isPinnedAway
      ? {
          title: pinnedConv?.title || '제목 없음',
          meta: pinnedConv ? `${postStatus(pinnedConv.documentId)} · 고정 · 다른 글의 대화` : '고정',
        }
      : isViewing
        ? { title: viewing.title || '제목 없음', meta: '글 보기 화면 · 대화 읽기만 가능' }
        : { title: '연결된 글 없음', meta: 'blog.naver.com' };

  const chatSlots = useMemo(() => {
    const keys = new Set(mountedKeys);
    if (shownKey) keys.add(shownKey);
    return [...keys];
  }, [mountedKeys, shownKey]);

  return (
    <div className="app">
      <DialogHost />
      {/* 다른 화면을 보는 동안에도 진행 중인 요청과 입력 내용이 유지되도록 숨기기만 한다. */}
      <div className="screen" hidden={screen !== 'chat' && screen !== 'nav'}>
        <Header
          title={header.title}
          meta={header.meta}
          dot={AVAIL[avail].dot}
          left={
            <IconButton name="menu" label="블로그 글 · 대화 기록 · 보관함 · 계정" onClick={() => openNav()} />
          }
          right={
            <>
              {shownKey ? (
                <IconButton
                  name="pin"
                  label={pinKey ? '고정 해제 · 활성 탭 따라가기' : '이 대화 화면에 고정'}
                  onClick={togglePin}
                  active={!!pinKey}
                />
              ) : undefined}
              <IconButton name="library" label="보관함" onClick={() => openNav('lib')} />
              {shownKey ? <IconButton name="compose" label="새 대화" onClick={startOver} /> : undefined}
            </>
          }
        />
        <WorkspaceBanner state={workspace} onChecked={refreshWorkspace} />
        <WorkspaceTip state={workspace} onChanged={onReconnected} />
        {chatSlots.map((key) => {
          const visible = key === shownKey;
          const epoch = chatEpochs[key] ?? 0;
          return (
            <div key={`${key}:${epoch}`} className="chat-slot" hidden={!visible}>
              <Chat
                convKey={key}
                post={post?.key === key ? post : (postCache[key] ?? null)}
                avail={
                  visible
                    ? avail
                    : post?.key === key
                      ? avail
                      : postCache[key]
                        ? 'other-post'
                        : 'not-editor'
                }
                onRefresh={refresh}
                onBusyChange={onBusyChange}
                onRequestFailed={refreshServer}
                onStorageError={refreshWorkspace}
                onRegisterReferLib={visible ? registerReferLib : undefined}
                onRegisterAbort={onRegisterAbort}
                onRunTab={onRunTab}
              />
            </div>
          );
        })}
        {!shownKey && (
          <>
            <div className="chat-log" />
            <BlockedComposer avail={avail} onRefresh={refresh} />
          </>
        )}
        {screen === 'nav' && (
          <NavPanel
            currentKey={shownKey ?? undefined}
            currentUrl={post?.url ?? viewing?.url}
            initialTab={navTab}
            onClose={() => {
              setNavTab(undefined);
              setScreen('chat');
            }}
            onOpenChat={openFromHistory}
            onChatDeleted={onHistoryDeleted}
            onSettings={() => setScreen('settings')}
            onDev={import.meta.env.DEV ? () => setScreen('dev') : undefined}
            onReferImage={
              shownKey
                ? (uri, meta, name) => {
                    referLib.current?.(uri, meta, name);
                  }
                : undefined
            }
          />
        )}
      </div>

      {screen === 'settings' && (
        <div className="screen">
          <Settings
            onBack={() => setScreen('chat')}
            onCleared={() =>
              setChatEpochs((prev) => {
                const next = { ...prev };
                for (const k of mountedKeys) next[k] = (next[k] ?? 0) + 1;
                return next;
              })
            }
            onAccountChanged={refreshServer}
          />
        </div>
      )}
      {import.meta.env.DEV && screen === 'dev' && (
        <div className="screen">
          <Header
            title="개발자 도구"
            meta="개발 빌드에서만 보여요"
            left={<IconButton name="back" label="뒤로" onClick={() => setScreen('chat')} />}
          />
          <div className="page devtools">
            <DevTools onServerChanged={refreshServer} />
          </div>
        </div>
      )}
    </div>
  );
}
