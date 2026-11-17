import type { WSContext, WSEvents } from 'hono/ws';
import {
  PRESETS,
  type AskAnswer,
  type AskRequest,
  type ClientMessage,
  type DocToolName,
  type PresetRequest,
  type PromptCreate,
  type RefItem,
  type ReviewItem,
  type ReviewResult,
  type ServerMessage,
  type TurnMeta,
} from '@blog-helper/shared';
import { normalizeTurnMeta, turnPointsOf } from './agent/messages';
import { runAgent } from './agent/run';
import { createSavedPrompt, isPromptCreate } from './agent/save-prompt';
import { charge, checkAccess } from './keys';
import { UsageMeter } from './usage';

/** 확장이 도구 결과를 돌려주기까지 기다리는 최대 시간 (그림 그리기와 이미지 받기 포함) */
const TOOL_TIMEOUT_MS = 90_000;
/** Cloudflare 프록시는 100초 동안 오가는 것이 없으면 연결을 끊는다. */
const PING_MS = 25_000;
const LOCALE_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

interface Pending {
  resolve: (content: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isStart(msg: ClientMessage): msg is Extract<ClientMessage, { type: 'start' }> {
  return (
    msg.type === 'start' &&
    typeof msg.message === 'string' &&
    typeof msg.outline === 'string' &&
    Array.isArray(msg.history)
  );
}

function refItemOf(v: unknown): RefItem | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Partial<RefItem>;
  if (typeof r.label !== 'string') return null;
  return {
    label: r.label,
    ...(typeof r.doc === 'string' ? { doc: r.doc } : {}),
    ...(typeof r.lib === 'string' ? { lib: r.lib } : {}),
    ...(typeof r.src === 'string' ? { src: r.src } : {}),
    ...(r.current === true ? { current: true } : {}),
  };
}

function refsOf(v: unknown): RefItem[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const refs = v.flatMap((x) => {
    const r = refItemOf(x);
    return r ? [r] : [];
  });
  return refs.length ? refs : undefined;
}

function turnMetaOf(v: unknown): Record<string, TurnMeta> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, TurnMeta> = {};
  for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
    const meta = normalizeTurnMeta(raw);
    if (meta) out[id] = meta;
  }
  return out;
}

function promptCreateOf(v: unknown): PromptCreate | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const p = v as Partial<PromptCreate>;
  if (p.scope !== 'post' && p.scope !== 'all') return undefined;
  return {
    instruction: typeof p.instruction === 'string' ? p.instruction : '',
    scope: p.scope,
    ...(p.mode === 'save' || p.mode === 'make' ? { mode: p.mode } : {}),
    ...(typeof p.request === 'string' && p.request.trim() ? { request: p.request.trim() } : {}),
  };
}

function presetOf(v: unknown): PresetRequest | undefined {
  const p = v as Partial<PresetRequest> | undefined;
  if (typeof p?.id !== 'string' || !Object.hasOwn(PRESETS, p.id) || typeof p.target !== 'string') return undefined;
  return {
    id: p.id,
    target: p.target,
    ...(typeof p.text === 'string' ? { text: p.text } : {}),
    ...(typeof p.extra === 'string' && p.extra.trim() ? { extra: p.extra.trim() } : {}),
  };
}

/**
 * 에이전트 실행 하나를 맡는 WebSocket 연결.
 * 확장이 start를 보내면 실행하고, 문서 도구는 tool_call로 확장에 맡긴 뒤 tool_result를 기다린다.
 */
