/**
 * 에이전트 입력 메시지를 만든다. 프롬프트 캐시가 맞도록
 * - 시스템 메시지에는 바뀌지 않는 글만 둔다.
 * - 사용자 턴에는 그 턴의 정보(시각, 가리킨 곳, 첨부)를 늘 같은 모양으로 붙인다. 지난 턴도 처음 보낼 때와 글자가 같다.
 * - 이번 요청에만 해당하는 맥락(문서 개요, 이미지 목록)은 마지막 사용자 메시지 끝의 [Context]에만 붙인다.
 */
import { AIMessage, HumanMessage, type BaseMessage } from 'langchain';
import type { ChatTurn, RefItem, TurnMeta, TurnPoint } from '@blog-helper/shared';

const BLOCK_URI = /blsee:\/\/block\/[^\s(,]+/;

function pointOf(v: unknown): TurnPoint | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as { doc?: unknown; src?: unknown };
  const doc = typeof p.doc === 'string' && p.doc ? p.doc : undefined;
  const src = typeof p.src === 'string' && p.src ? p.src : undefined;
  if (!doc && !src) return null;
  return { ...(doc ? { doc } : {}), ...(src ? { src } : {}) };
}

/** 모델에게 보이는 doc / src 목록. 빈 항목은 빠진다. */
export function formatTurnPoints(items: TurnPoint[] | undefined): string {
  if (!items?.length) return '';
  return items
    .map((item) => {
      const lines: string[] = [];
      if (item.doc) lines.push(`doc: ${item.doc}`);
      if (item.src) lines.push(`src: ${item.src}`);
      if (!lines.length) return null;
      return `- ${lines[0]}${lines.slice(1).map((l) => `\n  ${l}`).join('')}`;
    })
    .filter((x): x is string => !!x)
    .join('\n');
}

function refPoint(r: RefItem): TurnPoint {
  const src = r.src ?? r.lib;
  return { ...(r.doc ? { doc: r.doc } : {}), ...(src ? { src } : {}) };
}

/**
 * 저장된 예전 턴을 doc/src로 맞춘다.
 * pointed가 문장이면 그 안의 블록 URI와 "원본:"을 읽고, 인포그래픽이면 src는 pointedHtml만 쓴다.
 */
export function normalizeTurnMeta(raw: unknown): TurnMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  const time = typeof v.time === 'string' ? v.time : undefined;
  const attached = Array.isArray(v.attached) ? v.attached.map(String) : undefined;
  const refs = Array.isArray(v.refs)
    ? v.refs.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const r = item as Partial<RefItem>;
        if (typeof r.label !== 'string') return [];
        const ref: RefItem = {
          label: r.label,
          ...(typeof r.doc === 'string' ? { doc: r.doc } : {}),
          ...(typeof r.lib === 'string' ? { lib: r.lib } : {}),
          ...(typeof r.src === 'string' ? { src: r.src } : {}),
          ...(r.current === true ? { current: true } : {}),
        };
        return [ref];
      })
    : undefined;
  const pointed = legacyPoints(v);
  if (!time && !attached?.length && !pointed?.length && !refs?.length) return undefined;
  return {
    ...(time ? { time } : {}),
    ...(attached?.length ? { attached } : {}),
    ...(pointed?.length ? { pointed } : {}),
    ...(refs?.length ? { refs } : {}),
  };
}

