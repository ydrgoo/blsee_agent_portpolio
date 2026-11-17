import {
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import iconUrl from '@/assets/icon.svg';
import {
  BlockRefs,
  blockImages,
  blockImageUri,
  blockNames,
  blockText,
  diffDocuments,
  DOC_URI_SRC,
  fillPendingFormula,
  fillPendingImage,
  GEN_URI_SRC,
  genImageUri,
  newGenImageId,
  paragraphText,
  parseImageUri,
  parseUri,
  PENDING_IMAGE_KEY,
  pendingFormulas,
  pendingImages,
  rangeUri,
  typeLabel,
  type BlockChange,
  type SeComponent,
  type SeDocumentData,
} from '@blog-helper/se-model';
import {
  PRESETS,
  PROMPT_MAKE_COMMAND,
  PROMPT_MAKE_LABEL,
  PROMPT_SAVE_COMMAND,
  PROMPT_SAVE_LABEL,
  RESERVED_PROMPT_COMMANDS,
  commandQueryMatch,
  presetBlockOf,
  presetsFor,
  askAnswerText,
  askContentFromText,
  askDefaults,
  askPackedContent,
  validateAskContent,
  type AskAnswer,
  type AskPropertySchema,
  type AskRequest,
  type ChatTurn,
  type PresetId,
  type PresetRequest,
  type PromptCreate,
  type PromptScope,
  isHtmlUri,
  type RefItem,
  type ReviewResult,
  type TurnMeta,
  type TurnPoint,
  type UsagePurpose,
} from '@blog-helper/shared';
import {
  currentPickerItem,
  currentPickerItems,
  asInlineRef,
  docPickerItems,
  hydrateRefs,
  pickerToRef,
  refFromLib,
  splitInlineRefs,
  type PickerItem,
} from '@/lib/composer-refs';
import { ComposerInput, type ComposerInputHandle } from './ComposerInput';
import { PromptList } from './PromptList';
import { loadConversation, saveConversation, type ChatMessage, type PlanTaskItem } from '@/lib/conversations';
import { DocSession } from '@/lib/doc-session';
import {
  activeTabId,
  getEditorFocus,
  pinEditorTab,
  pinnedEditorTab,
  readDocument,
  revealBlock,
  writeDocument,
  type CurrentPost,
  type EditorFocus,
} from '@/lib/editor-client';
import { clearBadge, notifyIfInactive } from '@/lib/notify';
import {
  downloadName,
  getImage,
  getImageInfo,
  linkImageSource,
  putImage,
  type ImageMeta,
} from '@/lib/image-store';
import { activeWorkspace, workspaceState, WorkspaceUnavailableError } from '@/lib/workspace';
import { findPrompt, listPrompts, type SavedPromptFile } from '@/lib/workspace-store';
import { fetchPstatic, resolveImageUri, thumbnailUrl } from '@/lib/images';
import { uploadImage } from '@/lib/image-upload';
import { uploadFormula } from '@/lib/formula';
import { onPanelAction, takePanelAction, type PanelAction } from '@/lib/panel-action';
import { loadRecentCommands, rememberCommand } from '@/lib/recent-commands';
import { runAgent, ServerError } from '@/lib/server';
import {
  ASK_SKIP,
  isAskSkipped,
  loadSettings,
  onSettingsChange,
  setAskSkipped,
  type UserSettings,
} from '@/lib/settings';
import { formatWood, recordRequest } from '@/lib/wood';
import { ImagePreview } from './ImagePreview';
import { AVAIL, Dot, type Avail } from './ui';

interface Proposal {
  /** 요청 시점의 에디터 문서 */
  base: SeDocumentData;
  /** 에이전트가 고친 문서 */
  working: SeDocumentData;
  changes: BlockChange[];
  /** 글 편집이 들어 있는지 (이미지 넣기 말고) */
  hasEdits: boolean;
  /** 새로 올려야 하는 이미지 수 */
  imageCount: number;
}

const CHANGE_LABEL: Record<BlockChange['kind'], string> = {
  added: '추가',
  removed: '삭제',
  modified: '수정',
  moved: '이동',
};

const GEN_URI = new RegExp(GEN_URI_SRC);
const SELECTION_POLL_MS = 700;
const CHIP_CHARS = 20;

/** URI가 가리키는 (첫) 블록 참조. 범위는 시작 블록, 블록 이미지는 그 블록 */
function blockOfRef(uri: string): string | undefined {
  const u = parseUri(uri);
  if (!u || u.kind === 'gen' || u.kind === 'html') return undefined;
  return u.kind === 'range' ? u.from : u.ref;
}

/** 블록 안 몇 번째 이미지인지: "blsee://block/4/image/2" → 2, 그 밖은 1 */
function imageIndexOf(uri: string): number {
  const u = parseUri(uri);
  return u?.kind === 'image' ? u.index : 1;
}

const isRange = (uri: string) => parseUri(uri)?.kind === 'range';

const newTurnId = () => `t-${crypto.randomUUID().slice(0, 8)}`;

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** 에이전트에게 알려 주는 턴 시각 (예: "2026-11-02 00:45 (월)") */
function turnTime(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} (${WEEKDAYS[d.getDay()]})`;
}

function clip(text: string): string {
  return text.length > CHIP_CHARS ? `${text.slice(0, CHIP_CHARS)}…` : text;
}

/**
 * 칩 이름: 개요와 같은 블록 이름("문단 3", "인용구 2", "이미지 4")에 내용을 조금 붙인다.
 * 이미지는 묶음 안 순서와 캡션 (예: "이미지 묶음 1 (2/3) · 고양이"). 파일 이름은 대개 같아서 쓰지 않는다.
 */
function blockChipLabel(doc: SeDocumentData, c: SeComponent, imageIndex: number): string {
  const name = blockNames(doc).get(c.id) ?? typeLabel(c['@ctype']);
  const imgs = blockImages(c);
  if (imgs.length) {
    const img = imgs[imageIndex - 1];
    const pending = typeof img?.[PENDING_IMAGE_KEY] === 'string' ? ' (새 이미지)' : '';
    const sub = imgs.length > 1 ? ` (${imageIndex}/${imgs.length})` : '';
    const captionOf = (x: unknown) =>
      Array.isArray(x) ? x.map((p) => paragraphText(p)).join(' ').trim() : '';
    const caption = captionOf(img?.caption) || captionOf(c.caption);
    return clip(`${name}${sub}${pending}${caption ? ` · ${caption}` : ''}`);
  }
  const type = typeLabel(c['@ctype']);
  const preview = blockText(c)
    .replace(/^\((.*)\)$/s, '$1')
    .replace(new RegExp(`^${type}:?\\s*`), '')
    .replace(/\s+/g, ' ')
    .trim();
  return clip(preview && name !== preview ? `${name}: ${preview}` : name);
}

function genThumb(convKey: string, uri: string): Promise<string | null> {
  return thumbnailUrl(`${convKey}|${uri}`, () => getImage(convKey, uri));
}

function pstaticThumb(src: string): Promise<string | null> {
  return thumbnailUrl(src, () => fetchPstatic(src, 'w80'));
}

function sameComponents(a: SeDocumentData, b: SeDocumentData): boolean {
  return JSON.stringify(a.document.components) === JSON.stringify(b.document.components);
}

function makeProposal(base: SeDocumentData, working: SeDocumentData): Proposal | null {
  const changes = diffDocuments(base, working);
  if (!changes.length) return null;
  const imageCount = pendingImages(working).length;
  // 대기 이미지 하나는 변경 하나(추가 또는 교체)로 잡힌다. 그 밖의 변경이 있으면 글 편집이다.
  return { base, working, changes, hasEdits: changes.length > imageCount, imageCount };
}

/** 제안 적용 확인이 필요한지: 들어 있는 종류 중 건너뛰지 않은 것이 있으면 묻는다. */
function needsProposalConfirm(p: Proposal, s: UserSettings): boolean {
  return (
    (p.hasEdits && !isAskSkipped(s, ASK_SKIP.proposalEdits)) ||
    (p.imageCount > 0 && !isAskSkipped(s, ASK_SKIP.proposalImages))
  );
}

/** ✕로 뺀 현재 위치를 기억하는 키. 커서가 다른 곳으로 가면 다시 붙는다. */
function focusKey(f: EditorFocus): string {
  return `${f.anchorId}|${f.focusId}|${f.label}`;
}

/** 블록을 알면 그 블록용 커맨드만, 모르면 기본 커맨드를 모두 보여 준다. */
function slashPresetIds(focus: EditorFocus | null): PresetId[] {
  if (focus?.ctype) return presetsFor(presetBlockOf(focus.ctype), focus.blockCount > 1);
  if (focus && focus.blockCount > 1) return presetsFor('other', true);
  return Object.keys(PRESETS) as PresetId[];
}

function splitSlash(raw: string): { command: string; extra: string } | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(raw.trim());
  if (!match) return null;
  return { command: match[1], extra: (match[2] ?? '').trim() };
}

function presetFromCommand(command: string): PresetId | null {
  const key = command.toLowerCase();
  return (Object.keys(PRESETS) as PresetId[]).find((id) => PRESETS[id].command === key) ?? null;
}

/** 현재 선택이 그 커맨드의 대상 칸에 들어갈 수 있는지. */
function focusFitsPreset(id: PresetId, focus: EditorFocus | null): focus is EditorFocus {
  if (!focus) return false;
  if (focus.blockCount > 1) return PRESETS[id].on === 'any';
  if (!focus.ctype) return false;
  const block = presetBlockOf(focus.ctype);
  if (block === null) return false;
  return presetsFor(block).includes(id);
}

/** 슬래시 대상 목록. @ 피커와 같은 행이고, 그 커맨드가 받는 블록만 남긴다. */
function presetAskItems(id: PresetId, doc: SeDocumentData, blockRefs: BlockRefs): PickerItem[] {
  return docPickerItems(doc, blockRefs).filter((item) => {
    const blockRef = blockOfRef(item.doc);
    const cid = blockRef ? blockRefs.idOf(blockRef) : undefined;
    const c = cid ? doc.document.components.find((x) => x.id === cid) : undefined;
    if (!c) return false;
    const block = presetBlockOf(c['@ctype']);
    if (block === null) return false;
    if (presetsFor(block).includes(id)) return true;
    return PRESETS[id].on === 'image' && !!item.image;
  });
}

/** 고른 피커 행을 포커스로. 묶음이면 그 장만 가리킨다. */
function focusForAsk(doc: SeDocumentData, c: SeComponent, item: PickerItem): EditorFocus {
  const base = focusOf(doc, c);
  const u = parseUri(item.doc);
  const imgs = blockImages(c);
  const img = u?.kind === 'image' ? imgs[Math.max(0, u.index - 1)] : imgs[0];
  const src = img && typeof img.src === 'string' ? img.src : base.imageSrc;
  return {
    ...base,
    label: `${item.kind}: ${item.snippet}`,
    ...(typeof src === 'string' ? { imageSrc: src } : {}),
  };
}

function focusOf(doc: SeDocumentData, c: SeComponent): EditorFocus {
  const ctype = c['@ctype'];
  const imageSrc = blockImages(c)[0]?.src;
  const paragraph = ctype === 'text' ? blockText(c).trim() : '';
  return {
    anchorId: c.id,
    focusId: c.id,
    blockCount: 1,
    label: blockNames(doc).get(c.id) ?? typeLabel(ctype),
    ctype,
    ...(paragraph ? { paragraph } : {}),
    ...(typeof imageSrc === 'string' ? { imageSrc } : {}),
  };
}

/** 저장 프롬프트의 칸을 채운다. 빈 칸은 빈 글로, 덧붙일 말은 맨 뒤에 붙인다. */
function fillSavedPrompt(prompt: SavedPromptFile, values: Record<string, string>, extra = ''): string {
  const body = prompt.body.replace(/\{\{([^{}]+)\}\}/g, (_, name: string) => values[name.trim()]?.trim() ?? '').trim();
  return [body, extra.trim()].filter(Boolean).join('\n\n');
}

type SlashEntry =
  | { kind: 'preset'; id: PresetId; command: string; label: string }
  | { kind: 'saved'; command: string; label: string }
  | { kind: 'make'; command: string; label: string }
  | { kind: 'list'; command: string; label: string };

function presetRequest(
  id: PresetId,
  f: EditorFocus | null,
  doc: SeDocumentData,
  refs: BlockRefs,
  extra?: string,
  targetUri?: string,
): PresetRequest {
  const comps = doc.document.components;
  const a = f ? comps.findIndex((c) => c.id === f.anchorId) : -1;
  const b = f ? comps.findIndex((c) => c.id === f.focusId) : -1;
  if (!f || a < 0 || b < 0) throw new Error('에디터에서 가리키는 곳을 찾지 못했습니다. 블록을 다시 고른 뒤 시도해 주세요.');
  const [from, to] = a <= b ? [a, b] : [b, a];
  const ref = (i: number) => refs.refOf(comps[i].id);
  const text = f.selectedText ?? f.paragraph;
  const chosen = targetUri && parseUri(targetUri);
  const target =
    chosen && (chosen.kind === 'block' || chosen.kind === 'image')
      ? targetUri
      : from === to
        ? ref(from)
        : rangeUri(ref(from), ref(to));
  return {
    id,
    target,
    ...(text?.trim() ? { text } : {}),
    ...(extra?.trim() ? { extra: extra.trim() } : {}),
  };
}

/** 커서 앞 글 끝의 @검색어 */
const AT_QUERY = /(?:^|[\s([「『"'“])@([^\s@]*)$/u;

export function Chat({
  convKey,
  post,
  avail,
  onRefresh,
  onBusyChange,
  onRequestFailed,
  onStorageError,
  onRegisterReferLib,
  onRegisterAbort,
  onRunTab,
}: {
  /** 보여줄 대화 (글 식별자) */
  convKey: string;
  /** 지금 에디터에 열린 글. convKey와 같은 글일 때만 넘어오고, 이때만 대화를 이어서 저장한다. */
  post: CurrentPost | null;
  avail: Avail;
  onRefresh: () => void;
  onBusyChange: (convKey: string, busy: boolean) => void;
  /** 요청이 실패하면 서버 상태를 다시 확인하게 한다. */
  onRequestFailed: () => void;
  /** 대화를 불러오거나 저장하지 못하면 작업공간 연결을 다시 확인하게 한다. */
  onStorageError: () => void;
  /** 보관함에서 「참조」할 때 쓸 핸들러를 등록한다. */
  onRegisterReferLib?: (refer: (uri: string, meta: ImageMeta | null, name?: string) => void) => void;
  /** 탭이 닫혔을 때 App이 호출할 중단 함수를 등록한다. */
  onRegisterAbort?: (convKey: string, abort: () => void) => void;
  /** 이번 요청이 쓰는 에디터 탭 (시작·종료). */
  onRunTab?: (convKey: string, tabId: number | null) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [canSend, setCanSend] = useState(false);
  /** 입력창에 붙여넣어 다음 메시지와 함께 보낼 이미지 */
  const [attachments, setAttachments] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('작업 중…');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [conflict, setConflict] = useState(false);
  const [applied, setApplied] = useState<{ count: number; snapshot: SeDocumentData } | null>(null);
  /** 이번 제안 카드에서 켠 「다시 묻지 않기」(적용 시 askSkip에 저장) */
  const [dontAsk, setDontAsk] = useState({ edits: false, images: false });
  const [settings, setSettings] = useState<UserSettings | null>(null);
  /** 에디터 포커스 (자동 현재 위치 칩·피커·프리셋용) */
  const [selected, setSelected] = useState<EditorFocus | null>(null);
  /** 사용자가 현재 위치 칩을 ✕로 뺀 focusKey. 커서가 바뀌면 다시 붙는다. */
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  /** 입력창 위 줄. 커서를 따라가는 현재 선택만 둔다. */
  const [composerRefs, setComposerRefs] = useState<RefItem[]>([]);
  const composerInput = useRef<ComposerInputHandle>(null);
  /** 참조를 넣을 입력칸: 질문이 열려 있으면 마지막으로 입력한 카드 칸, 아니면 아래 입력창 (렌더마다 갱신) */
  const referTarget = useRef<() => ComposerInputHandle | null>(() => composerInput.current);
  /** @query 피커: 입력에서 @ 토큰 위치 */
  const [atPick, setAtPick] = useState<{ query: string } | null>(null);
  /** @ 피커가 열린 입력칸: 'composer'(아래 입력창) 또는 질문 카드 칸의 key */
  const [atOwner, setAtOwner] = useState<string>('composer');
  /** 질문 카드에서 참조를 받을 칸 (마지막으로 입력한 칸) */
  const askInput = useRef<{ key: string; handle: ComposerInputHandle } | null>(null);
  const [asking, setAsking] = useState<AskRequest | null>(null);

  // 질문 카드가 닫히면 카드 칸을 잊고, 카드에 열린 @ 피커를 닫는다.
  useEffect(() => {
    if (asking) return;
    askInput.current = null;
    if (atOwner === 'composer') return;
    setAtOwner('composer');
    setAtPick(null);
    // 카드가 닫힐 때만 본다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asking]);
  /** `/`로 시작한 입력. 메뉴에는 프롬프트 만들기만 있다. */
  const [slash, setSlash] = useState<string | null>(null);
  const [slashPrompts, setSlashPrompts] = useState<SavedPromptFile[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [recentCommands, setRecentCommands] = useState<string[]>([]);
  const [promptList, setPromptList] = useState(false);
  /** 커맨드를 보낸 뒤, 서버로 가기 전에 받는 요청사항·스코프 */
  /** 프롬프트 만들기(make)·저장(save) 카드: 요청사항(저장이면 원문) → 범위 */
  const [createAsk, setCreateAsk] = useState<{
    mode: 'make' | 'save';
    step: 'instruction' | 'scope';
    instruction: string;
    /** save: 정리할 때 따를 요청사항 */
    request?: string;
    scope: PromptScope;
  } | null>(null);
  /** 슬래시 기본 커맨드의 대상이 비었을 때만. 오버레이 퀵은 이 카드를 열지 않는다. */
  /** 저장 프롬프트를 부를 때 글 칸을 묻는 카드 */
  const [savedAsk, setSavedAsk] = useState<{ prompt: SavedPromptFile; values: Record<string, string>; extra: string } | null>(null);
  const [presetAsk, setPresetAsk] = useState<{
    id: PresetId;
    extra: string;
    items: PickerItem[];
    picked: string | null;
  } | null>(null);
  const [atIndex, setAtIndex] = useState(0);
  const history = useRef<ChatTurn[]>([]);
  const turnMeta = useRef<Record<string, TurnMeta>>({});
  /** 에디터 블록 ID ↔ 에이전트용 참조. 대화와 함께 저장해서 같은 블록은 계속 같은 참조를 쓴다. */
  const refs = useRef(new BlockRefs());
  /** 칩 이름을 만들 때 쓰는 가장 최근 문서 */
  const lastDoc = useRef<SeDocumentData | null>(null);
  /** 이번 요청·적용에 쓰는 글쓰기 탭 (다른 탭으로 옮겨도 여기로 read/edit) */
  const editorTabId = useRef<number | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);
  /** 'closed'면 탭 닫힘으로 중단 */
  const abortReason = useRef<'closed' | null>(null);
  /** 에이전트가 물어보고 답을 기다리는 중인 질문 */
  const answerRef = useRef<((answer: AskAnswer) => void) | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  /** 대화 저장 실패를 이미 알렸는지 */
  const saveFailed = useRef(false);
  /** 칩을 눌렀을 때 크게 보는 이미지 */
  const [chipPreview, setChipPreview] = useState<{
    uri: string;
    name?: string;
    image: { url: string; blob: Blob };
  } | null>(null);
  const chipPreviewUrl = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadConversation(convKey).then((conv) => {
      if (cancelled) return;
      if (conv) {
        setMessages(conv.messages);
        // 예전 대화의 턴에는 ID가 없다. 서버가 ID 없는 턴에 붙이는 것과 같은 ID를 붙여 둔다.
        history.current = withUnfinishedNotes(
          conv.history.map((t, i) => (t.id ? t : { ...t, id: `turn-${i}` })),
          conv.messages,
        );
        turnMeta.current = conv.turnMeta ?? {};
        refs.current = BlockRefs.fromJSON(conv.refs);
      }
      setLoaded(true);
    }, (err) => {
      if (cancelled) return;
      // 불러오지 못했으면 덮어쓰지 않도록 loaded를 켜지 않는다. 작업공간 연결이 끊긴 것은 배너가 알린다.
      onStorageError();
      if (err instanceof WorkspaceUnavailableError) return;
      setMessages([{ role: 'error', text: `대화를 불러오지 못했습니다: ${err instanceof Error ? err.message : String(err)}` }]);
    });
    return () => {
      cancelled = true;
      abort.current?.abort();
      if (chipPreviewUrl.current) {
        URL.revokeObjectURL(chipPreviewUrl.current);
        chipPreviewUrl.current = null;
      }
    };
  }, [convKey]);

  useEffect(() => {
    loadSettings().then(setSettings);
    return onSettingsChange(setSettings);
  }, []);

  useEffect(() => {
    if (!post || post.key !== convKey) return;
    readDocument()
      .then((d) => (lastDoc.current ??= d))
      .catch(() => {});
  }, [post, convKey]);

  useEffect(() => {
    if (!loaded || messages.length === 0 || !post) return;
    saveConversation({
      key: post.key,
      title: post.title,
      documentId: post.documentId,
      url: post.url,
      updatedAt: Date.now(),
      messages,
      history: history.current,
      turnMeta: turnMeta.current,
      refs: refs.current.toJSON(),
    }).then(
      () => {
        saveFailed.current = false;
      },
      (err) => {
        console.warn('[blsee] 대화 저장 실패', err);
        onStorageError();
        // 작업공간 연결이 끊긴 것은 배너가 알린다. 그 밖의 실패는 다시 성공할 때까지 한 번만 알린다.
        if (err instanceof WorkspaceUnavailableError || saveFailed.current) return;
        saveFailed.current = true;
        push({ role: 'error', text: saveErrorText(err) });
      },
    );
    // 제목이 바뀌어도 대화가 바뀌기 전까지는 다시 저장하지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, messages]);

  useEffect(() => {
    onBusyChange(convKey, busy);
  }, [busy, convKey, onBusyChange]);

  useEffect(() => {
    onRegisterReferLib?.((uri, meta, name) => {
      referTarget.current()?.insertRef(refFromLib(uri, meta, name));
    });
  }, [onRegisterReferLib]);

  useEffect(() => {
    onRegisterAbort?.(convKey, () => {
      abortReason.current = 'closed';
      const tabId = editorTabId.current;
      if (tabId !== undefined) void clearBadge();
      answerRef.current = null;
      setAsking(null);
      abort.current?.abort();
    });
  }, [convKey, onRegisterAbort]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages, proposal, applied, busy, status]);

  const push = (m: ChatMessage) => setMessages((prev) => [...prev, m]);
  const ready = avail === 'ready' && loaded && post !== null;

  // 패널 밖(에디터)에 있는 동안만 선택을 따라간다. 패널을 누르면 에디터 선택이 풀릴 수 있어서,
  // 패널로 넘어오기 직전 값을 그대로 쓴다.
  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    const poll = () => {
      if (document.hasFocus()) return;
      getEditorFocus()
        .then((s) => !stopped && !document.hasFocus() && setSelected(s))
        .catch(() => !stopped && setSelected(null));
    };
    poll();
    const timer = setInterval(poll, SELECTION_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [ready]);

  // 에디터 포커스 → 「현재 위치」칩 자동 유지 (✕로 뺀 키는 커서가 바뀔 때까지 숨김)
  useEffect(() => {
    const clearCurrent = () => setComposerRefs([]);
    if (!selected || focusKey(selected) === dismissedId) {
      clearCurrent();
      return;
    }
    let cancelled = false;
    const apply = (doc: SeDocumentData) => {
      if (cancelled) return;
      lastDoc.current = doc;
      refs.current.sync(doc);
      const items = currentPickerItems(selected, doc, refs.current);
      if (!items.length) {
        clearCurrent();
        return;
      }
      setComposerRefs(items.map(pickerToRef));
    };
    if (lastDoc.current) apply(lastDoc.current);
    else {
      readDocument().then(apply).catch(() => {
        if (!cancelled) clearCurrent();
      });
    }
    return () => {
      cancelled = true;
    };
  }, [selected, dismissedId]);

  const [pickerDoc, setPickerDoc] = useState<SeDocumentData | null>(null);

  useEffect(() => {
    if (!atPick) {
      setPickerDoc(null);
      return;
    }
    let cancelled = false;
    readDocument()
      .then((d) => {
        if (cancelled) return;
        lastDoc.current = d;
        refs.current.sync(d);
        setPickerDoc(d);
      })
      .catch(() => {
        if (!cancelled && lastDoc.current) setPickerDoc(lastDoc.current);
      });
    return () => {
      cancelled = true;
    };
  }, [atPick]);

  const atItems = useMemo(() => {
    if (!atPick || !pickerDoc) return [];
    refs.current.sync(pickerDoc);
    const items: PickerItem[] = [];
    if (selected) {
      const cur = currentPickerItem(selected, pickerDoc, refs.current);
      if (cur) items.push(cur);
    }
    for (const it of docPickerItems(pickerDoc, refs.current)) {
      // 「현재 위치」와 같은 블록은 목록에서 한 번만 보여 준다. 고르면 위 줄과 따로 인라인 칩이 된다.
      if (items[0]?.current && items[0].doc === it.doc) continue;
      items.push(it);
    }
    const q = atPick.query.toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) => it.snippet.toLowerCase().includes(q) || it.kind.toLowerCase().includes(q) || it.label.toLowerCase().includes(q),
    );
  }, [atPick, selected, pickerDoc]);

  useEffect(() => {
    setAtIndex(0);
  }, [atPick?.query, atItems.length]);

  const syncComposer = () => {
    const draft = composerInput.current?.read();
    setCanSend(!!draft?.text.trim());
    const before = composerInput.current?.textBeforeCaret() ?? '';
    const m = AT_QUERY.exec(before);
    setAtOwner('composer');
    setAtPick(m ? { query: m[1] } : null);
    const slashMatch = !m && /^\/(\S*)$/.exec((draft?.text ?? '').trim());
    setSlash(slashMatch ? slashMatch[1] : null);
  };

  const slashOpen = slash !== null;
  useEffect(() => {
    if (!slashOpen) return;
    let stop = false;
    void activeWorkspace().then(async (root) => {
      if (stop) return;
      setSlashPrompts(root ? await listPrompts(root, convKey) : []);
    });
    return () => {
      stop = true;
    };
  }, [slashOpen, convKey]);

  useEffect(() => {
    void loadRecentCommands().then(setRecentCommands);
  }, []);

  const slashItems = useMemo(() => {
    if (slash === null) return [] as SlashEntry[];
    const catalog = new Map<string, SlashEntry>();
    for (const prompt of slashPrompts) {
      catalog.set(prompt.command, { kind: 'saved', command: prompt.command, label: prompt.name });
    }
    for (const id of Object.keys(PRESETS) as PresetId[]) {
      catalog.set(PRESETS[id].command, { kind: 'preset', id, command: PRESETS[id].command, label: PRESETS[id].label });
    }
    catalog.set(PROMPT_MAKE_COMMAND, { kind: 'make', command: PROMPT_MAKE_COMMAND, label: PROMPT_MAKE_LABEL });
    catalog.set(PROMPT_SAVE_COMMAND, { kind: 'make', command: PROMPT_SAVE_COMMAND, label: PROMPT_SAVE_LABEL });
    const items: SlashEntry[] = [];
    const seen = new Set<string>();
    const push = (entry: SlashEntry | undefined) => {
      if (!entry || seen.has(entry.command) || !commandQueryMatch(slash, entry.command, entry.label)) return;
      seen.add(entry.command);
      items.push(entry);
    };
    for (const command of recentCommands) push(catalog.get(command));
    for (const prompt of slashPrompts) if (prompt.scope === 'post') push(catalog.get(prompt.command));
    for (const prompt of slashPrompts) if (prompt.scope === 'all') push(catalog.get(prompt.command));
    for (const id of slashPresetIds(selected)) push(catalog.get(PRESETS[id].command));
    push(catalog.get(PROMPT_MAKE_COMMAND));
    push(catalog.get(PROMPT_SAVE_COMMAND));
    if (!slash || '목록'.startsWith(slash) || 'list'.startsWith(slash) || '프롬프트'.startsWith(slash)) items.push({ kind: 'list', command: 'list', label: '프롬프트 목록 (추가·수정·삭제)' });
    return items;
  }, [slash, selected, slashPrompts, recentCommands]);

  useEffect(() => {
    setSlashIndex(0);
  }, [slash, slashItems.length]);

  const pickSlash = (item: SlashEntry) => {
    if (item.kind === 'list') {
      setSlash(null);
      setPromptList(true);
      return;
    }
    composerInput.current?.setText(`/${item.command}`);
  };

  const pickAtItem = (item: PickerItem) => {
    if (!atPick) return;
    setAtPick(null);
    const target = atOwner === 'composer' ? composerInput.current : askInput.current?.key === atOwner ? askInput.current.handle : null;
    target?.insertRef(asInlineRef(pickerToRef(item)), { replaceAt: true });
  };

  /** @ 피커가 열려 있으면 화살표·Enter·Esc를 받는다. 받았으면 true */
  const pickerKey = (e: KeyboardEvent<HTMLDivElement>): boolean => {
    if (!atPick || !atItems.length) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setAtIndex((i) => (i + 1) % atItems.length);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setAtIndex((i) => (i - 1 + atItems.length) % atItems.length);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setAtPick(null);
      return true;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      pickAtItem(atItems[atIndex] ?? atItems[0]);
      return true;
    }
    return false;
  };


  /** 에디터 블씨 버튼. 칸을 묻지 않고, 선택 영역을 대상으로, 지시는 빈 기본값으로 바로 실행한다. */
  const runPanelAction = async ({ preset }: PanelAction) => {
    if (busy || asking) {
      push({ role: 'info', text: `지금 하던 일이 끝난 뒤 다시 골라 주세요 (${PRESETS[preset].label}).` });
      return;
    }
    const focus = (await getEditorFocus().catch(() => null)) ?? selected;
    setSelected(focus);
    setDismissedId(null);
    void send({ id: preset, target: focus, immediate: true });
  };
  const panelActionRef = useRef(runPanelAction);
  panelActionRef.current = runPanelAction;

  // 패널이 막 열린 참이면 아직 글·서버 연결 전일 수 있어서, 먼저 받아 두고 준비되면 실행한다.
  const [queued, setQueued] = useState<PanelAction | null>(null);
  useEffect(() => {
    const take = () => {
      takePanelAction().then(
        (a) => {
          console.info('[블씨] 빠른 실행 받음:', a);
          if (a) setQueued(a);
        },
        (err) => console.warn('[블씨] 빠른 실행을 받지 못했습니다:', err),
      );
    };
    take();
    return onPanelAction(take);
  }, []);
  useEffect(() => {
    if (!queued || !ready) return;
    setQueued(null);
    console.info('[블씨] 빠른 실행 시작:', queued.preset);
    void panelActionRef.current(queued);
  }, [queued, ready]);

  const closeChipPreview = () => {
    setChipPreview(null);
    if (chipPreviewUrl.current) {
      URL.revokeObjectURL(chipPreviewUrl.current);
      chipPreviewUrl.current = null;
    }
  };

  const refLabel = (ref: string): string | undefined => {
    const parsed = parseImageUri(ref);
    if (parsed?.kind === 'gen') {
      const kept = messages.filter((m) => m.role === 'image');
      const m = kept.find((x) => x.uri === ref);
      if (m?.original) return '원본 이미지';
      const made = kept.filter((x) => !x.original).map((x) => x.uri);
      const n = made.indexOf(ref) + 1;
      return n ? `만든 이미지 ${n}` : undefined;
    }
    const doc = lastDoc.current;
    const block = blockOfRef(ref);
    const id = block && refs.current.idOf(block);
    const c = id && doc?.document.components.find((x) => x.id === id);
    if (!doc || !c) return undefined;
    const label = blockChipLabel(doc, c, imageIndexOf(ref));
    return isRange(ref) ? `${label} 외` : label;
  };

  const refActions: RefActions = {
    open: (ref) => {
      const block = blockOfRef(ref);
      const id = block && refs.current.idOf(block);
      const imageUri = (() => {
        if (parseImageUri(ref)) return ref;
        if (!id || !lastDoc.current || isRange(ref)) return null;
        const c = lastDoc.current.document.components.find((x) => x.id === id);
        if (!c || !blockImages(c).length) return null;
        const idx = imageIndexOf(ref);
        return blockImageUri(block!, idx > 1 ? idx : undefined);
      })();
      if (id) {
        revealBlock(id).catch((e) => push({ role: 'error', text: e instanceof Error ? e.message : String(e) }));
      } else if (!imageUri) {
        return push({
          role: 'error',
          text: KNOWN_DOC_URI.test(ref) ? '이 대화에서 모르는 블록입니다.' : '알 수 없는 대상입니다.',
        });
      }
      if (!imageUri) return;
      const name = refLabel(imageUri) ?? refLabel(ref);
      const load =
        parseImageUri(imageUri)?.kind === 'gen'
          ? getImage(convKey, imageUri).then((b) => b ?? Promise.reject(new Error('없음')))
          : lastDoc.current
            ? resolveImageUri(imageUri, { doc: lastDoc.current, refs: refs.current, convKey })
            : Promise.reject(new Error('문서 없음'));
      void load.then(
        (blob) => {
          if (chipPreviewUrl.current) URL.revokeObjectURL(chipPreviewUrl.current);
          const url = URL.createObjectURL(blob);
          chipPreviewUrl.current = url;
          setChipPreview({ uri: imageUri, name, image: { url, blob } });
        },
        () => {},
      );
    },
    label: refLabel,
    thumb: (ref) => {
      const parsed = parseImageUri(ref);
      if (parsed?.kind === 'gen') return genThumb(convKey, ref);
      if (isRange(ref)) return Promise.resolve(null);
      const block = blockOfRef(ref);
      const id = block && refs.current.idOf(block);
      const c = id && lastDoc.current?.document.components.find((x) => x.id === id);
      const img = c ? blockImages(c)[imageIndexOf(ref) - 1] : undefined;
      if (!img) return Promise.resolve(null);
      if (typeof img[PENDING_IMAGE_KEY] === 'string') return genThumb(convKey, img[PENDING_IMAGE_KEY] as string);
      return typeof img.src === 'string' ? pstaticThumb(img.src) : Promise.resolve(null);
    },
  };

  const openComposerRef = (r: RefItem) => {
    if (r.doc) {
      const block = blockOfRef(r.doc);
      const id = block && refs.current.idOf(block);
      if (id) {
        revealBlock(id).catch((e) => push({ role: 'error', text: e instanceof Error ? e.message : String(e) }));
      }
      if (parseUri(r.doc)?.kind === 'image' || r.lib) refActions.open(r.lib ?? r.doc);
      return;
    }
    if (r.lib) refActions.open(r.lib);
  };

  const previewPickerImage = (item: PickerItem) => {
    if (!item.image) return;
    refActions.open(item.lib ?? item.doc);
  };

  /**
   * 제안을 에디터에 넣는다. 새 이미지는 먼저 붙여넣기로 네이버에 올리고, 올라간 이미지로 자리를 채운 뒤 문서 전체를 쓴다.
   * 성공하면 true. 요청 이후 에디터가 바뀌었으면 force 없이는 멈추고 충돌을 표시한다.
   */
  const applyProposal = async (p: Proposal, force = false): Promise<boolean> => {
    const prevPin = pinnedEditorTab();
    const tabId = editorTabId.current;
    if (tabId !== undefined) pinEditorTab(tabId);
    try {
      const current = await readDocument();
      if (!force && !sameComponents(current, p.base)) {
        setProposal(p);
        setConflict(true);
        return false;
      }
      let doc = p.working;
      const pending = pendingImages(doc);
      const formulas = pendingFormulas(doc);
      try {
        // 커서 자리에 붙여넣어 올리고, 다 올린 뒤 문서를 다시 써서 제자리에 둔다.
        for (const slot of pending) {
          setStatus('문서에 이미지 넣는 중...');
          const blob = await getImage(convKey, slot.uri);
          if (!blob) throw new Error(`${slot.uri} 이미지를 이 PC에서 찾지 못했습니다.`);
          const uploaded = await uploadImage(blob);
          if (typeof uploaded.src === 'string') await linkImageSource(convKey, slot.uri, uploaded.src);
          doc = fillPendingImage(doc, slot.id, uploaded);
        }
        for (const f of formulas) {
          setStatus('수식 그리는 중...');
          doc = fillPendingFormula(doc, f.id, await uploadFormula(f.latex));
        }
        await writeDocument(doc);
        lastDoc.current = doc;
      } catch (e) {
        // 올리다 실패하면 커서 자리에 들어간 이미지를 치우고 원래대로 돌린다.
        if (pending.length || formulas.length) await writeDocument(current).catch(() => {});
        throw e;
      }
      setApplied({ count: p.changes.length, snapshot: current });
      setProposal(null);
      setConflict(false);
      const what = [p.hasEdits && '글 편집', p.imageCount && `이미지 ${p.imageCount}장`].filter(Boolean).join(', ');
      push({ role: 'info', text: `변경 ${p.changes.length}건(${what})을 에디터에 적용했습니다.` });
      return true;
    } finally {
      pinEditorTab(prevPin);
    }
  };

  /** 에이전트의 질문에 답한다. cancel은 중지와 같고, decline·accept만 이어서 진행한다. */
  const answerAsk = (answer: AskAnswer) => {
    const tabId = editorTabId.current;
    void clearBadge();
    if (answer.action === 'cancel') {
      abortReason.current = null;
      answerRef.current = null;
      setAsking(null);
      abort.current?.abort();
      return;
    }
    const reply = answerRef.current;
    if (!reply) return;
    const req = asking;
    answerRef.current = null;
    setAsking(null);
    setStatus('작업 중…');
    if (req && (answer.action === 'accept' || answer.action === 'decline')) {
      const text = askReplyText(answer);
      push({
        role: 'ask',
        question: req.question,
        action: answer.action,
        ...(text ? { text } : {}),
      });
    }
    reply(answer);
  };

  /** 입력창에 붙여넣은 이미지를 보관하고(작업공간이 있으면 라이브러리에) 보낼 메시지에 첨부한다. */
  const onPasteImages = async (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    const taken = new Set([...conversationImages(messages), ...attachments].flatMap((uri) => genIdOf(uri) ?? []));
    for (const file of files) {
      const id = newGenImageId(taken);
      taken.add(id);
      const uri = genImageUri(id);
      try {
        // 클립보드 이미지는 보통 "image.png"라 이름으로 쓰지 않는다.
        const fileName = file.name.replace(/\.[a-z0-9]+$/i, '');
        const name = fileName && !/^image$/i.test(fileName) ? fileName : undefined;
        await putImage(convKey, uri, file, { kind: 'attached', ai: false, ...(name ? { name } : {}) });
        setAttachments((prev) => [...prev, uri]);
      } catch (err) {
        push({ role: 'error', text: `이미지를 붙여넣지 못했습니다: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  };

  /** quick을 주면 입력창 대신 그 빠른 실행을 보낸다 (대화에는 일반 요청처럼 남는다). */
  const send = async (
    quick?: {
      id: PresetId;
      target: EditorFocus | null;
      extra?: string;
      immediate?: boolean;
      /** 목록에서 고른 행. 있으면 그 URI를 대상으로 쓴다. */
      picked?: PickerItem;
    },
    promptCreate?: PromptCreate,
    expanded?: string,
    /** 칸 카드에서 채운 저장 프롬프트 */
    savedFill?: { command: string; text: string },
  ) => {
    const draft = composerInput.current?.read() ?? { text: '', refs: [] };
    const raw = expanded ?? draft.text.trim();
    const promptMode = !quick && !promptCreate && !expanded ? promptCommandMode(raw) : null;
    if (promptMode) {
      if (asking || busy || !ready) return;
      const command = promptMode === 'save' ? PROMPT_SAVE_COMMAND : PROMPT_MAKE_COMMAND;
      composerInput.current?.clear();
      setAtPick(null);
      setSlash(null);
      setCreateAsk({
        mode: promptMode,
        step: 'instruction',
        instruction: raw.slice(command.length + 1).trim(),
        scope: 'post',
      });
      return;
    }
    if (createAsk && !promptCreate) {
      push({ role: 'info', text: '프롬프트 만들기의 칸을 먼저 채워 주세요.' });
      return;
    }
    if (presetAsk && !quick?.immediate) {
      push({ role: 'info', text: '대상 칸을 먼저 골라 주세요.' });
      return;
    }
    if (savedAsk && !savedFill) {
      push({ role: 'info', text: '프롬프트의 칸을 먼저 채워 주세요.' });
      return;
    }
    const slashParts = !quick && !promptCreate && !expanded && !savedFill ? splitSlash(raw) : null;
    const presetFromSlash = slashParts ? presetFromCommand(slashParts.command) : null;
    let slashTarget: EditorFocus | null = null;
    if (presetFromSlash && slashParts) {
      const focus = selected ?? (await getEditorFocus().catch(() => null));
      if (focusFitsPreset(presetFromSlash, focus)) slashTarget = focus;
      else {
        const doc = lastDoc.current ?? (await readDocument().catch(() => null));
        const items = doc ? presetAskItems(presetFromSlash, doc, refs.current) : [];
        if (doc) lastDoc.current = doc;
        composerInput.current?.clear();
        setAtPick(null);
        setSlash(null);
        setPresetAsk({ id: presetFromSlash, extra: slashParts.extra, items, picked: items[0]?.doc ?? null });
        return;
      }
    }
    let savedText: string | undefined = savedFill?.text;
    let savedCommand = savedFill?.command ?? '';
    if (slashParts && !presetFromSlash && !RESERVED_PROMPT_COMMANDS.includes(slashParts.command.toLowerCase())) {
      const root = await activeWorkspace().catch(() => null);
      const prompt = root ? await findPrompt(root, convKey, slashParts.command) : null;
      if (prompt && prompt.params.length) {
        // 칸이 있으면 카드로 묻는다. 명령 뒤에 적은 글은 첫 칸에 미리 넣는다.
        if (asking || busy || !ready) return;
        setSlash(null);
        setSavedAsk({ prompt, values: { [prompt.params[0].name]: slashParts.extra }, extra: '' });
        return;
      }
      if (prompt) {
        savedCommand = prompt.command;
        savedText = fillSavedPrompt(prompt, {}, slashParts.extra);
        if (!savedText) {
          push({ role: 'info', text: '프롬프트 본문이 비어 있습니다.' });
          return;
        }
      }
    }
    const runPreset: { id: PresetId; target: EditorFocus | null; extra?: string; targetUri?: string; picked?: PickerItem } | undefined = quick
      ? { id: quick.id, target: quick.target, extra: quick.extra, targetUri: quick.picked?.doc, picked: quick.picked }
      : presetFromSlash
        ? { id: presetFromSlash, target: slashTarget, extra: slashParts?.extra }
        : undefined;
    const inlineRefs = quick ? [] : draft.refs;
    const currentRefs = quick ? [] : composerRefs.filter((r) => r.current);
    const text = promptCreate
      ? `/${promptCreate.mode === 'save' ? PROMPT_SAVE_COMMAND : PROMPT_MAKE_COMMAND}`
      : runPreset
        ? [PRESETS[runPreset.id].message, runPreset.extra].filter(Boolean).join('\n')
        : (savedText ?? raw);
    if (runPreset && (asking || busy || !ready)) {
      push({ role: 'info', text: `지금은 빠른 실행(${PRESETS[runPreset.id].label})을 할 수 없어요. 하던 일이 끝난 뒤 다시 골라 주세요.` });
      return;
    }
    if (asking) {
      if (!text || runPreset) return;
      const content = askContentFromText(asking.requestedSchema, text);
      if (!content || validateAskContent(asking.requestedSchema, content)) return;
      composerInput.current?.clear();
      answerAsk({ action: 'accept', content });
      return;
    }
    if (!text || busy || !ready) return;
    const used = runPreset
      ? PRESETS[runPreset.id].command
      : savedCommand
        ? savedCommand
        : promptCreate
          ? promptCreate.mode === 'save'
            ? PROMPT_SAVE_COMMAND
            : PROMPT_MAKE_COMMAND
          : '';
    if (used) void rememberCommand(used).then(setRecentCommands);
    const sentAttachments = quick ? [] : attachments;
    if (!quick) {
      composerInput.current?.clear();
      setAttachments([]);
      setAtPick(null);
      setSlash(null);
      setCreateAsk(null);
      setPresetAsk(null);
    }
    const target = runPreset ? runPreset.target : null;
    // 유저 메시지는 hydrate 전에 올리고, 칩은 보낸 목록으로 표시 (hydrate 후 lib가 채워지면 turnMeta에 반영)
    push({
      role: 'user',
      text,
      ...(inlineRefs.length ? { refs: inlineRefs } : {}),
      ...(runPreset && target ? { selection: target.label, selectionImage: target.imageSrc } : {}),
      ...(runPreset ? { preset: runPreset.id } : {}),
      ...(sentAttachments.length ? { attachments: sentAttachments } : {}),
    });
    const turnId = newTurnId();
    const time = turnTime();
    /** 이번 요청 앞까지의 대화 기록 (서버에는 이것을 보낸다) */
    const priorHistory = history.current;
    // 요청을 시작하자마자 "멈춘 요청" 표시를 기록에 둔다. 확장이 다시 시작되거나 패널이 닫혀
    // 끝맺지 못해도, 다음 요청이 이 요청을 알고 이어서 할 수 있다. 끝나면 답이나 멈춘 기록으로 바꾼다.
    history.current = [...priorHistory, { id: turnId, role: 'user', text }, { id: newTurnId(), role: 'assistant', text: UNFINISHED_NOTE }];
    turnMeta.current = { ...turnMeta.current, [turnId]: { time } };
    setBusy(true);
    setStatus('작업 중…');
    setConflict(false);
    setApplied(null);
    abort.current = new AbortController();
    const runSignal = abort.current.signal;
    const tabId = await activeTabId();
    editorTabId.current = tabId;
    pinEditorTab(tabId);
    onRunTab?.(convKey, tabId ?? null);
    abortReason.current = null;

    let base: SeDocumentData | null = null;
    let session: DocSession | null = null;
    let spent = 0;
    let spentByPurpose: Partial<Record<UsagePurpose, number>> = {};
    /** 에이전트의 마지막 답. 바로 적용하는 경우 적용(수식·이미지 올리기)이 끝난 뒤에 보여 준다. */
    let finalReply: string | null = null;
    const showReply = () => {
      if (finalReply !== null) push({ role: 'assistant', text: finalReply });
      if (spent > 0) push({ role: 'step', ok: true, text: `장작 ${formatWood(spent)}개 사용` });
      finalReply = null;
      spent = 0;
    };
    /** 이번 요청 중에 오간 질문과 답 (대화 기록에 넣는다) */
    const asked: ChatTurn[] = [];
    const askedMeta: Record<string, TurnMeta> = {};
    /** 이번 요청의 진행 기록. 중간에 멈춰도 다음 요청("이어서 해 줘")이 이어 갈 수 있게 대화 기록에 남긴다. */
    const runPlans: { round: number; tasks: PlanTaskItem[] }[] = [];
    const runImages: string[] = [];
    let pendingAsk: string | null = null;
    let thisTurn: TurnMeta = { time };
    /** 이번 요청을 대화 기록에 넣는다 (끝났으면 답, 멈췄으면 멈춘 기록). */
    const remember = (reply: string) => {
      history.current = [...priorHistory, { id: turnId, role: 'user', text }, ...asked, { id: newTurnId(), role: 'assistant', text: reply }];
      turnMeta.current = { ...turnMeta.current, [turnId]: thisTurn, ...askedMeta };
    };
    // 만든 이미지는 채팅의 미리보기 메시지가 기준이다 (대화와 함께 저장된다).
    const made = messages.filter((m): m is Extract<ChatMessage, { role: 'image' }> => m.role === 'image');
    const attachedImages = [
      ...messages.flatMap((m) => (m.role === 'user' ? (m.attachments ?? []) : [])),
      ...sentAttachments,
    ];
    const genIds = new Set([...made.map((m) => m.uri), ...attachedImages].flatMap((uri) => genIdOf(uri) ?? []));
    const genCaptions = new Map(made.flatMap((m) => {
      const id = genIdOf(m.uri);
      return id && m.caption ? [[id, m.caption] as const] : [];
    }));
    const genAi = new Set(
      made.flatMap((m) => ((m.ai ?? (m.text.startsWith('만든 이미지') && !m.caption)) ? (genIdOf(m.uri) ?? []) : [])),
    );
    const originals = new Map(made.flatMap((m) => (m.original ? [[m.original, m.uri] as const] : [])));
    try {
      // 아직 적용하지 않은 제안이 있으면 그 위에서 이어서 고친다.
      base = proposal?.base ?? (await readDocument());
      session = new DocSession(proposal?.working ?? base, refs.current, {
        convKey,
        genIds,
        genCaptions,
        genAi,
        originals,
        onImageCreated: (uri, { instruction, caption, ai, name, original }) => {
          if (!original) runImages.push(`${uri} (${name || instruction})`);
          push(
            original
              ? { role: 'image', uri, text: `원본 보관 · ${instruction}`, ai: false, original }
              : { role: 'image', uri, text: `만든 이미지 · ${instruction}`, ai, ...(caption ? { caption } : {}), ...(name ? { name } : {}) },
          );
        },
      });
      const s = session;
      lastDoc.current = s.working;

      let pointed: TurnPoint[] = [];
      let turnRefs: RefItem[] | undefined;

      const stampSrc = async (items: RefItem[]): Promise<RefItem[]> =>
        Promise.all(
          items.map(async (r) => {
            if (!r.lib || r.src) return r;
            const html = (await getImageInfo(convKey, r.lib))?.htmlUri;
            return html ? { ...r, src: html } : r;
          }),
        );
      const toPoints = (items: RefItem[]): TurnPoint[] =>
        items.flatMap((r) => {
          const src = r.src ?? r.lib;
          if (!r.doc && !src) return [];
          return [{ ...(r.doc ? { doc: r.doc } : {}), ...(src ? { src } : {}) }];
        });

      if (runPreset && target) {
        const picked = (runPreset.picked ? [runPreset.picked] : currentPickerItems(target, s.working, refs.current)).map(pickerToRef);
        pointed = toPoints(await stampSrc(await hydrateRefs(picked, s, refs.current, target.imageSrc)));
      } else if (inlineRefs.length || currentRefs.length) {
        const hydratedInline = inlineRefs.length
          ? await stampSrc(await hydrateRefs(inlineRefs, s, refs.current, selected?.imageSrc))
          : [];
        const hydratedCurrent = currentRefs.length
          ? await stampSrc(await hydrateRefs(currentRefs, s, refs.current, selected?.imageSrc))
          : [];
        turnRefs = hydratedInline.length ? hydratedInline : undefined;
        pointed = toPoints(hydratedCurrent);
        // 문장의 URI는 보낸 그대로 둔다. 칩의 lib만 채운다.
        if (hydratedInline.length) {
          setMessages((prev) => {
            const at = prev.findLastIndex((m) => m.role === 'user' && m.text === text);
            if (at < 0) return prev;
            const m = prev[at];
            if (m.role !== 'user') return prev;
            return prev.with(at, { ...m, refs: hydratedInline });
          });
        }
      }

      const knownImageUris = new Set([...made.map((m) => m.uri), ...attachedImages]);
      const imageLine = (uri: string, label: string, caption?: string) => {
        const cap = caption ? ` (넣으면 캡션 자동: ${caption})` : '';
        return `${uri}: ${label}${cap}`;
      };
      const extraSrcs = [
        ...new Set(
          [
            ...pointed.flatMap((p) => (p.src ? [p.src] : [])),
            ...(turnRefs ?? []).flatMap((r) => {
              const src = r.src ?? r.lib;
              return src ? [src] : [];
            }),
          ].filter((u) => !knownImageUris.has(u)),
        ),
      ];
      const images = [
        ...made.map((m) => imageLine(m.uri, m.text.replace(/^만든 이미지 · /, '').replace(/^원본 보관 · /, '원본 보관 · '), m.caption)),
        ...attachedImages.map((uri) => imageLine(uri, '사용자가 첨부한 이미지')),
        // 가리킨·참조 파일이 대화 미리보기에 없어도 계획·검사가 알 수 있게 넣는다. 인포그래픽은 그 파일 URI만.
        ...(await Promise.all(
          extraSrcs.map(async (uri) => {
            if (isHtmlUri(uri)) return imageLine(uri, '참조');
            const info = await getImageInfo(convKey, uri);
            return imageLine(uri, '참조', info?.caption);
          }),
        )),
      ];
      const preset = runPreset && presetRequest(runPreset.id, target, s.working, refs.current, runPreset.extra, runPreset.targetUri);
      const library = (await workspaceState().catch(() => null))?.kind === 'ready';
      thisTurn = {
        time,
        ...(pointed.length ? { pointed } : {}),
        ...(turnRefs?.length ? { refs: turnRefs } : {}),
        ...(sentAttachments.length ? { attached: sentAttachments } : {}),
      };
      // 아직 만료되지 않은 점검 결과 (편집이 반영되면 만료된다)
      const activeReviews = messages.flatMap((m) => (m.role === 'review' && !m.expired ? [m.review] : []));
      const { reply } = await runAgent({
        start: {
          type: 'start',
          history: priorHistory,
          turnMeta: turnMeta.current,
          turnId,
          message: text,
          time,
          ...(sentAttachments.length ? { attached: sentAttachments } : {}),
          outline: s.outline(),
          ...(pointed.length ? { pointed } : {}),
          ...(turnRefs?.length ? { refs: turnRefs } : {}),
          images,
          ...(library ? { library } : {}),
          ...(preset ? { preset } : {}),
          ...(promptCreate ? { promptCreate } : {}),
          ...(activeReviews.length ? { reviews: activeReviews } : {}),
          locale: navigator.language,
        },
        onToolCall: async (name, args) => {
          const result = await s.run(name, args);
          if (result.summary) push({ role: 'step', ok: result.ok, text: result.summary });
          return result.content;
        },
        onStep: (ok, stepText) => push({ role: 'step', ok, text: stepText }),
        onPlan: (round, reason, tasks) => {
          runPlans.push({ round, tasks: tasks.map((t) => ({ ...t, state: 'pending' })) });
          push({ role: 'plan', round, reason, tasks: tasks.map((t) => ({ ...t, state: 'pending' })) });
        },
        onTask: (round, id, state, taskText) => {
          const plan = runPlans.findLast((p) => p.round === round);
          if (plan) plan.tasks = plan.tasks.map((t) => (t.id === id ? { ...t, state, text: taskText } : t));
          setMessages((prev) => {
            const at = prev.findLastIndex((m) => m.role === 'plan' && m.round === round);
            const card = prev[at];
            if (card?.role !== 'plan') return prev;
            const tasks = card.tasks.map((t) => (t.id === id ? { ...t, state, text: taskText } : t));
            return prev.with(at, { ...card, tasks });
          });
        },
        onReview: (review) => push({ role: 'review', review }),
        onReviewClear: () =>
          setMessages((prev) => prev.map((m) => (m.role === 'review' && !m.expired ? { ...m, expired: true } : m))),
        onAsk: async (req) => {
          if (req.dontAskKey) {
            const s = settings ?? (await loadSettings());
            if (isAskSkipped(s, req.dontAskKey)) {
              return { action: 'accept' as const, content: {} };
            }
          }
          if (tabId !== undefined) await notifyIfInactive(tabId, 'ask');
          return new Promise<AskAnswer>((resolve) => {
            pendingAsk = req.question;
            setAsking(req);
            setStatus('답을 기다리는 중…');
            answerRef.current = (answer) => {
              // cancel은 answerAsk에서 abort만 하고 여기로 안 온다.
              const answerId = newTurnId();
              asked.push(
                { id: newTurnId(), role: 'assistant', text: req.question },
                { id: answerId, role: 'user', text: askAnswerText(answer) || '(빈 답)' },
              );
              askedMeta[answerId] = { time: turnTime() };
              pendingAsk = null;
              resolve(answer);
            };
          });
        },
        onCost: (wood, byPurpose) => {
          spent = wood;
          spentByPurpose = byPurpose;
        },
        signal: runSignal,
      });
      remember(reply);
      finalReply = reply || '(답변 없음)';
    } catch (e) {
      // 멈춘 요청도 대화 기록에 남긴다. 그래야 "이어서 해 줘"가 무엇을 하다 멈췄는지 안다.
      const why =
        e instanceof ServerError && e.code === 'wood'
          ? '장작을 다 써서 멈췄다'
          : runSignal.aborted
            ? abortReason.current === 'closed'
              ? '글 탭이 닫혀 멈췄다'
              : '사용자가 중지했다'
            : `오류로 멈췄다 (${e instanceof Error ? e.message : String(e)})`;
      remember(stoppedNote(why, runPlans, runImages, pendingAsk));
      if (e instanceof ServerError && e.code === 'wood') {
        push({ role: 'info', text: '장작을 다 써서 멈췄습니다. 그때까지 고친 내용은 아래에 남겨 둘게요.' });
        onRequestFailed();
      } else if (runSignal.aborted) {
        push({
          role: 'info',
          text: abortReason.current === 'closed' ? '글 탭이 닫혀 작업을 멈췄습니다.' : '중지했습니다.',
        });
      } else {
        push({ role: 'error', text: e instanceof Error ? e.message : String(e) });
        onRequestFailed();
      }
    } finally {
      abort.current = null;
      answerRef.current = null;
      setAsking(null);
      await recordRequest(spentByPurpose).catch(() => {});
    }

    // 중간에 멈추거나 실패해도 그때까지 고친 내용은 제안으로 남긴다.
    try {
      if (session) lastDoc.current = session.working;
      const p = base && session ? makeProposal(base, session.working) : null;
      const s = await loadSettings();
      setSettings(s);
      setDontAsk({ edits: false, images: false });
      if (p && !needsProposalConfirm(p, s) && !runSignal.aborted) {
        setProposal(null);
        setStatus('에디터에 적용 중…');
        await applyProposal(p);
        showReply();
      } else {
        showReply();
        setProposal(p);
      }
    } catch (e) {
      showReply();
      push({ role: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      pinEditorTab(undefined);
      onRunTab?.(convKey, null);
      abortReason.current = null;
      // 중지·탭 닫힘에는 알리지 않는다. 비활성일 때만 배지.
      if (tabId !== undefined && !runSignal.aborted) await notifyIfInactive(tabId, 'done');
    }
  };

  const apply = async (force = false) => {
    if (!proposal) return;
    setBusy(true);
    setStatus('적용 중…');
    try {
      if (dontAsk.edits || dontAsk.images) {
        setSettings(
          await setAskSkipped({
            ...(dontAsk.edits ? { [ASK_SKIP.proposalEdits]: true } : {}),
            ...(dontAsk.images ? { [ASK_SKIP.proposalImages]: true } : {}),
          }),
        );
      }
      await applyProposal(proposal, force);
    } catch (e) {
      push({ role: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const discard = () => {
    setProposal(null);
    setConflict(false);
    push({ role: 'info', text: '제안을 취소했습니다.' });
  };

  const undo = async () => {
    if (!applied) return;
    setBusy(true);
    setStatus('되돌리는 중…');
    const prevPin = pinnedEditorTab();
    if (editorTabId.current !== undefined) pinEditorTab(editorTabId.current);
    try {
      await writeDocument(applied.snapshot);
      setApplied(null);
      push({ role: 'info', text: '마지막 적용을 되돌렸습니다.' });
    } catch (e) {
      push({ role: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      pinEditorTab(prevPin);
      setBusy(false);
    }
  };

  const askEdits = !!proposal?.hasEdits && !(settings && isAskSkipped(settings, ASK_SKIP.proposalEdits));
  const askImages = !!proposal && proposal.imageCount > 0 && !(settings && isAskSkipped(settings, ASK_SKIP.proposalImages));


  /** @ 피커 목록. below면 입력칸 아래로 연다 (질문 카드). */
  const atPickerList = (below: boolean) => (
    <div className={`at-picker${below ? ' below' : ''}`} role="listbox">
      <div className="at-picker-head">글에서 참조 · @</div>
      {atItems.map((it, i) => (
        <div
          key={`${it.doc}-${it.current ? 'cur' : i}`}
          className={`at-picker-item${i === atIndex ? ' active' : ''}${it.current ? ' current' : ''}`}
          role="option"
          aria-selected={i === atIndex}
          onMouseDown={(e) => {
            e.preventDefault();
            pickAtItem(it);
          }}
          onMouseEnter={() => setAtIndex(i)}
        >
          {it.image && <AtPickerThumb uri={it.lib ?? it.doc} thumb={refActions.thumb} onPreview={() => previewPickerImage(it)} />}
          <div className="at-picker-text">
            {it.current && <div className="at-picker-prefix">현재 위치</div>}
            <div className="at-picker-label">
              <span className="at-picker-kind">{it.kind}: </span>
              {it.snippet}
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  referTarget.current = () => (asking && askInput.current ? askInput.current.handle : composerInput.current);

  /** 질문 카드 칸과 @ 피커를 잇는다. */
  const askRefInput: AskRefInput = {
    register: (key, handle) => {
      if (handle) askInput.current = { key, handle };
      else if (askInput.current?.key === key) askInput.current = null;
    },
    onInput: (key, handle) => {
      askInput.current = { key, handle };
      const m = AT_QUERY.exec(handle.textBeforeCaret());
      setAtOwner(key);
      setAtPick(m ? { query: m[1] } : null);
    },
    onKey: pickerKey,
    picker: atOwner !== 'composer' && atPick && atItems.length ? { key: atOwner, node: atPickerList(true) } : null,
  };

  return (
    <>
      <div className="chat-log">
        {loaded && messages.length === 0 && (
          <p className="empty-hint">
            <img className="brand-icon" src={iconUrl} alt="" />
            <span className="brand-word">블씨</span>
            이 글에 대해 물어보거나 수정을 요청하세요.
            <br />
            예: "도입부를 더 생생하게 다듬어줘", "마지막에 요약 표 만들어줘"
          </p>
        )}
        <MessageList
          messages={messages}
          convKey={convKey}
          refActions={post ? refActions : undefined}
          onReferImage={(uri, meta, name) => referTarget.current()?.insertRef(refFromLib(uri, meta, name))}
          onOpenRef={openComposerRef}
        />
        {asking && (
          <AskCard key={asking.question} req={asking} onAnswer={answerAsk} refActions={post ? refActions : undefined} refInput={askRefInput} />
        )}
        {busy && <div className="msg-working">{status}</div>}

        {proposal && !busy && (
          <div className="proposal">
            <div className="proposal-title">
              {[proposal.hasEdits && '글 편집', proposal.imageCount > 0 && `이미지 넣기 ${proposal.imageCount}장`]
                .filter(Boolean)
                .join(' · ')}{' '}
              제안 {proposal.changes.length}건
            </div>
            {proposal.changes.map((c, i) => {
              const gen = c.after?.match(GEN_URI)?.[0];
              return (
                <div key={i} className="change">
                  <div className="change-head">
                    {CHANGE_LABEL[c.kind]} · {typeLabel(c.type)}
                  </div>
                  {c.before !== undefined && <pre className="before">{c.before}</pre>}
                  {gen && c.kind !== 'moved' ? (
                    <GenImage convKey={convKey} uri={gen} />
                  ) : (
                    c.after !== undefined && c.kind !== 'moved' && <pre className="after">{c.after}</pre>
                  )}
                </div>
              );
            })}
            {conflict && (
              <p className="error">
                요청 이후 에디터 내용이 바뀌었습니다. 적용하면 그 사이 직접 고친 내용이 사라집니다.
              </p>
            )}
            {askEdits && (
              <label className="dont-ask">
                <input
                  type="checkbox"
                  checked={dontAsk.edits}
                  onChange={(e) => setDontAsk((d) => ({ ...d, edits: e.target.checked }))}
                />
                글 편집은 다시 묻지 않기
              </label>
            )}
            {askImages && (
              <label className="dont-ask">
                <input
                  type="checkbox"
                  checked={dontAsk.images}
                  onChange={(e) => setDontAsk((d) => ({ ...d, images: e.target.checked }))}
                />
                이미지 넣기는 다시 묻지 않기
              </label>
            )}
            <div className="row">
              {conflict ? (
                <button className="primary" onClick={() => apply(true)} disabled={busy}>
                  그래도 적용
                </button>
              ) : (
                <button className="primary" onClick={() => apply()} disabled={busy}>
                  적용
                </button>
              )}
              <button className="ghost" onClick={discard} disabled={busy}>
                취소
              </button>
            </div>
          </div>
        )}

        {applied && !proposal && (
          <div className="applied">
            <span>변경 {applied.count}건을 에디터에 적용했어요</span>
            <button className="ghost" onClick={undo} disabled={busy}>
              되돌리기
            </button>
          </div>
        )}
        <div ref={bottom} />
      </div>

      {savedAsk && (
        <div className="prompt-ask">
          <div className="prompt-ask-head">
            <code>/{savedAsk.prompt.command}</code>
            <span>{savedAsk.prompt.name}</span>
          </div>
          {savedAsk.prompt.params.map((p, i) => (
            <label key={p.name} className="prompt-ask-field">
              <code className="prompt-param-name">{p.name}</code>
              {p.description && <span className="prompt-ask-hint">{p.description}</span>}
              <textarea
                value={savedAsk.values[p.name] ?? ''}
                placeholder="값 입력"
                rows={1}
                autoFocus={i === 0}
                onChange={(e) => setSavedAsk({ ...savedAsk, values: { ...savedAsk.values, [p.name]: e.target.value } })}
              />
            </label>
          ))}
          <label className="prompt-ask-field">
            <span className="prompt-ask-label">덧붙일 말</span>
            <textarea
              value={savedAsk.extra}
              placeholder="추가 요청 (선택)"
              rows={1}
              onChange={(e) => setSavedAsk({ ...savedAsk, extra: e.target.value })}
            />
          </label>
          <div className="prompt-ask-actions">
            <button type="button" onClick={() => setSavedAsk(null)}>
              취소
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                const { prompt, values, extra } = savedAsk;
                const text = fillSavedPrompt(prompt, values, extra);
                setSavedAsk(null);
                if (!text) {
                  push({ role: 'info', text: '프롬프트 본문이 비어 있습니다.' });
                  return;
                }
                void send(undefined, undefined, undefined, { command: prompt.command, text });
              }}
            >
              실행
            </button>
          </div>
        </div>
      )}
      {presetAsk && (
        <div className="prompt-ask">
          <div className="prompt-ask-label">{PRESETS[presetAsk.id].label} · 대상</div>
          {presetAsk.items.length === 0 ? (
            <p className="prompt-empty">이 글에 맞는 블록이 없습니다.</p>
          ) : (
            <div className="prompt-ask-blocks" role="listbox">
              {presetAsk.items.map((item) => (
                <div
                  key={item.doc}
                  className={`at-picker-item${presetAsk.picked === item.doc ? ' on' : ''}`}
                  role="option"
                  aria-selected={presetAsk.picked === item.doc}
                  onClick={() => setPresetAsk({ ...presetAsk, picked: item.doc })}
                >
                  {item.image && (
                    <AtPickerThumb
                      uri={item.lib ?? item.doc}
                      thumb={refActions.thumb}
                      onPreview={() => previewPickerImage(item)}
                    />
                  )}
                  <div className="at-picker-text">
                    <div className="at-picker-label">
                      <span className="at-picker-kind">{item.kind}: </span>
                      {item.snippet}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="prompt-ask-actions">
            <button type="button" onClick={() => setPresetAsk(null)}>
              취소
            </button>
            <button
              type="button"
              className="primary"
              autoFocus
              disabled={!presetAsk.picked}
              onClick={() => {
                const doc = lastDoc.current;
                const item = presetAsk.items.find((it) => it.doc === presetAsk.picked);
                const block = item && blockOfRef(item.doc);
                const cid = block ? refs.current.idOf(block) : undefined;
                const comp = cid ? doc?.document.components.find((c) => c.id === cid) : undefined;
                if (!doc || !item || !comp) return;
                const { id, extra } = presetAsk;
                setPresetAsk(null);
                void send({ id, target: focusForAsk(doc, comp, item), extra, immediate: true, picked: item });
              }}
            >
              입력
            </button>
          </div>
        </div>
      )}

      {createAsk && (
        <div
          className="prompt-ask"
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key !== 'Tab') return;
            e.preventDefault();
            if (createAsk.step === 'instruction') {
              // 저장은 원문이 있어야 넘어간다.
              if (createAsk.mode === 'save' && !createAsk.instruction.trim()) return;
              setCreateAsk({ ...createAsk, step: 'scope', instruction: createAsk.mode === 'save' ? createAsk.instruction.trim() : '' });
              return;
            }
            const { instruction, mode, request } = createAsk;
            setCreateAsk(null);
            void send(undefined, { instruction, scope: 'post', mode, ...(request?.trim() ? { request: request.trim() } : {}) });
          }}
        >
          {createAsk.step === 'instruction' ? (
            <>
              <div className="prompt-ask-label">{createAsk.mode === 'save' ? '저장할 프롬프트 원문' : '요청사항'}</div>
              <textarea
                value={createAsk.instruction}
                placeholder={createAsk.mode === 'save' ? '프롬프트를 붙여 넣어 주세요. 매번 바꿀 자리는 {{칸이름}}으로 적어도 돼요' : '없으면 생략'}
                rows={createAsk.mode === 'save' ? 8 : 3}
                autoFocus
                onChange={(e) => setCreateAsk({ ...createAsk, instruction: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (!createAsk.instruction.trim()) return;
                    setCreateAsk({ ...createAsk, step: 'scope', instruction: createAsk.instruction.trim() });
                  }
                }}
              />
              {createAsk.mode === 'save' && (
                <>
                  <div className="prompt-ask-label">요청사항</div>
                  <textarea
                    value={createAsk.request ?? ''}
                    placeholder="없으면 생략 (예: 캐릭터 이름만 칸으로 둬 줘)"
                    rows={2}
                    onChange={(e) => setCreateAsk({ ...createAsk, request: e.target.value })}
                  />
                </>
              )}
              <div className="prompt-ask-actions">
                {createAsk.mode === 'make' && (
                  <button type="button" onClick={() => setCreateAsk({ ...createAsk, step: 'scope', instruction: '' })}>
                    생략
                  </button>
                )}
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    if (!createAsk.instruction.trim()) return;
                    setCreateAsk({ ...createAsk, step: 'scope', instruction: createAsk.instruction.trim() });
                  }}
                >
                  입력
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="prompt-ask-label">스코프</div>
              <div className="prompt-scope">
                <button type="button" className={createAsk.scope === 'post' ? 'on' : ''} onClick={() => setCreateAsk({ ...createAsk, scope: 'post' })}>
                  이 글
                </button>
                <button type="button" className={createAsk.scope === 'all' ? 'on' : ''} onClick={() => setCreateAsk({ ...createAsk, scope: 'all' })}>
                  모든 글
                </button>
              </div>
              <div className="prompt-ask-actions">
                <button
                  type="button"
                  onClick={() => {
                    const { instruction, mode, request } = createAsk;
                    setCreateAsk(null);
                    void send(undefined, { instruction, scope: 'post', mode, ...(request?.trim() ? { request: request.trim() } : {}) });
                  }}
                >
                  생략
                </button>
                <button
                  type="button"
                  className="primary"
                  autoFocus
                  onClick={() => {
                    const { instruction, scope, mode, request } = createAsk;
                    setCreateAsk(null);
                    void send(undefined, { instruction, scope, mode, ...(request?.trim() ? { request: request.trim() } : {}) });
                  }}
                >
                  입력
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {ready || busy ? (
        <div className="composer">
          {composerRefs.some((r) => r.current) && (
            <div className="composer-refs">
              {composerRefs
                .filter((r) => r.current)
                .map((r) => (
                  <ComposerRefChip
                    key={`${r.doc ?? ''}|${r.lib ?? ''}|${r.label}`}
                    item={r}
                    convKey={convKey}
                    onOpen={() => openComposerRef(r)}
                    onRemove={() => {
                      if (selected) setDismissedId(focusKey(selected));
                      setComposerRefs([]);
                    }}
                  />
                ))}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="attachments">
              {attachments.map((uri) => (
                <div key={uri} className="attachment">
                  <GenImage convKey={convKey} uri={uri} />
                  <button
                    className="ghost"
                    onClick={() => setAttachments((prev) => prev.filter((u) => u !== uri))}
                    aria-label="첨부 빼기"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="composer-input-wrap">
            {slash !== null && !atPick && slashItems.length > 0 && (
              <div className="at-picker" role="listbox">
                {slashItems.map((item, i) => (
                  <button
                    key={`${item.kind}-${item.command}`}
                    type="button"
                    className={`at-picker-item${i === slashIndex ? ' active' : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setSlashIndex(i)}
                    onClick={() => pickSlash(item)}
                  >
                    <div className="at-picker-text">
                      <div className="at-picker-label">{item.label}</div>
                      {item.kind !== 'list' && <div className="at-picker-prefix">/{item.command}</div>}
                    </div>
                  </button>
                ))}
              </div>
            )}
            {atOwner === 'composer' && atPick && atItems.length > 0 && atPickerList(false)}
            <ComposerInput
              ref={composerInput}
              disabled={!!asking}
              placeholder={asking ? '위 질문 카드에서 답해 주세요' : AVAIL.ready.placeholder}
              onChange={syncComposer}
              onPaste={onPasteImages}
              onKeyDown={(e) => {
                if (atOwner === 'composer' && pickerKey(e)) return;
                if (slash !== null && slashItems.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setSlashIndex((i) => (i + 1) % slashItems.length);
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setSlashIndex((i) => (i - 1 + slashItems.length) % slashItems.length);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setSlash(null);
                    return;
                  }
                  const exact = slashItems.some((item) => item.kind !== 'list' && item.command === slash.toLowerCase());
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !exact) {
                    e.preventDefault();
                    pickSlash(slashItems[slashIndex] ?? slashItems[0]);
                    return;
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
          </div>
          <div className="composer-bar">
            <div className="composer-hint">
              <span>{asking ? AVAIL.ready.hint : `${AVAIL.ready.hint} · @로 글 참조`}</span>
              <button type="button" className="composer-chip" onClick={() => setPromptList(true)} title="프롬프트와 빠른 실행 목록">
                / 프롬프트
              </button>
            </div>
            {busy && (
              <button onClick={() => abort.current?.abort()} disabled={!abort.current}>
                중지
              </button>
            )}
            {!busy && (
              <button className="primary" onClick={() => send()} disabled={!canSend}>
                보내기
              </button>
            )}
          </div>
        </div>
      ) : (
        <BlockedComposer avail={avail} onRefresh={onRefresh} />
      )}
      {promptList && (
        <PromptList
          convKey={convKey}
          onClose={() => setPromptList(false)}
          onSaved={(command) => push({ role: 'info', text: `프롬프트를 저장했습니다. /${command}` })}
          onRun={(text) => {
            setPromptList(false);
            composerInput.current?.setText(text);
            // 입력창에 명령을 넣은 뒤 보내면, 칸이 있는 프롬프트는 칸 카드가 열린다.
            requestAnimationFrame(() => void send());
          }}
        />
      )}
      {chipPreview && (
        <ImagePreview
          convKey={convKey}
          uri={chipPreview.uri}
          image={chipPreview.image}
          name={chipPreview.name}
          onClose={closeChipPreview}
          onRefer={(meta) => {
            referTarget.current()?.insertRef(refFromLib(chipPreview.uri, meta, chipPreview.name));
            closeChipPreview();
          }}
        />
      )}
    </>
  );
}

/**
 * elicitation form 카드: message는 카드 안(마크다운·blsee 칩).
 * requestedSchema로 입력 필드를 그리고 accept/decline content를 보낸다.
 * dontAskKey가 있으면 「다시 묻지 않기」 체크.
 */
/** 질문 카드 입력칸과 @ 피커를 잇는 손잡이 (Chat이 넘긴다) */
interface AskRefInput {
  /** 이 칸이 참조를 받을 칸이 된다 (포커스·처음 그릴 때). */
  register: (key: string, handle: ComposerInputHandle | null) => void;
  /** 입력이 바뀌면 @ 피커를 연다·닫는다. */
  onInput: (key: string, handle: ComposerInputHandle) => void;
  /** 피커가 열려 있으면 화살표·Enter·Esc를 피커가 받는다. 받았으면 true */
  onKey: (e: KeyboardEvent<HTMLDivElement>) => boolean;
  /** 피커가 열린 칸의 key와 그 피커 */
  picker: { key: string; node: ReactNode } | null;
}

function AskCard({
  req,
  onAnswer,
  refActions,
  refInput,
}: {
  req: AskRequest;
  onAnswer: (a: AskAnswer) => void;
  refActions?: RefActions;
  refInput: AskRefInput;
}) {
  const schema = req.requestedSchema;
  const fields = Object.entries(schema.properties);
  const [values, setValues] = useState<Record<string, unknown>>(() => askDefaults(schema));
  const [error, setError] = useState<string | null>(null);
  const [skipNext, setSkipNext] = useState(false);
  const mdComponents = useMdComponents(refActions);
  const soleField = fields.length === 1 ? fields[0] : null;
  const soleEnum =
    soleField && soleField[1].type === 'string' && soleField[1].enum?.length ? soleField : null;
  /** 처음 커서를 둘 글 칸 (선택지 하나뿐인 카드는 두지 않는다) */
  const firstText = soleEnum ? null : (fields.find(([, prop]) => prop.type === 'string')?.[0] ?? null);

  const setField = (key: string, value: unknown) => {
    setError(null);
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const rememberSkip = async () => {
    if (req.dontAskKey && skipNext) await setAskSkipped({ [req.dontAskKey]: true });
  };

  const accept = async (content: Record<string, unknown>) => {
    const err = validateAskContent(schema, content);
    if (err) {
      setError(err);
      return;
    }
    await rememberSkip();
    onAnswer({ action: 'accept', content });
  };

  const decline = async () => {
    await rememberSkip();
    const content = askPackedContent(values);
    onAnswer({ action: 'decline', ...(content ? { content } : {}) });
  };

  const submit = () => void accept(values);

  return (
    <div className="ask-card">
      <div className="ask-title">블씨가 확인이 필요합니다</div>
      <div className="ask-message md">
        <Markdown remarkPlugins={[remarkGfm]} urlTransform={keepRefUrl} components={mdComponents}>
          {linkBareRefs(req.question)}
        </Markdown>
      </div>
      <div className="ask-fields">
        {fields.map(([key, prop]) => (
          <AskField
            key={key}
            name={key}
            prop={prop}
            value={values[key]}
            autoFocus={firstText === key}
            clickAccept={!!soleEnum && soleEnum[0] === key}
            refInput={refInput}
            onChange={(v) => setField(key, v)}
            onEnumAccept={(v) => void accept({ ...values, [key]: v })}
            onSubmit={submit}
          />
        ))}
      </div>
      {error && <div className="ask-error">{error}</div>}
      {req.dontAskKey && (
        <label className="dont-ask">
          <input type="checkbox" checked={skipNext} onChange={(e) => setSkipNext(e.target.checked)} />
          다시 묻지 않기
        </label>
      )}
      <div className="row">
        <button type="button" className="ghost" onClick={() => onAnswer({ action: 'cancel' })}>
          중지
        </button>
        <button type="button" className="ghost" onClick={() => void decline()}>
          거절
        </button>
        <button type="button" className="primary" onClick={submit}>
          확인
        </button>
      </div>
    </div>
  );
}

function AskField({
  name,
  prop,
  value,
  autoFocus,
  clickAccept,
  refInput,
  onChange,
  onEnumAccept,
  onSubmit,
}: {
  name: string;
  prop: AskPropertySchema;
  value: unknown;
  autoFocus: boolean;
  clickAccept: boolean;
  refInput: AskRefInput;
  onChange: (v: unknown) => void;
  onEnumAccept: (v: string) => void;
  onSubmit: () => void;
}) {
  const label = prop.title ?? name;
  const text = useRef<ComposerInputHandle>(null);
  const isText = prop.type !== 'boolean' && prop.type !== 'number' && prop.type !== 'integer';

  // 글 칸: 기본값을 넣고, 첫 칸이면 커서를 두어 참조를 받을 칸으로 삼는다.
  useEffect(() => {
    if (!isText) return;
    const h = text.current;
    if (!h) return;
    if (typeof value === 'string' && value) h.setText(value);
    if (autoFocus) {
      h.focus();
      refInput.register(name, h);
    }
    return () => refInput.register(name, null);
    // 처음 그릴 때 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (prop.type === 'boolean') {
    return (
      <label className="ask-field ask-bool">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
        {prop.description && <span className="ask-field-desc">{prop.description}</span>}
      </label>
    );
  }
  if (prop.type === 'number' || prop.type === 'integer') {
    return (
      <label className="ask-field">
        <span className="ask-field-label">{label}</span>
        {prop.description && <span className="ask-field-desc">{prop.description}</span>}
        <input
          type="number"
          value={typeof value === 'number' ? value : ''}
          min={prop.minimum}
          max={prop.maximum}
          step={prop.type === 'integer' ? 1 : 'any'}
          onChange={(e) => {
            const n = e.target.value === '' ? undefined : Number(e.target.value);
            onChange(n !== undefined && Number.isFinite(n) ? n : undefined);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
      </label>
    );
  }
  const enums = prop.type === 'string' ? prop.enum : undefined;
  return (
    <div className="ask-field">
      {fieldsLabelNeeded(prop) && <span className="ask-field-label">{label}</span>}
      {prop.description && <span className="ask-field-desc">{prop.description}</span>}
      {!!enums?.length && (
        <div className="ask-options">
          {enums.map((o: string) => (
            <button
              key={o}
              type="button"
              className={`ask-option${value === o ? ' selected' : ''}`}
              onClick={() => (clickAccept ? onEnumAccept(o) : onChange(o))}
            >
              {o}
            </button>
          ))}
        </div>
      )}
      <div className="composer-input-wrap">
        {refInput.picker?.key === name && refInput.picker.node}
        <ComposerInput
          ref={text}
          compact
          placeholder={enums?.length ? '다른 답이면 직접 써 주세요 · @로 글 참조' : `${label}을(를) 입력 · @로 글 참조`}
          onFocus={() => refInput.register(name, text.current)}
          onChange={() => {
            const h = text.current;
            if (!h) return;
            onChange(h.read().text);
            refInput.onInput(name, h);
          }}
          onKeyDown={(e) => {
            if (refInput.onKey(e)) return;
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
      </div>
    </div>
  );
}

function fieldsLabelNeeded(prop: AskPropertySchema): boolean {
  if (prop.type !== 'string') return true;
  // 단독 answer 필드는 카드 질문만으로 충분
  return !!prop.title && prop.title !== '답';
}

/** 대화를 보낼 수 없을 때의 입력창: 잠긴 입력창, 이유 한 줄, 새로고침 버튼 */
export function BlockedComposer({ avail, onRefresh }: { avail: Avail; onRefresh: () => void }) {
  const a = AVAIL[avail];
  return (
    <div className="composer">
      <textarea value="" placeholder={a.placeholder} disabled rows={3} />
      <div className="composer-bar">
        <div className="composer-hint blocked">
          <Dot kind={a.dot} />
          <span>{a.hint}</span>
        </div>
        {a.refresh && <button onClick={onRefresh}>새로고침</button>}
      </div>
    </div>
  );
}

/** 블씨가 보관한 이미지(blsee://lib/images/{ID}) 미리보기. 누르면 크게 보고 파일로 저장할 수 있다. */
function GenImage({
  convKey,
  uri,
  name,
  onRefer,
}: {
  convKey: string;
  uri: string;
  name?: string;
  onRefer?: (meta: ImageMeta | null) => void;
}) {
  const [image, setImage] = useState<{ url: string; blob: Blob } | null>(null);
  const [missing, setMissing] = useState(false);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    getImage(convKey, uri).then(
      (blob) => {
        if (cancelled) return;
        if (!blob) return setMissing(true);
        objectUrl = URL.createObjectURL(blob);
        setImage({ url: objectUrl, blob });
      },
      () => !cancelled && setMissing(true),
    );
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [convKey, uri]);

  if (missing) return <span>(이미지를 이 PC에서 찾지 못했어요)</span>;
  if (!image) return <span>불러오는 중…</span>;
  return (
    <>
      <img className="gen-image clickable" src={image.url} alt={name ?? uri} title="크게 보기" onClick={() => setOpen(true)} />
      {open && (
        <ImagePreview
          convKey={convKey}
          uri={uri}
          image={image}
          name={name}
          onClose={close}
          onRefer={
            onRefer
              ? (meta) => {
                  onRefer(meta);
                  close();
                }
              : undefined
          }
        />
      )}
    </>
  );
}

/** 입력창·보낸 메시지용 참조 칩 */
function ComposerRefChip({
  item,
  convKey,
  onOpen,
  onRemove,
}: {
  item: RefItem;
  convKey: string;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  const thumbUri = item.lib ?? (item.doc && parseUri(item.doc)?.kind === 'image' ? item.doc : undefined);
  return (
    <button type="button" className="selection-chip composer-ref-chip" title={item.label} onClick={onOpen}>
      {thumbUri && parseImageUri(thumbUri)?.kind === 'gen' && <GenThumb convKey={convKey} uri={thumbUri} />}
      <span>{item.label}</span>
      {onRemove && (
        <span
          role="button"
          className="composer-ref-x"
          aria-label="빼기"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ✕
        </span>
      )}
    </button>
  );
}

function GenThumb({ convKey, uri }: { convKey: string; uri: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    genThumb(convKey, uri).then((u) => !cancelled && setUrl(u));
    return () => {
      cancelled = true;
    };
  }, [convKey, uri]);
  if (!url) return null;
  return <img className="ref-thumb" src={url} alt="" />;
}

/** 디스크(작업공간) 또는 확장 저장소(chrome.storage 한도)가 가득 찼는지 */
function isQuotaError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'QuotaExceededError') return true;
  return /quota/i.test(err instanceof Error ? err.message : String(err));
}

function saveErrorText(err: unknown): string {
  if (isQuotaError(err)) {
    return '저장 공간이 부족해 대화를 저장하지 못했어요. 디스크(또는 저장장치)의 공간을 확보하거나 지난 대화 기록을 지워 주세요. 공간이 생기면 다음 메시지 때 대화 전체가 다시 저장돼요.';
  }
  return `대화를 저장하지 못했어요: ${err instanceof Error ? err.message : String(err)}`;
}

const IMAGE_NAME_CHARS = 40;
/** 이미지 정보에 이름이 없을 때: 미리보기 설명의 앞부분 */
const fallbackName = (text: string) => text.replace(/^만든 이미지 · /, '').slice(0, IMAGE_NAME_CHARS).trim() || undefined;

function genIdOf(uri: string): string | null {
  const u = parseImageUri(uri);
  return u?.kind === 'gen' ? u.id : null;
}

/** 대화에 있는 이미지 URI: 만든 이미지와 사용자가 첨부한 이미지 */
function conversationImages(messages: ChatMessage[]): string[] {
  return messages.flatMap((m) => (m.role === 'image' ? [m.uri] : m.role === 'user' ? (m.attachments ?? []) : []));
}

/**
 * 답변 속 blsee:// 참조. 알려진 문서·이미지 URI뿐 아니라
 * 형식만 맞는 알 수 없는 URI도 칩으로 보여 준다.
 */
const REF_SRC = String.raw`blsee://[a-zA-Z0-9._~:/?#\[\]@!$&'*+,;=%-]+`;
const REF_HREF = new RegExp(`^(?:${REF_SRC})$`);
const BARE_REF = new RegExp(String.raw`(?<![\w/\[(:.-])(${REF_SRC})(?![\w\]/-])`, 'g');
const KNOWN_DOC_URI = new RegExp(`^(?:${DOC_URI_SRC})$`);
const CODE_SPAN = /(```[\s\S]*?```|`[^`\n]*`)/;

/** 링크로 감싸지 않고 그냥 쓴 참조도 칩이 되도록 링크로 바꾼다 (코드 안은 그대로). */
function linkBareRefs(text: string): string {
  return text
    .split(CODE_SPAN)
    .map((part, i) => (i % 2 ? part : part.replace(BARE_REF, '[$1]($1)')))
    .join('');
}

function keepRefUrl(url: string): string {
  return REF_HREF.test(url) ? url : defaultUrlTransform(url);
}

export interface RefActions {
  /** 에디터에서 그 위치를 보여 준다 */
  open: (ref: string) => void;
  /** 링크 글을 쓸 수 없을 때 대신 보일 이름 */
  label: (ref: string) => string | undefined;
  /** 이미지면 작은 미리보기 주소 */
  thumb: (ref: string) => Promise<string | null>;
}

function fallbackLabel(ref: string): string {
  const u = parseUri(ref);
  if (u?.kind === 'html') return '인포그래픽';
  const img = parseImageUri(ref);
  if (img?.kind === 'gen') return '만든 이미지';
  if (img) return '이미지';
  if (KNOWN_DOC_URI.test(ref)) return '글 위치';
  return '알 수 없는 대상';
}

const REF_IN_TEXT = new RegExp(String.raw`(^|[^\w])(${REF_SRC})($|[^\w])`);
/** 이것만으로는 어느 것인지 알 수 없는 이름 */
const GENERIC_NAMES = new Set(['이미지', '사진', '새 이미지', '만든 이미지', '그림', '블록', '여기', '이곳']);

function RefChip({ href, text, actions }: { href: string; text: string; actions?: RefActions }) {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    actions
      ?.thumb(href)
      .then((u) => !cancelled && setThumb(u))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [href]);

  // 링크 글에 URI가 섞여 있거나 너무 막연하면 문서에서 이름을 다시 짓는다.
  const usable = text && !REF_IN_TEXT.test(text) && !GENERIC_NAMES.has(text.trim());
  const label = usable ? text : (actions?.label(href) ?? fallbackLabel(href));
  const body = (
    <>
      {thumb && <img className="ref-thumb" src={thumb} alt="" />}
      {label}
    </>
  );
  if (!actions) return <span className="ref-chip">{body}</span>;
  const isImage = !!parseImageUri(href) || !!thumb;
  return (
    <button
      className="ref-chip"
      title={isImage ? '미리보기 · 에디터에서 보기' : '에디터에서 보기'}
      onClick={() => actions.open(href)}
    >
      {body}
    </button>
  );
}

function PstaticThumb({ src }: { src: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    pstaticThumb(src).then((u) => !cancelled && setUrl(u));
    return () => {
      cancelled = true;
    };
  }, [src]);
  return url ? <img className="ref-thumb" src={url} alt="" /> : null;
}

/** @ 피커 이미지 행: 작은 썸네일, 누르면 미리보기 (행 클릭은 칩 추가) */
function AtPickerThumb({
  uri,
  thumb,
  onPreview,
}: {
  uri: string;
  thumb: (ref: string) => Promise<string | null>;
  onPreview: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    thumb(uri).then((u) => !cancelled && setUrl(u));
    return () => {
      cancelled = true;
    };
    // refActions는 매 렌더마다 새로 만들어지므로 uri만 본다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri]);
  return (
    <button
      type="button"
      className="at-picker-thumb"
      title="미리보기"
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onPreview();
      }}
    >
      {url ? <img src={url} alt="" /> : <span className="at-picker-thumb-empty" />}
    </button>
  );
}

const TASK_STATE_LABEL: Record<PlanTaskItem['state'], string> = {
  pending: '대기',
  running: '진행 중',
  done: '완료',
  failed: '실패',
  cancelled: '취소',
};

const PLAN_TITLE = { first: '작업 계획', review: '검토 후 다시 세운 계획', retry: '실패 후 다시 세운 계획' };

function PlanCard({ reason, tasks }: { reason?: 'review' | 'retry'; tasks: PlanTaskItem[] }) {
  return (
    <div className="plan-card">
      <div className="plan-title">{PLAN_TITLE[reason ?? 'first']}</div>
      <ol>
        {tasks.map((t) => (
          <li key={t.id} className={`plan-task ${t.state}`} title={t.text}>
            <span className="plan-state">{TASK_STATE_LABEL[t.state]}</span>
            <span>
              {t.title}
              {t.text && <span className="plan-note"> · {t.text}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** 점검 결과 카드에서 처음에 보이는 항목 수 (넘으면 펼치기) */
const REVIEW_SHOWN = 8;

/** MessageList용: 점검 결과. 항목마다 번호·위치·원래 글 → 고칠 글·이유. 편집이 반영되면 만료로 보인다. */
function ReviewCard({ review, expired, refActions }: { review: ReviewResult; expired: boolean; refActions?: RefActions }) {
  const mdComponents = useMdComponents(refActions);
  const [open, setOpen] = useState(false);
  const items = open ? review.items : review.items.slice(0, REVIEW_SHOWN);
  const md = items
    .map((it) => {
      const note = review.notes[it.note - 1] ?? '';
      const change = it.original
        ? it.suggestion !== undefined
          ? `"${it.original}" → "${it.suggestion}"`
          : `"${it.original}"`
        : '';
      return `- **${it.id}** ${it.uri} ${change}${change ? ' · ' : ''}${it.reason}${note && review.notes.length > 1 ? ` _(${note})_` : ''}`;
    })
    .join('\n');
  return (
    <div className={`plan-card review-card${expired ? ' expired' : ''}`}>
      <div className="plan-title">
        점검 결과 {review.id} · {review.scope} · {review.items.length}개{expired ? ' · 편집 뒤 만료됨' : ''}
      </div>
      {review.items.length ? (
        <div className="md">
          <Markdown remarkPlugins={[remarkGfm]} urlTransform={keepRefUrl} components={mdComponents}>
            {linkBareRefs(md)}
          </Markdown>
        </div>
      ) : (
        <div className="plan-note">찾은 것이 없어요.</div>
      )}
      {review.items.length > REVIEW_SHOWN && (
        <button type="button" className="ask-turn-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? '접기' : `${review.items.length - REVIEW_SHOWN}개 더 보기`}
        </button>
      )}
      {!!review.missed?.length && <div className="plan-note">점검하지 못한 곳: {review.missed.join(' / ')}</div>}
    </div>
  );
}

/** Ask 카드에 남길 답 본문 (거절/확인 고정 문구는 빼고 content만). */
function askReplyText(a: AskAnswer): string | undefined {
  if (a.action !== 'accept' && a.action !== 'decline') return undefined;
  const packed = askPackedContent(a.content ?? {});
  if (!packed) return undefined;
  const entries = Object.entries(packed);
  if (entries.length === 1) return String(entries[0]![1]);
  return entries.map(([k, v]) => `${k}: ${v}`).join('\n');
}

const ASK_ACTION_LABEL = { accept: '확인', decline: '거절' } as const;

/** MessageList용: 질문에 대한 답을 한 카드로. */
function AskTurnCard({
  question,
  action,
  text,
  refActions,
}: {
  question: string;
  action: 'accept' | 'decline';
  text?: string;
  refActions?: RefActions;
}) {
  const mdComponents = useMdComponents(refActions);
  const long = question.length > 180 || question.split('\n').length > 4;
  const [open, setOpen] = useState(!long);
  return (
    <div className="ask-turn">
      <div className="ask-turn-label">확인에 대한 답</div>
      <div className={`ask-turn-question md${open ? '' : ' collapsed'}`}>
        <Markdown remarkPlugins={[remarkGfm]} urlTransform={keepRefUrl} components={mdComponents}>
          {linkBareRefs(question)}
        </Markdown>
      </div>
      {long && (
        <button type="button" className="ask-turn-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? '접기' : '질문 펼치기'}
        </button>
      )}
      <div className="ask-turn-answer">
        <span className={`ask-turn-pill ${action}`}>{ASK_ACTION_LABEL[action]}</span>
        {text && <span className="ask-turn-text">{text}</span>}
      </div>
    </div>
  );
}

function textOf(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOf).join('');
  if (isValidElement(children)) {
    const props = children.props as { children?: ReactNode };
    return textOf(props.children);
  }
  return '';
}

/** fenced 본문 줄 수. 끝 개행은 fence 관례라 세지 않는다. */
function fenceLineCount(children: ReactNode): number {
  const text = textOf(children).replace(/\n$/, '');
  if (!text) return 0;
  return text.split('\n').length;
}

const FENCE_COLLAPSE_LINES = 3;

/** 3줄 이상 fence는 접고 펼치기. MessageList·AskCard 공통. */
function CollapsiblePre({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  const lines = fenceLineCount(children);
  const [expanded, setExpanded] = useState(false);
  if (lines < FENCE_COLLAPSE_LINES) {
    return <pre {...props}>{children}</pre>;
  }
  return (
    <div className={`md-pre-wrap${expanded ? ' expanded' : ''}`}>
      <pre {...props}>{children}</pre>
      <button type="button" className="md-pre-toggle" onClick={() => setExpanded((v) => !v)}>
        {expanded ? '접기' : `펼치기 · ${lines}줄`}
      </button>
    </div>
  );
}

/** 마크다운 공통 components (칩 + 접히는 fence). */
function useMdComponents(refActions?: RefActions): Components {
  const actionsRef = useRef(refActions);
  actionsRef.current = refActions;
  const hasActions = !!refActions;
  return useMemo<Components>(
    () => ({
      a: ({ node: _node, href, children, ...props }) =>
        href && REF_HREF.test(href) ? (
          <RefChip href={href} text={textOf(children)} actions={hasActions ? actionsRef.current : undefined} />
        ) : (
          <a {...props} href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
      pre: ({ node: _node, children, ...props }) => <CollapsiblePre {...props}>{children}</CollapsiblePre>,
    }),
    [hasActions],
  );
}

export function MessageList({
  messages,
  convKey,
  refActions,
  onReferImage,
  onOpenRef,
}: {
  messages: ChatMessage[];
  convKey: string;
  refActions?: RefActions;
  onReferImage?: (uri: string, meta: ImageMeta | null, name?: string) => void;
  onOpenRef?: (r: RefItem) => void;
}) {
  const mdComponents = useMdComponents(refActions);
  return (
    <>
      {messages.map((m, i) =>
        m.role === 'step' ? (
          <div key={i} className={`msg-step ${m.ok ? '' : 'fail'}`}>
            {m.text}
          </div>
        ) : m.role === 'image' ? (
          <div key={i} className={`msg image${m.original ? ' original' : ''}`}>
            <GenImage
              convKey={convKey}
              uri={m.uri}
              name={m.name ?? fallbackName(m.text)}
              onRefer={
                onReferImage
                  ? (meta) => onReferImage(m.uri, meta, m.name ?? fallbackName(m.text))
                  : undefined
              }
            />
            <span>{m.text}</span>
            {m.caption && <span className="image-credit">{m.caption}</span>}
          </div>
        ) : m.role === 'plan' ? (
          <PlanCard key={i} reason={m.reason} tasks={m.tasks} />
        ) : m.role === 'ask' ? (
          <AskTurnCard key={i} question={m.question} action={m.action} text={m.text} refActions={refActions} />
        ) : m.role === 'review' ? (
          <ReviewCard key={i} review={m.review} expired={!!m.expired} refActions={refActions} />
        ) : m.role === 'assistant' ? (
          <div key={i} className="msg assistant md">
            <Markdown
              remarkPlugins={[remarkGfm]}
              urlTransform={keepRefUrl}
              components={mdComponents}
            >
              {linkBareRefs(m.text)}
            </Markdown>
          </div>
        ) : (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === 'user' && !!m.attachments?.length && (
              <div className="attachments sent">
                {m.attachments.map((uri) => (
                  <div key={uri} className="attachment">
                    <GenImage
                      convKey={convKey}
                      uri={uri}
                      onRefer={onReferImage ? (meta) => onReferImage(uri, meta) : undefined}
                    />
                  </div>
                ))}
              </div>
            )}
            {m.role === 'user' && !!m.refs?.length && !splitInlineRefs(m.text, m.refs).some((p) => p.type === 'ref') && (
              <div className="composer-refs sent">
                {m.refs.map((r) => (
                  <ComposerRefChip
                    key={`${r.doc ?? ''}|${r.lib ?? ''}|${r.label}`}
                    item={r}
                    convKey={convKey}
                    onOpen={() => onOpenRef?.(r)}
                  />
                ))}
              </div>
            )}
            {m.role === 'user' && m.preset && PRESETS[m.preset] ? (
              <span className="preset-chip" title={m.text}>
                <b>{PRESETS[m.preset].label}</b>
                {m.selection && (
                  <span className="selection-chip small">
                    {m.selectionImage && <PstaticThumb src={m.selectionImage} />}
                    {m.selection}
                  </span>
                )}
              </span>
            ) : (
              <>
                {m.role === 'user' && !m.refs?.length && m.selection && (
                  <div className="selection-chip small">
                    {m.selectionImage && <PstaticThumb src={m.selectionImage} />}
                    {m.selection}
                  </div>
                )}
                {m.role === 'user' && m.refs?.length && splitInlineRefs(m.text, m.refs).some((p) => p.type === 'ref') ? (
                  <span className="user-inline">
                    {splitInlineRefs(m.text, m.refs).map((p, j) =>
                      p.type === 'text' ? (
                        <span key={j}>{p.text}</span>
                      ) : (
                        <ComposerRefChip key={j} item={p.ref} convKey={convKey} onOpen={() => onOpenRef?.(p.ref)} />
                      ),
                    )}
                  </span>
                ) : (
                  m.text
                )}
              </>
            )}
          </div>
        ),
      )}
    </>
  );
}

const STOPPED_STATE_LABEL: Record<PlanTaskItem['state'], string> = {
  pending: '시작 전',
  running: '하던 중',
  done: '완료',
  failed: '실패',
  cancelled: '취소·되돌림',
};

/**
 * 중간에 멈춘 요청의 기록 (대화 기록의 답 자리에 넣는다). 모델이 다음 요청에서 남은 일만 이어 가도록
 * 계획한 작업의 상태, 이번에 만든 이미지, 답을 못 받은 질문을 적는다.
 */
function stoppedNote(why: string, plans: { round: number; tasks: PlanTaskItem[] }[], images: string[], pendingAsk: string | null): string {
  const lines = [`(이 요청은 끝나지 못하고 ${why}.)`];
  const last = plans.at(-1);
  if (last) {
    lines.push('마지막으로 계획한 작업:', ...last.tasks.map((t) => `- [${STOPPED_STATE_LABEL[t.state]}] ${t.title}${t.text ? ` (${t.text})` : ''}`));
    lines.push('완료된 작업은 문서에 남아 있다(적용 전이면 제안으로 남아 있다). 취소·되돌림은 반영되지 않았다.');
  } else {
    lines.push('작업 계획을 세우기 전에 멈췄다.');
  }
  if (images.length) lines.push('이번에 만든 이미지 (다시 만들지 않고 이 URI를 쓴다):', ...images.map((u) => `- ${u}`));
  if (pendingAsk) lines.push(`답을 받지 못한 질문: ${pendingAsk.split('\n')[0]}`);
  return lines.join('\n');
}

/** 요청을 시작할 때 답 자리에 미리 두는 표시. 끝나면 답이나 멈춘 기록으로 바뀐다. */
const UNFINISHED_NOTE = '(이 요청은 끝나지 못하고 멈췄다. 확장이 다시 시작되거나 패널이 닫혔다.)';

/**
 * 끝맺지 못한 요청(답 자리가 UNFINISHED_NOTE)을 채팅 기록의 계획 카드·만든 이미지로 멈춘 기록으로 바꾼다.
 * 채팅 기록은 요청 중에도 저장되므로, 확장이 꺼진 요청도 어디까지 했는지 알 수 있다.
 */
function withUnfinishedNotes(history: ChatTurn[], messages: ChatMessage[]): ChatTurn[] {
  return history.map((turn, i) => {
    if (turn.role !== 'assistant' || turn.text !== UNFINISHED_NOTE) return turn;
    const user = history.slice(0, i).findLast((t) => t.role === 'user');
    const at = user ? messages.findLastIndex((m) => m.role === 'user' && m.text === user.text) : -1;
    if (at < 0) return turn;
    const after = messages.slice(at + 1);
    const end = after.findIndex((m) => m.role === 'user');
    const run = end < 0 ? after : after.slice(0, end);
    const plans = run.flatMap((m) => (m.role === 'plan' ? [{ round: m.round, tasks: m.tasks }] : []));
    const images = run.flatMap((m) => (m.role === 'image' && !m.original ? [`${m.uri} (${m.name || m.text.replace(/^만든 이미지 · /, '')})`] : []));
    return { ...turn, text: stoppedNote('확장이 다시 시작되거나 패널이 닫혀 멈췄다', plans, images, null) };
  });
}

/** 입력이 /make-prompt·/save-prompt 명령이면 그 종류 */
function promptCommandMode(raw: string): 'make' | 'save' | null {
  const is = (command: string) => raw === `/${command}` || raw.startsWith(`/${command} `) || raw.startsWith(`/${command}\n`);
  if (is(PROMPT_SAVE_COMMAND)) return 'save';
  if (is(PROMPT_MAKE_COMMAND)) return 'make';
  return null;
}
