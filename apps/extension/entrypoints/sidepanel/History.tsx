import { useEffect, useState } from 'react';
import { deleteConversation, formatDate, listConversations, type ConversationSummary } from '@/lib/conversations';
import { Dot, IconButton } from './ui';
import { useWorkspaceState } from './Workspace';
import { confirmDialog } from '@/lib/dialog';

export function postStatus(documentId: string): string {
  return documentId ? '저장된 글' : '저장 전 글';
}

/** 탐색 서랍의 대화 기록 탭 */
export function HistoryList({
  currentKey,
  onOpen,
  onDeleted,
}: {
  currentKey?: string;
  onOpen: (key: string) => void;
  onDeleted: (key: string) => void;
}) {
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [query, setQuery] = useState('');

  const [error, setError] = useState('');
  const [workspace] = useWorkspaceState();

  const reload = () =>
    listConversations().then(
      (list) => {
        setItems(list);
        setError('');
      },
      (err) => setError(err instanceof Error ? err.message : String(err)),
    );
  useEffect(() => {
    reload();
  }, [workspace?.kind]);

  const remove = async (item: ConversationSummary) => {
    if (!(await confirmDialog(`"${item.title || '제목 없음'}"의 대화 기록을 지울까요?`, { ok: '지우기', danger: true }))) return;
    try {
      await deleteConversation(item.key);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    onDeleted(item.key);
    reload();
  };

  const q = query.trim().toLowerCase();
  const filtered = (items ?? []).filter((c) => !q || c.searchText.includes(q));
  const current = filtered.find((c) => c.key === currentKey);
  const others = filtered.filter((c) => c.key !== currentKey);

  const renderItem = (c: ConversationSummary, isCurrent: boolean) => (
    <div key={c.key} className={`history-item ${isCurrent ? 'current' : ''}`} onClick={() => onOpen(c.key)}>
      <div className="history-item-main">
        <div className="history-item-title">
          {isCurrent && <Dot kind="on" />}
          <span>{c.title || '제목 없음'}</span>
        </div>
        {c.preview && <div className="history-item-preview">{c.preview}</div>}
        <div className="history-item-meta">
          {formatDate(c.updatedAt)} · 요청 {c.turns}번 · {postStatus(c.documentId)}
        </div>
      </div>
      <IconButton
        name="trash"
        label="기록 지우기"
        onClick={(e) => {
          e.stopPropagation();
          remove(c);
        }}
      />
    </div>
  );

  return (
    <>
      {error && <p className="empty-hint error">{error}</p>}
      <div className="drawer-search">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="글 제목이나 대화 내용 검색" />
      </div>
      <div className="drawer-list">
        {current && (
          <>
            <div className="group-label">지금 쓰는 글</div>
            {renderItem(current, true)}
          </>
        )}
        {others.length > 0 && (
          <>
            <div className="group-label">다른 글</div>
            {others.map((c) => renderItem(c, false))}
          </>
        )}
        {items && filtered.length === 0 && (
          <p className="empty-hint">{q ? '검색 결과가 없어요.' : '아직 저장된 대화가 없어요.'}</p>
        )}
      </div>
      <div className="drawer-foot">
        글마다 대화 하나 · {workspace?.kind === 'ready' ? `작업공간 ${workspace.name}에 저장` : '이 PC에만 저장'}
      </div>
    </>
  );
}