export function agentSocket(): WSEvents {
  const controller = new AbortController();
  const pending = new Map<string, Pending>();
  /** 사용자 답을 기다리는 질문. 답에는 시간 제한을 두지 않는다. */
  let waitingAnswer: { resolve: (a: AskAnswer) => void; reject: (err: Error) => void } | null = null;
  /**
   * 질문 줄. answer에는 어느 질문의 답인지 표시가 없으니, 동시에 생긴 질문(이미지 여러 장을 함께 만들 때 등)은
   * 앞 질문의 답을 받은 뒤 차례로 보낸다. 그러지 않으면 앞 질문이 덮여 그 작업이 답을 영영 못 받는다.
   */
  let askChain: Promise<unknown> = Promise.resolve();
  let started = false;
  let seq = 0;
  let pinger: ReturnType<typeof setInterval> | undefined;

  const send = (ws: WSContext, msg: ServerMessage) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  const run = async (ws: WSContext, start: Extract<ClientMessage, { type: 'start' }>) => {
    const callTool = (name: DocToolName, args: Record<string, unknown>) =>
      new Promise<string>((resolve, reject) => {
        const callId = `c${++seq}`;
        const timer = setTimeout(() => {
          pending.delete(callId);
          reject(new Error(`${name}: 확장이 ${TOOL_TIMEOUT_MS / 1000}초 안에 응답하지 않았습니다.`));
        }, TOOL_TIMEOUT_MS);
        pending.set(callId, { resolve, reject, timer });
        console.log(`[run] 도구 ${name} ${JSON.stringify(args).slice(0, 200)}`);
        send(ws, { type: 'tool_call', callId, name, args });
      });

    const access = checkAccess(start.key);
    if (!access.ok) {
      send(ws, { type: 'error', message: access.message, code: access.code });
      ws.close();
      return;
    }
    const preset = presetOf(start.preset);
    const promptCreate = promptCreateOf(start.promptCreate);
    const makingPrompt = !!promptCreate || isPromptCreate(start.message);
    console.log(`[run] 요청${preset ? ` (${preset.id})` : ''}${makingPrompt ? ' (프롬프트 저장)' : ''} ${String(start.message).length}자: ${String(start.message).slice(0, 300).replace(/\n/g, ' ⏎ ')}`);
    pinger = setInterval(() => send(ws, { type: 'ping' }), PING_MS);
    let outOfWood = false;
    const meter = new UsageMeter((wood, byPurpose) => {
      send(ws, { type: 'cost', wood, byPurpose });
      if (wood >= access.account.remaining && !outOfWood) {
        outOfWood = true;
        controller.abort();
      }
    });
    /** 사용자에게 묻는다. 질문이 겹쳐도 앞 질문에 답한 뒤 다음 질문을 보낸다. */
    const ask = (req: AskRequest): Promise<AskAnswer> => {
      const asked = askChain.then(() =>
        controller.signal.aborted
          ? ({ action: 'cancel' } as AskAnswer)
          : new Promise<AskAnswer>((resolve, reject) => {
              waitingAnswer = { resolve, reject };
              send(ws, { type: 'ask', ...req });
            }),
      );
      askChain = asked.catch(() => undefined);
      return asked;
    };
    const notify = (ok: boolean, text: string) => send(ws, { type: 'step', ok, text });
    try {
      const text = makingPrompt
        ? await createSavedPrompt({
            history: start.history,
            turnMeta: turnMetaOf(start.turnMeta),
            message: start.message,
            time: typeof start.time === 'string' ? start.time : undefined,
            attached: Array.isArray(start.attached) ? start.attached.map(String) : undefined,
            pointed: turnPointsOf(start.pointed),
            refs: refsOf(start.refs),
            library: start.library === true,
            promptCreate,
            callTool,
            ask,
            notify,
            meter,
            signal: controller.signal,
          })
        : await runAgent({
        history: start.history,
        turnMeta: turnMetaOf(start.turnMeta),
        turnId: typeof start.turnId === 'string' ? start.turnId : undefined,
        message: start.message,
        time: typeof start.time === 'string' ? start.time : undefined,
        attached: Array.isArray(start.attached) ? start.attached.map(String) : undefined,
        outline: start.outline,
        pointed: turnPointsOf(start.pointed),
        refs: refsOf(start.refs),
        images: Array.isArray(start.images) ? start.images.map(String) : [],
        library: start.library === true,
        preset,
        locale: typeof start.locale === 'string' && LOCALE_RE.test(start.locale) ? start.locale : undefined,
        reviews: reviewsOf(start.reviews),
        onReview: (review) => send(ws, { type: 'review', review }),
        onReviewClear: () => send(ws, { type: 'review_clear' }),
        callTool,
        notify,
        onPlan: (round, reason, tasks) => send(ws, { type: 'plan', round, ...(reason ? { reason } : {}), tasks }),
        onTask: (round, id, state, text) => send(ws, { type: 'task', round, id, state, ...(text ? { text } : {}) }),
        ask,
        meter,
        signal: controller.signal,
      });
      if (text) send(ws, { type: 'reply', text });
      send(ws, { type: 'done', usage: meter.list() });
    } catch (err) {
      if (outOfWood) send(ws, { type: 'error', message: '장작을 다 써서 멈췄습니다.', code: 'wood' });
      else if (!controller.signal.aborted) send(ws, { type: 'error', message: String(err) });
    } finally {
      clearInterval(pinger);
      charge(start.key, meter.wood);
      console.log(`[usage] ${access.account.name} · ${meter.summary()}`);
      ws.close();
    }
  };

  return {
    onMessage(event, ws) {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        send(ws, { type: 'error', message: '잘못된 메시지입니다.' });
        return;
      }
      if (msg.type === 'tool_result') {
        const p = pending.get(msg.callId);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(msg.callId);
        p.resolve(String(msg.content));
        return;
      }
      if (msg.type === 'answer') {
        const w = waitingAnswer;
        waitingAnswer = null;
        if (msg.action === 'cancel') {
          w?.resolve({ action: 'cancel' });
        } else {
          const raw = 'content' in msg ? msg.content : undefined;
          const content =
            raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
          if (msg.action === 'decline') {
            w?.resolve({ action: 'decline', ...(content && Object.keys(content).length ? { content } : {}) });
          } else {
            w?.resolve({ action: 'accept', content: content ?? {} });
          }
        }
        return;
      }
      if (started) return;
      if (!isStart(msg)) {
        send(ws, { type: 'error', message: 'start 메시지에 history, message, outline이 필요합니다.' });
        ws.close();
        return;
      }
      started = true;
      void run(ws, msg);
    },
    onClose() {
      clearInterval(pinger);
      controller.abort();
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('연결이 끊겼습니다.'));
      }
      pending.clear();
      waitingAnswer?.reject(new Error('연결이 끊겼습니다.'));
      waitingAnswer = null;
    },
  };
}

/** 확장이 보낸 점검 결과. 모양이 맞는 것만 받는다. */
function reviewsOf(v: unknown): ReviewResult[] {
  if (!Array.isArray(v)) return [];
  const str = (x: unknown) => (typeof x === 'string' ? x : undefined);
  return v.flatMap((r): ReviewResult[] => {
    if (!r || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    const id = str(o.id);
    if (!id || !Array.isArray(o.notes) || !Array.isArray(o.items)) return [];
    const items = o.items.flatMap((it): ReviewItem[] => {
      if (!it || typeof it !== 'object') return [];
      const i = it as Record<string, unknown>;
      const itemId = str(i.id);
      const uri = str(i.uri);
      if (!itemId || !uri || typeof i.note !== 'number') return [];
      return [
        {
          id: itemId,
          uri,
          note: i.note,
          reason: str(i.reason) ?? '',
          ...(str(i.original) !== undefined ? { original: str(i.original) } : {}),
          ...(str(i.suggestion) !== undefined ? { suggestion: str(i.suggestion) } : {}),
        },
      ];
    });
    return [{ id, notes: o.notes.map(String), scope: str(o.scope) ?? '', items }];
  });
}