function legacyPoints(v: Record<string, unknown>): TurnPoint[] | undefined {
  if (Array.isArray(v.pointed)) {
    const items = v.pointed.flatMap((item) => {
      const p = pointOf(item);
      return p ? [p] : [];
    });
    return items.length ? items : undefined;
  }
  const text = typeof v.pointed === 'string' ? v.pointed : '';
  const pointedLib = typeof v.pointedLib === 'string' ? v.pointedLib : undefined;
  const pointedHtml = typeof v.pointedHtml === 'string' ? v.pointedHtml : undefined;
  const chunks = text.split(/\n|(?=문서 내:)/).map((s) => s.trim()).filter(Boolean);
  const parsed: TurnPoint[] = [];
  for (const chunk of chunks) {
    const doc = chunk.match(/(?:문서 내:\s*)?(blsee:\/\/block\/[^\s(,]+)/)?.[1];
    const src = chunk.match(/원본:\s*(\S+)/)?.[1];
    if (doc || src) parsed.push({ ...(doc ? { doc } : {}), ...(src ? { src } : {}) });
  }
  if (pointedHtml) {
    if (!parsed.length) return [{ src: pointedHtml }];
    return parsed.map((p, i) => (i === 0 ? { ...p, src: pointedHtml } : p));
  }
  if (parsed.length === 1 && pointedLib && !parsed[0].src) return [{ ...parsed[0], src: pointedLib }];
  if (parsed.length) return parsed;
  const doc = text.match(BLOCK_URI)?.[0];
  const src = pointedHtml ?? pointedLib;
  if (doc || src) return [{ ...(doc ? { doc } : {}), ...(src ? { src } : {}) }];
  return undefined;
}

/** 시작 메시지의 pointed 배열. 예전 문장 필드는 normalizeTurnMeta가 맡는다. */
export function turnPointsOf(v: unknown): TurnPoint[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items = v.flatMap((item) => {
    const p = pointOf(item);
    return p ? [p] : [];
  });
  return items.length ? items : undefined;
}

/** 사용자 턴 글 + 그 턴의 정보 */
export function userContent(text: string, meta: TurnMeta | undefined): string {
  const props: string[] = [];
  if (meta?.time) props.push(`time: ${meta.time}`);
  const pointed = formatTurnPoints(meta?.pointed);
  if (pointed) props.push(`pointed:\n${pointed}`);
  const refs = formatTurnPoints(meta?.refs?.map(refPoint));
  if (refs) props.push(`refs:\n${refs}`);
  if (meta?.attached?.length) props.push(`attached:\n${meta.attached.map((u) => `- ${u}`).join('\n')}`);
  return props.length ? `${text}\n\n[Turn]\n${props.join('\n')}` : text;
}

/** 사용자 메시지 번호와 원문 (구체화가 [Metadata]로 보고, 고른 번호의 원문을 그림 담당에게 넘긴다) */
export interface UserRequests {
  /** 메시지 ID → 번호 (1부터) */
  idOf: Map<string, number>;
  /** 번호 → 사용자가 쓴 글 */
  textOf: Map<number, string>;
}

/** 지난 대화와 이번 메시지의 사용자 턴에 차례로 번호를 붙인다. 메시지 ID는 historyMessages와 같다. */
export function userRequestsOf(history: ChatTurn[], currentId: string, currentText: string): UserRequests {
  const idOf = new Map<string, number>();
  const textOf = new Map<number, string>();
  let n = 0;
  history.forEach((t, i) => {
    if (t.role !== 'user') return;
    n += 1;
    idOf.set(t.id ?? `turn-${i}`, n);
    textOf.set(n, t.text);
  });
  n += 1;
  idOf.set(currentId, n);
  textOf.set(n, currentText);
  return { idOf, textOf };
}

/**
 * 구체화에 넣을 대화: 사용자 메시지 끝에 [Metadata](번호)를 붙인 복사본. 원래 메시지는 바꾸지 않는다.
 * 마지막 사용자 메시지 뒤(지금 부른 도구 호출)는 뺀다.
 */
export function withMetadata(messages: BaseMessage[], requests?: UserRequests): BaseMessage[] {
  let last = -1;
  messages.forEach((m, i) => {
    if (m.getType() === 'human') last = i;
  });
  return messages.slice(0, last + 1).map((m) => {
    const n = m.getType() === 'human' && m.id ? requests?.idOf.get(m.id) : undefined;
    if (n === undefined) return m;
    const meta = `[Metadata]\nid: ${n}`;
    const content =
      typeof m.content === 'string' ? `${m.content}\n\n${meta}` : [...m.content, { type: 'text' as const, text: meta }];
    return new HumanMessage({ id: m.id, content });
  });
}

/** 지난 대화. ID가 없는 예전 턴은 순서로 ID를 붙인다. */
export function historyMessages(history: ChatTurn[], turnMeta: Record<string, TurnMeta> = {}): BaseMessage[] {
  return history.map((t, i) => {
    const id = t.id ?? `turn-${i}`;
    return t.role === 'user'
      ? new HumanMessage({ id, content: userContent(t.text, t.id ? turnMeta[t.id] : undefined) })
      : new AIMessage({ id, content: t.text });
  });
}

export interface RequestContext {
  /** 요청 시작 시점 문서 개요 */
  outline: string;
  /** 이 대화에서 지금까지 만든·첨부한 이미지 */
  images: string[];
  library: boolean;
}

function contextText({ outline, images, library }: RequestContext): string {
  const others = library ? ' (search_library로 찾은 라이브러리 이미지도 쓸 수 있다)' : '';
  const made = images.length
    ? `이 대화의 이미지 (글에 넣을 때는 이 URI만 쓴다. 목록에 없는 URI는 없다${others}):\n${images.map((l) => `- ${l}`).join('\n')}`
    : `이 대화에서 만든 이미지는 아직 없다${others}. 새 이미지가 필요하면 make_image나 make_infographic으로 먼저 만든다.`;
  return `[Context]\n요청 시작 시점 문서 개요:\n${outline}\n\n${made}`;
}

/** 이번 요청 메시지 (턴 정보 + [Context]). 한 요청 안에서는 한 번만 만들어 계획·검토가 같은 글을 쓴다. */
export function requestMessage(id: string, text: string, meta: TurnMeta, context: RequestContext): HumanMessage {
  return new HumanMessage({ id, content: `${userContent(text, meta)}\n\n${contextText(context)}` });
}
