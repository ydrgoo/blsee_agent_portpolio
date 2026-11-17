import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  PRESETS,
  RESERVED_PROMPT_COMMANDS,
  isCommandName,
  paramNameOf,
  type PresetId,
  type PromptParam,
  type PromptScope,
} from '@blog-helper/shared';
import { activeWorkspace } from '@/lib/workspace';
import { deletePrompt, findPrompt, listPrompts, storePrompt, updatePrompt, type SavedPromptFile } from '@/lib/workspace-store';
import { confirmDialog } from '@/lib/dialog';

type Props = {
  convKey: string;
  onClose: () => void;
  onSaved: (command: string) => void;
  /** 입력창에 넣어 실행할 글 (예: "/doodle-sheet") */
  onRun: (text: string) => void;
};

type Filter = 'all' | 'post' | 'global' | 'quick';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: '전체' },
  { id: 'post', label: '이 글' },
  { id: 'global', label: '모든 글' },
  { id: 'quick', label: '빠른 실행' },
];

const ON_LABEL = { text: '문단', image: '이미지', table: '표', any: '어디서나' } as const;

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const SLOT_KEY = IS_MAC ? '⌘K' : 'Ctrl+K';
const SLOT_RE = /\{\{([^{}]+)\}\}/g;

/** 편집 중인 프롬프트 */
type Draft = {
  id?: string;
  name: string;
  command: string;
  description: string;
  scope: PromptScope;
  body: string;
  /** 칸 이름 → 설명 */
  notes: Record<string, string>;
  /** 칸 이름 → 칸으로 바꾸기 전 글 (풀 때 되돌린다) */
  origins: Record<string, string>;
};

const emptyDraft = (): Draft => ({ name: '', command: '', description: '', scope: 'post', body: '', notes: {}, origins: {} });

/** 본문에 나오는 칸 이름 (처음 나온 순서, 이름마다 한 번) */
function slotsOf(body: string): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const m of body.matchAll(SLOT_RE)) {
    const name = m[1].trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count }));
}

/** 채팅에서 여는 프롬프트 목록: 저장 프롬프트는 실행·추가·수정·삭제, 빠른 실행은 자세히 보고 실행한다. */
export function PromptList({ convKey, onClose, onSaved, onRun }: Props) {
  const [items, setItems] = useState<SavedPromptFile[]>([]);
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [quick, setQuick] = useState<PresetId | null>(null);
  const [error, setError] = useState('');

  const reload = () => {
    void activeWorkspace().then(async (root) => {
      setReady(!!root);
      setItems(root ? await listPrompts(root, convKey) : []);
    });
  };
  useEffect(reload, [convKey]);

  const q = query.trim().toLowerCase();
  const match = (...texts: string[]) => !q || texts.some((t) => t.toLowerCase().includes(q));
  const shown = items.filter((it) => match(it.name, it.command, it.description));
  const quickIds = (Object.keys(PRESETS) as PresetId[]).filter((id) => match(PRESETS[id].label, PRESETS[id].command, PRESETS[id].description));
  const postItems = shown.filter((it) => it.scope === 'post');
  const allItems = shown.filter((it) => it.scope === 'all');

  const startEdit = async (item: SavedPromptFile) => {
    const root = await activeWorkspace();
    const full = root ? await findPrompt(root, convKey, item.command) : null;
    if (!full) {
      setError('프롬프트 파일을 읽지 못했습니다.');
      return;
    }
    setError('');
    setDraft({
      id: full.id,
      name: full.name,
      command: full.command,
      description: full.description,
      scope: full.scope,
      body: full.body,
      notes: Object.fromEntries(full.params.map((p) => [p.name, p.description ?? ''])),
      origins: {},
    });
  };

  const remove = async (item: SavedPromptFile) => {
    const ok = await confirmDialog(`「${item.name}」 프롬프트를 삭제하시겠습니까?\n/${item.command} 명령도 함께 없어져요.`, { ok: '삭제', danger: true });
    if (!ok) return;
    const root = await activeWorkspace();
    if (root) await deletePrompt(root, item.id);
    setOpen(null);
    reload();
  };

  if (draft) {
    return (
      <Shell onClose={onClose}>
        <PromptEditor
          draft={draft}
          ready={ready}
          onBack={() => setDraft(null)}
          onChange={setDraft}
          onSave={async (d) => {
            const root = await activeWorkspace();
            if (!root) return '프롬프트를 저장하려면 작업공간 폴더가 필요합니다.';
            const params: PromptParam[] = slotsOf(d.body).map(({ name }) => ({ name, description: d.notes[name] ?? '' }));
            const input = { name: d.name.trim(), command: d.command.trim().toLowerCase(), description: d.description, scope: d.scope, body: d.body.trim(), params };
            const saved = d.id ? await updatePrompt(root, convKey, d.id, input) : await storePrompt(root, convKey, input);
            setDraft(null);
            reload();
            onSaved(saved);
            return '';
          }}
        />
      </Shell>
    );
  }

  if (quick) {
    return (
      <Shell onClose={onClose}>
        <QuickDetail
          id={quick}
          onBack={() => setQuick(null)}
          onRun={(extra) => onRun(`/${PRESETS[quick].command}${extra.trim() ? ` ${extra.trim()}` : ''}`)}
          onCopy={() => {
            const p = PRESETS[quick];
            setQuick(null);
            setDraft({ ...emptyDraft(), name: `${p.label} (내 버전)`, command: `my-${p.command}`, description: p.description, body: p.message });
          }}
        />
      </Shell>
    );
  }

  const savedRow = (item: SavedPromptFile) => {
    const expanded = open === item.id;
    return (
      <div key={item.id} className={`pl-row${expanded ? ' open' : ''}`}>
        <button type="button" className="pl-row-main" onClick={() => setOpen(expanded ? null : item.id)} aria-expanded={expanded}>
          <span className="pl-row-name">{item.name}</span>
          <code className="pl-cmd">/{item.command}</code>
          <span className="pl-row-desc">
            {item.description || '설명 없음'}
            {!expanded && ` · 칸 ${item.params.length ? `${item.params.length}개` : '없음'}`}
          </span>
        </button>
        {expanded && (
          <>
            {item.params.length > 0 && (
              <div className="pl-chips">
                {item.params.map((p) => (
                  <code key={p.name} className="pl-slot">
                    {p.name}
                  </code>
                ))}
              </div>
            )}
            <div className="pl-row-actions">
              <button type="button" className="primary" onClick={() => onRun(`/${item.command}`)}>
                실행
              </button>
              <button type="button" onClick={() => void startEdit(item)}>
                수정
              </button>
              <button type="button" className="danger" onClick={() => void remove(item)}>
                삭제
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  const group = (title: string, list: SavedPromptFile[]) => (
    <section className="pl-group">
      <h3>{title}</h3>
      {list.length ? list.map(savedRow) : <p className="pl-empty">{q ? '찾는 프롬프트가 없어요' : '아직 없어요'}</p>}
    </section>
  );

  return (
    <Shell onClose={onClose}>
      <div className="pl-head">
        <div>
          <strong>프롬프트</strong>
          <span>/명령으로 불러 쓰는 내 작업</span>
        </div>
        <button type="button" className="pl-icon" aria-label="닫기" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="pl-tools">
        <input value={query} placeholder="검색" onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="primary" onClick={() => setDraft(emptyDraft())}>
          + 새로 만들기
        </button>
      </div>
      <div className="pl-filters" role="tablist">
        {FILTERS.map((f) => {
          const count = f.id === 'all' ? shown.length + quickIds.length : f.id === 'post' ? postItems.length : f.id === 'global' ? allItems.length : quickIds.length;
          return (
            <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
              {f.label} {count}
            </button>
          );
        })}
      </div>
      {!ready && <p className="pl-empty pl-warn">작업공간 폴더가 있어야 프롬프트를 저장할 수 있어요.</p>}
      {error && <p className="pl-empty pl-warn">{error}</p>}
      <div className="pl-list">
        {(filter === 'all' || filter === 'post') && group('이 글', postItems)}
        {(filter === 'all' || filter === 'global') && group('모든 글', allItems)}
        {(filter === 'all' || filter === 'quick') && (
          <section className="pl-group pl-quick">
            <h3>빠른 실행 · 기본 제공</h3>
            {quickIds.map((id) => (
              <button key={id} type="button" className="pl-quick-row" onClick={() => setQuick(id)}>
                <span className="pl-quick-text">
                  <span className="pl-row-name">{PRESETS[id].label}</span>
                  <span className="pl-row-desc">{PRESETS[id].description}</span>
                </span>
                <span className="pl-tag">{ON_LABEL[PRESETS[id].on]}</span>
                <span aria-hidden="true">›</span>
              </button>
            ))}
          </section>
        )}
      </div>
      <div className="pl-foot">대화에서 /make-prompt, /save-prompt로도 만들 수 있어요</div>
    </Shell>
  );
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="overlay">
      <div className="drawer prompt-list">{children}</div>
      <div className="overlay-dim" onClick={onClose} />
    </div>
  );
}

function QuickDetail({ id, onBack, onRun, onCopy }: { id: PresetId; onBack: () => void; onRun: (extra: string) => void; onCopy: () => void }) {
  const p = PRESETS[id];
  const [extra, setExtra] = useState('');
  return (
    <>
      <div className="pl-bar">
        <button type="button" className="pl-icon" aria-label="목록으로" onClick={onBack}>
          ‹
        </button>
        <strong>빠른 실행</strong>
      </div>
      <div className="pl-body">
        <div className="pl-title">
          <span>{p.label}</span>
          <em className="pl-tag">기본 제공</em>
        </div>
        <code className="pl-cmd">/{p.command}</code>
        <p className="pl-text">{p.description}</p>
        <div className="pl-field">
          <span className="pl-label">이렇게 진행해요</span>
          <ol className="pl-steps">
            {p.steps.map((step, i) => (
              <li key={step}>
                <span>{i + 1}</span>
                {step}
              </li>
            ))}
          </ol>
        </div>
        <div className="pl-field">
          <span className="pl-label">보내는 말</span>
          <div className="pl-quote">{p.message}</div>
          <span className="pl-hint">덧붙인 말은 이 뒤에 이어 붙어요. 대상은 에디터에서 가리킨 {ON_LABEL[p.on]}이에요.</span>
        </div>
        <label className="pl-field">
          <span className="pl-label">덧붙일 말</span>
          <textarea rows={2} value={extra} placeholder="추가 요청 (선택)" onChange={(e) => setExtra(e.target.value)} />
        </label>
      </div>
      <div className="pl-actions">
        <button type="button" onClick={onCopy}>
          복사해서 내 프롬프트로
        </button>
        <button type="button" className="primary grow" onClick={() => onRun(extra)}>
          실행
        </button>
      </div>
    </>
  );
}

function PromptEditor({
  draft,
  ready,
  onBack,
  onChange,
  onSave,
}: {
  draft: Draft;
  ready: boolean;
  onBack: () => void;
  onChange: (d: Draft) => void;
  onSave: (d: Draft) => Promise<string>;
}) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState('');
  /** ⌘K로 칸을 만드는 중: 고른 구간과 이름 */
  const [naming, setNaming] = useState<{ start: number; end: number; text: string; name: string } | null>(null);
  const slots = useMemo(() => slotsOf(draft.body), [draft.body]);
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });

  const onBodyKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key.toLowerCase() !== 'k' || !(IS_MAC ? e.metaKey : e.ctrlKey)) return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? start;
    const text = draft.body.slice(start, end);
    setNaming({ start, end, text, name: paramNameOf(text) });
  };

  /** 이름을 정해 고른 자리를 칸으로 바꾼다. 같은 이름이면 같은 칸이 여러 곳에 들어간다. */
  const commitSlot = () => {
    if (!naming) return;
    const name = paramNameOf(naming.name) || `slot-${slots.length + 1}`;
    const token = `{{${name}}}`;
    const body = `${draft.body.slice(0, naming.start)}${token}${draft.body.slice(naming.end)}`;
    onChange({
      ...draft,
      body,
      origins: draft.origins[name] !== undefined || !naming.text ? draft.origins : { ...draft.origins, [name]: naming.text },
    });
    setNaming(null);
    requestAnimationFrame(() => {
      const el = bodyRef.current;
      if (!el) return;
      el.focus();
      const caret = naming.start + token.length;
      el.setSelectionRange(caret, caret);
    });
  };

  const renameSlot = (from: string, raw: string) => {
    const to = paramNameOf(raw);
    if (!to || to === from) return;
    const { [from]: note = '', ...notes } = draft.notes;
    const { [from]: origin, ...origins } = draft.origins;
    set({
      body: draft.body.split(`{{${from}}}`).join(`{{${to}}}`),
      notes: { ...notes, [to]: notes[to] ?? note },
      origins: origin !== undefined ? { ...origins, [to]: origin } : origins,
    });
  };

  const unbindSlot = (name: string) => {
    const { [name]: _n, ...notes } = draft.notes;
    const { [name]: origin, ...origins } = draft.origins;
    set({ body: draft.body.split(`{{${name}}}`).join(origin ?? name), notes, origins });
  };

  const save = async () => {
    const command = draft.command.trim().toLowerCase();
    if (!draft.name.trim() || !draft.body.trim()) {
      setError('이름과 본문을 적어 주세요.');
      return;
    }
    if (!isCommandName(command) || RESERVED_PROMPT_COMMANDS.includes(command)) {
      setError('명령은 소문자 영문, 숫자, -, _만 쓸 수 있어요.');
      return;
    }
    setError(await onSave(draft));
  };

  return (
    <>
      <div className="pl-bar">
        <button type="button" className="pl-icon" aria-label="목록으로" onClick={onBack}>
          ‹
        </button>
        <strong>{draft.id ? '프롬프트 수정' : '새 프롬프트'}</strong>
        <button type="button" className="primary" onClick={() => void save()} disabled={!ready}>
          저장
        </button>
      </div>
      <div className="pl-body">
        {!ready && <p className="pl-empty pl-warn">작업공간 폴더가 있어야 저장할 수 있어요.</p>}
        {error && <p className="pl-empty pl-warn">{error}</p>}
        <div className="pl-grid">
          <label className="pl-field">
            <span className="pl-label">이름</span>
            <input value={draft.name} placeholder="프롬프트 이름" onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="pl-field">
            <span className="pl-label">명령</span>
            <span className="pl-cmd-input">
              <span>/</span>
              <input value={draft.command} placeholder="command-name" onChange={(e) => set({ command: e.target.value })} />
            </span>
          </label>
        </div>
        <label className="pl-field">
          <span className="pl-label">설명</span>
          <input value={draft.description} placeholder="프롬프트 설명 (선택)" onChange={(e) => set({ description: e.target.value })} />
        </label>
        <div className="pl-field">
          <span className="pl-label">쓰는 곳</span>
          <div className="pl-segment">
            <button type="button" className={draft.scope === 'post' ? 'on' : ''} onClick={() => set({ scope: 'post' })}>
              이 글에서만
            </button>
            <button type="button" className={draft.scope === 'all' ? 'on' : ''} onClick={() => set({ scope: 'all' })}>
              모든 글에서
            </button>
          </div>
        </div>
        <div className="pl-field">
          <div className="pl-label-row">
            <span className="pl-label">본문</span>
            <span className="pl-hint">
              글자를 고르고 <kbd>{SLOT_KEY}</kbd> 칸 만들기
            </span>
          </div>
          <textarea
            ref={bodyRef}
            className="pl-editor"
            value={draft.body}
            rows={10}
            placeholder="프롬프트 내용"
            onChange={(e) => set({ body: e.target.value })}
            onKeyDown={onBodyKey}
          />
          {naming && (
            <div className="pl-naming">
              <span className="pl-hint">{naming.text ? `"${naming.text.slice(0, 30)}" → 칸 이름` : '커서 자리에 칸 넣기 · 칸 이름'}</span>
              <input
                autoFocus
                value={naming.name}
                placeholder="slot-name"
                onChange={(e) => setNaming({ ...naming, name: e.target.value })}
                onBlur={commitSlot}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    commitSlot();
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setNaming(null);
                    bodyRef.current?.focus();
                  }
                }}
              />
              <span className="pl-hint">다른 곳을 누르면 추가돼요 · Esc 취소</span>
            </div>
          )}
        </div>
        <div className="pl-field">
          <div className="pl-label-row">
            <span className="pl-label">칸 {slots.length}개</span>
            <span className="pl-hint">실행할 때 이 순서로 물어요</span>
          </div>
          {slots.length === 0 && <p className="pl-empty">칸이 없어요. 칸 없이 그대로 실행해요.</p>}
          {slots.map(({ name, count }) => (
            <div key={name} className="pl-slot-card">
              <div className="pl-slot-top">
                <label className="pl-field grow">
                  <span className="pl-hint">칸 이름</span>
                  <input className="mono" defaultValue={name} key={name} onBlur={(e) => renameSlot(name, e.target.value)} />
                </label>
                <span className="pl-hint">본문 {count}곳</span>
                <button type="button" className="pl-icon" aria-label={`${name} 칸 풀기`} onClick={() => unbindSlot(name)}>
                  ✕
                </button>
              </div>
              <label className="pl-field">
                <span className="pl-hint">칸 설명</span>
                <input
                  value={draft.notes[name] ?? ''}
                  placeholder="칸 설명 (선택)"
                  onChange={(e) => set({ notes: { ...draft.notes, [name]: e.target.value } })}
                />
              </label>
            </div>
          ))}
          {slots.length > 0 && <span className="pl-hint">칸 이름을 바꾸면 본문의 같은 칸이 모두 바뀌어요. 풀면 원래 글로 돌아가요.</span>}
        </div>
      </div>
    </>
  );
}
