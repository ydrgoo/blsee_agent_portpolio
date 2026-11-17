import { interrupt } from '@langchain/langgraph';
import { tool } from 'langchain';
import { z } from 'zod';
import {
  ASK_DONT_ASK_IMAGE_GEN,
  ASK_DONT_ASK_IMAGE_REVIEW,
  askAnswerSchema,
  askNoteSchema,
  type AskAnswer,
  type AskRequest,
  type DocToolName,
  type ImageInput,
  type ResearchKind,
  type ViewImages,
} from '@blog-helper/shared';
import { drawImage, viewImages, type PixelKind } from '../image';
import { imageSearch, webSearch, type WebImageHit } from '../search';
import type { UsageMeter } from '../usage';
import { fetchWebImage } from '../web-image';
import { docUri, readUri } from './schemas';

/** 확장에 도구 실행을 맡기고 결과 글을 받는다. */
export type CallDocTool = (name: DocToolName, args: Record<string, unknown>) => Promise<string>;
/**
 * 이미지 불러오기(get_image, import_image)를 기억해 두는 call. 한 사이클 안에서 같은 이미지를
 * 명세 입력·그림 모델·평가에 여러 번 넣을 때 한 번만 받는다. 실패한 결과는 기억하지 않는다.
 */
export function cachedImageCall(call: CallDocTool): CallDocTool {
  const memo = new Map<string, Promise<string>>();
  return (name, args) => {
    if (name !== 'get_image' && name !== 'import_image') return call(name, args);
    const key = `${name} ${JSON.stringify(args)}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const p = call(name, args).then((out) => {
      if (out.startsWith('실패')) memo.delete(key);
      return out;
    });
    p.catch(() => memo.delete(key));
    memo.set(key, p);
    return p;
  };
}

/** 서버에서만 도는 도구의 진행을 사용자 화면에 한 줄로 알린다. */
export type NotifyStep = (ok: boolean, text: string) => void;

/** 확장 결과가 JSON이어야 하는 호출. 확장이 실패를 글로 돌려주면 그대로 에러로 올린다. */
function parseJson<T>(content: string): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new Error(content);
  }
}

const VIEW_MAX_TARGETS = 6;

function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, compact(v)]),
    );
  }
  return value;
}

/** 검색 결과를 작업공간 라이브러리에 md로 남긴다. 저장하지 못해도 검색 결과는 그대로 쓰므로 null만 돌려준다. */
export async function saveResearch(call: CallDocTool, query: string, content: string, kind: ResearchKind): Promise<string | null> {
  try {
    const uri = await call('store_research', { query, content, kind });
    return uri.startsWith('blsee://') ? uri : null;
  } catch {
    return null;
  }
}

/**
 * 대화(chat)와 계획(plan)이 함께 쓰는 도구: 문서 읽기, 보기, 웹 검색, 사용자에게 묻기.
 * library: 작업공간이 있어 검색 결과를 저장하고 라이브러리를 찾을 수 있다.
 */
export function createSharedTools(call: CallDocTool, meter: UsageMeter, notify: NotifyStep, library = false) {
  const run = (name: DocToolName) => (args: Record<string, unknown>) =>
    call(name, compact(args) as Record<string, unknown>);

  const search = async ({ query }: { query: string }) => {
    notify(true, `웹 검색: ${query}`);
    try {
      const result = await webSearch(query, meter);
      const saved = library ? await saveResearch(call, query, result, 'web_search') : null;
      return saved ? `${result}\n\n(라이브러리에 저장함: ${saved})` : result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(false, `웹 검색 실패: ${message}`);
      return `실패: ${message}`;
    }
  };

  // interrupt로 그래프를 멈추고, 사용자가 답하면 Command({ resume })로 받은 문자열이 여기로 온다.
  const askUser = ({ question, options }: { question: string; options?: string[] }) => {
    const req: AskRequest = {
      question,
      requestedSchema: askAnswerSchema(options),
    };
    const answer = interrupt<AskRequest, string>(req);
    return `사용자 답: ${answer}`;
  };

  return [
    tool(askUser, {
      name: 'ask_user',
      description:
        '사용자에게 질문하고 답을 받는다. 대상이나 원하는 결과가 모호해서 짐작하면 잘못 고칠 수 있을 때만 쓴다. ' +
        '질문은 한 번에 하나, 짧게. 고를 수 있는 답이 분명하면 options로 2~4개를 준다 (사용자는 직접 써서 답할 수도 있다). ' +
        '다른 도구와 같은 차례에 함께 부르지 않는다.',
      schema: z.object({
        question: z.string().min(1).describe('사용자에게 보일 질문 (한국어, 한두 문장)'),
        options: z.array(z.string().min(1)).max(4).optional().describe('고를 수 있는 답 (짧게)'),
      }),
    }),
    tool(search, {
      name: 'web_search',
      description:
        '웹을 검색해 최신 정보나 사실을 확인한다 (한국 웹 기준, 네이버 블로그·위키 등 포함). 검색 모델이 결과를 요약한 글과 출처 링크 목록을 돌려준다. ' +
        '글에 넣을 사실·수치·날짜·장소 정보를 확인하거나, 사용자가 찾아 달라고 할 때 쓴다. 문서·보관 자료는 read/find_text로 본다.',
      schema: z.object({
        query: z
          .string()
          .min(1)
          .describe('검색할 질문. 키워드 나열보다 무엇을 알고 싶은지 한 문장으로 (예: "2026년 벚꽃 개화 예상일 서울")'),
      }),
    }),
    createViewTool(call, meter),
    tool(run('get_outline'), {
      name: 'get_outline',
      description:
        '문서 개요를 다시 받는다. 블록마다 URI, 종류, 글자 수, 앞부분 몇 글자만 나온다. 편집 뒤 전체 구조를 다시 확인할 때 쓴다.',
      schema: z.object({}),
    }),
    createReadTool(call),
    tool(run('find_text'), {
      name: 'find_text',
      description: '문서에서 글자를 찾는다 (대소문자 무시). 찾은 블록 URI와 앞뒤 문맥을 돌려준다.',
      schema: z.object({ query: z.string().min(1).describe('찾을 글자') }),
    }),
    ...(library ? createLibraryTools(run) : []),
  ];
}

/** 작업공간 라이브러리: 전에 만들거나 찾은 이미지, 지난 검색 결과(md) */
function createLibraryTools(run: (name: DocToolName) => (args: Record<string, unknown>) => Promise<string>) {
  return [
    tool(run('search_library'), {
      name: 'search_library',
      description:
        '사용자 PC의 라이브러리에서 전에 만들거나 찾은 이미지(다른 글에서 만든 것 포함)와 지난 웹 검색 결과를 찾는다. ' +
        '웹 검색이나 이미지 만들기 전에 비슷한 것이 있는지 먼저 본다. 이미지는 캡션·지시·출처·만든 글 제목으로, 검색 결과는 질문과 내용으로 찾는다. ' +
        '찾은 이미지 URI(blsee://lib/images/…)는 insert의 from, replace_image의 sources, make_image의 refs, view·read에 쓴다. ' +
        '검색 결과(blsee://lib/research/…)는 read로 읽는다.',
      schema: z.object({
        query: z.string().min(1).describe('찾을 말'),
        kind: z.enum(['image', 'research']).optional().describe('image 또는 research'),
      }),
    }),
  ];
}

export const MADE = '를 만들었다 (사용자 화면에 미리보기로 보인다). 아직 글에는 들어가지 않았다. 넣으려면 insert 작업의 from에, 글 속 이미지를 바꾸려면 replace_image 작업의 sources에 이 URI를 준다.';
export const RESULT_NOTE =
  '결과로 새 URI(blsee://lib/images/ 뒤에 무작위 8자)를 돌려주며 아직 글에 들어가지 않는다. URI는 돌려받은 그대로 쓴다. ' +
  '글에 넣으려면 작업 목록에 insert(from에 이 URI) 또는 replace_image(sources에 이 URI)를 넣는다.';

export const failText = (err: unknown) => `실패: ${err instanceof Error ? err.message : String(err)}`;

/*
 * 새 이미지를 만들어 확장에 보관하고 URI(blsee://lib/images/…)를 돌려준다. 실패하면 Error.
 * label은 사용자 화면의 미리보기에 붙는 설명이다 (없으면 instruction).
 */

async function storeImage(
  call: CallDocTool,
  image: ImageInput,
  o: { source: string; label: string; caption?: string; ai?: boolean; name?: string },
): Promise<string> {
  const uri = await call('store_image', {
    image,
    source: o.source,
    instruction: o.label,
    ai: o.ai ?? true,
    ...(o.caption ? { caption: o.caption } : {}),
    ...(o.name ? { name: o.name } : {}),
  });
  if (!uri.startsWith('blsee://')) throw new Error(uri);
  return uri;
}

/** 이미지 검색으로 받아 둔 웹 이미지. id(w1, w2…)로 가리킨다. */
export interface WebImage extends WebImageHit {
  id: string;
  image: ImageInput;
}

const CREDIT_TITLE_CHARS = 40;
function creditLine(prefix: string, w: WebImage): string {
  const host = new URL(w.pageUrl).hostname.replace(/^www\./, '');
  const title = w.title.length > CREDIT_TITLE_CHARS ? `${w.title.slice(0, CREDIT_TITLE_CHARS)}…` : w.title;
  return `${prefix}: ${title || host} (${w.pageUrl})`;
}

/** 항목의 ref가 가리키는 이미지. 웹 이미지면 출처 캡션을 단다. */
type ResolvedRef = { image: ImageInput; web?: WebImage };
type ResolveRef = (ref: string) => Promise<ResolvedRef>;

export const REFS_MAX = 3;
/** 참조 이미지를 모델에 넣을 때 긴 변 (원본·바탕은 줄이지 않는다) */
export const REFERENCE_MAX_SIDE = 768;

const imageOf = async (call: CallDocTool, uri: string, maxSide?: number) =>
  parseJson<ImageInput>(await call('get_image', maxSide ? { uri, maxSide } : { uri }));
/** 글·대화·라이브러리 이미지 URI만 받는 ref (빠른 실행) */
const ownImage =
  (call: CallDocTool, maxSide?: number): ResolveRef =>
  async (uri) => ({ image: await imageOf(call, uri, maxSide) });

const creditsOf = (refs: ResolvedRef[]) => refs.flatMap((r) => (r.web ? [creditLine('참고', r.web)] : [])).join('\n') || undefined;

/** 사이클 make/edit이 내는 픽셀 명세. 칸(kind)별로 나뉘고, 조립은 drawImage가 한다. */
export interface PixelRef {
  uri: string;
  role: string;
}

export interface PixelItem {
  kind: PixelKind;
  instruction: string;
  ref?: string;
}

/** 명세 모델이 정하는 것. 원본(바탕)과 이름은 서버가 붙인다. */
export interface PixelSpec {
  mode: 'generate' | 'edit';
  items: PixelItem[];
  refs?: PixelRef[];
  /** 사용자가 확인 카드에 적은 의견 */
  note?: string;
  /** 사용자가 직접 적은 지시 원문 (픽셀 생성에 추가 요청사항으로 넣는다) */
  requests?: string[];
}

export interface ApplyPixelSpecArgs {
  call: CallDocTool;
  meter: UsageMeter;
  locale: string;
  spec: PixelSpec;
  /** 고칠 이미지 URI. edit면 바탕이 된다 */
  original?: string;
  /** 보관할 이미지 이름 */
  name?: string;
  /** 인포 배경 등: 그림 안 글자 강하게 금지 */
  noExtraText?: boolean;
  found?: FoundImages;
  resolve?: ResolveRef;
}

/** 참조 이미지를 불러온다. 보관·글 이미지는 긴 변 REFERENCE_MAX_SIDE로 줄여 받는다. */
function resolveWithFound(call: CallDocTool, found?: FoundImages): ResolveRef {
  const own = ownImage(call, REFERENCE_MAX_SIDE);
  if (!found) return own;
  return async (ref) => {
    if (!WEB_ID.test(ref)) return own(ref);
    const web = found.get(ref);
    if (!web) {
      throw new Error(`${ref}: 찾은 이미지가 아니다. 찾은 이미지: ${[...found.keys()].join(', ') || '없음'}.`);
    }
    return { image: web.image, web };
  };
}

/** PixelSpec을 drawImage로 그려 보관하고 URI를 돌려준다. */
export async function applyPixelSpec(o: ApplyPixelSpecArgs): Promise<string> {
  const { call, meter, locale, spec, noExtraText } = o;
  const resolve = o.resolve ?? resolveWithFound(call, o.found);
  const originalKey = o.original ? refKey(o.original) : '';
  const ordered = pixelRefOrder(spec).filter(
    // 원본은 따로 넘긴다. 고칠 때 어느 칸도 가리키지 않는 참조는 무엇에 쓸지 몰라 원본으로 끌어당기기만 하니 뺀다.
    (r) =>
      refKey(r.uri) !== originalKey &&
      (spec.mode !== 'edit' || spec.items.some((item) => item.ref && refKey(item.ref) === refKey(r.uri))),
  );
  if (ordered.length > REFS_MAX + 1) throw new Error(`참조 이미지는 ${REFS_MAX + 1}장까지다 (${ordered.length}장).`);
  const [original, resolved] = await Promise.all([
    o.original ? imageOf(call, toImageUri(o.original)) : Promise.resolve(undefined),
    Promise.all(ordered.map((r) => resolve(r.uri))),
  ]);
  const indexOf = (uri: string) => ordered.findIndex((r) => refKey(r.uri) === refKey(uri)) + 1;
  const items = spec.items.map((item) => ({
    kind: item.kind,
    instruction: item.instruction,
    ...(item.ref && indexOf(item.ref) > 0 ? { ref: indexOf(item.ref) } : {}),
  }));
  const res = await drawImage(
    { mode: spec.mode, items, original, references: resolved.map((r) => r.image), note: spec.note, requests: spec.requests, locale, noExtraText },
    meter,
  );
  if (!res.image) throw new Error(`이미지 모델이 이미지를 만들지 못했습니다. ${res.text}`);
  const label = o.name?.trim() || clipPromptLabel(spec.items.map((item) => item.instruction).join(', '));
  const source = spec.mode === 'edit' && o.original ? o.original : (resolved.find((r) => r.web)?.web?.pageUrl ?? '');
  return storeImage(call, res.image, { source, label, caption: creditsOf(resolved), name: o.name });
}

const refKey = (uri: string) => (uri.startsWith('blsee://') ? toImageUri(uri) : uri);

/** spec.refs를 앞에 두고, 칸의 ref 중 빠진 URI를 뒤에 붙인다. */
function pixelRefOrder(spec: PixelSpec): PixelRef[] {
  const ordered = [...(spec.refs ?? [])];
  const seen = new Set(ordered.map((r) => refKey(r.uri)));
  for (const item of spec.items) {
    if (!item.ref) continue;
    const key = refKey(item.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push({ uri: item.ref, role: '참조' });
  }
  return ordered;
}

const clipPromptLabel = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t || '이미지';
};

const uriLabel = (uri: string) => (uri.startsWith('blsee://') ? shortBlseeLabel(uri) : uri);

/** Ask 확인문: 지시사항·참조 목록 + 참조 칩 */
export function pixelSpecConfirmQuestion(spec: PixelSpec, o: { original?: string; name?: string } = {}): string {
  const body = [
    o.name && `이름: ${humanizeBlseeInText(o.name)}`,
    `방식: ${spec.mode === 'edit' ? '원본 고치기' : '새로 그리기'}`,
    `지시사항:\n${spec.items.map((item) => confirmItemLine(item.kind, item.instruction, item.ref)).join('\n')}`,
    (o.original || spec.refs?.length) &&
      `참조:\n${[
        ...(o.original ? [`- 원본: ${uriLabel(o.original)}`] : []),
        ...(spec.refs ?? []).map((r) => `- ${r.role}: ${uriLabel(r.uri)}`),
      ].join('\n')}`,
  ].filter(Boolean);
  const chips = blseeRefChips([
    ...(o.original?.startsWith('blsee://') ? [{ label: '원본', ref: o.original }] : []),
    ...(spec.refs ?? []).map((r) => ({ label: r.role, ref: r.uri.startsWith('blsee://') ? r.uri : undefined })),
  ]);
  return (
    `이미지를 이렇게 ${spec.mode === 'edit' ? '고치' : '그리'}려 합니다.\n\n\`\`\`\n${body.join('\n')}\n\`\`\`` + chips
  );
}

export async function confirmPixelSpec(
  ask: ((req: AskRequest) => Promise<AskAnswer>) | undefined,
  spec: PixelSpec,
  o: { original?: string; name?: string } = {},
): Promise<{ ok: boolean; note: string; spec: PixelSpec }> {
  if (!ask) return { ok: true, note: '', spec };
  const answer = await ask({
    question: pixelSpecConfirmQuestion(spec, o),
    requestedSchema: askNoteSchema(),
    dontAskKey: ASK_DONT_ASK_IMAGE_GEN,
  });
  const note = askNoteText(answer);
  if (answer.action === 'decline') return { ok: false, note, spec };
  if (!note) return { ok: true, note: '', spec };
  return { ok: true, note, spec: { ...spec, note } };
}

/** 사용자 확인의 답: 이대로 쓰거나, 다시 그린다 (issues는 다시 그릴 때 반영할 점). */
export type ReviewAnswer = { use: true } | { use: false; issues: string[] };

/**
 * 만든 이미지·인포그래픽을 이대로 쓸지 사용자에게 묻는다 (「다시 묻지 않기」, 의견 칸 지원).
 * - 확인(의견 없음)·다시 묻지 않기·중지 → 이대로 쓴다
 * - 확인 + 의견 → 그 의견을 반영해 다시 그린다
 * - 거절 → 다시 그린다 (의견이 있으면 그 의견, 평가가 짚은 점을 함께 반영)
 */
export async function reviewWithUser(
  ask: ((req: AskRequest) => Promise<AskAnswer>) | undefined,
  o: { what: '이미지' | '인포그래픽'; uri: string; message: string; issues: string[] },
): Promise<ReviewAnswer> {
  if (!ask) return { use: true };
  const remain = [o.message.trim(), ...o.issues.map((i) => `- ${i}`)].filter(Boolean).join('\n');
  const answer = await ask({
    question:
      `${o.what}을 만들었는데 확인이 필요해요.` +
      (remain ? `\n\n${humanizeBlseeInText(remain)}` : '') +
      '\n\n이대로 쓸까요? 확인을 누르면 이대로 쓰고, 거절하거나 의견을 적으면 다시 그려요.' +
      blseeRefChips([{ label: `만든 ${o.what}`, ref: o.uri }]),
    requestedSchema: askNoteSchema('고칠 점'),
    dontAskKey: ASK_DONT_ASK_IMAGE_REVIEW,
  });
  const note = askNoteText(answer);
  if (answer.action === 'cancel') return { use: true };
  if (answer.action === 'accept') return note ? { use: false, issues: [`사용자 의견: ${note}`] } : { use: true };
  return { use: false, issues: [...(note ? [`사용자 의견: ${note}`] : []), ...o.issues] };
}

const bigrams = (s: string) => {
  const t = s.replace(/[\s.,:;!?'"()·\-]/g, '');
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
};

/** 이번 지적이 앞 회차 지적과 거의 같은지 (고쳐 보았는데도 같은 문제가 남았다) */
export function repeatsIssues(now: string[], before: string[]): boolean {
  if (!now.length || !before.length) return false;
  const prev = before.map(bigrams);
  const same = now.filter((n) => {
    const a = bigrams(n);
    return prev.some((b) => {
      // 말만 바꾼 같은 지적도 잡도록, 짧은 쪽 기준으로 글자 쌍이 꽤(35%·4쌍 이상) 겹치면 같은 지적으로 본다.
      const inter = [...a].filter((x) => b.has(x)).length;
      return inter >= 4 && inter / Math.max(1, Math.min(a.size, b.size)) >= 0.35;
    });
  });
  return same.length * 2 >= now.length;
}

/** 웹 이미지를 그대로 쓴다. 출처 캡션이 함께 붙는다. */
export function webImageUri(call: CallDocTool, w: WebImage, name?: string) {
  return storeImage(call, w.image, {
    source: w.pageUrl,
    label: `웹 이미지 · ${w.title || w.pageUrl}`,
    caption: creditLine('출처', w),
    ai: false,
    name: name || w.title.slice(0, NAME_MAX) || undefined,
  });
}

const SEARCH_IMAGES_MAX = 8;
const WEB_ID = /^w\d+$/;

/**
 * 이미지를 찾아 받아 두고, 보는 모델이 본 설명을 붙여 돌려준다. 받지 못한 이미지는 뺀다.
 * found에 새 웹 이미지를 더한다 (id는 이어서 매긴다).
 */
export async function searchWebImages(query: string, meter: UsageMeter, found: Map<string, WebImage>) {
  const hits = await imageSearch(query, SEARCH_IMAGES_MAX, meter);
  const fetched = await Promise.allSettled(hits.map((h) => fetchWebImage(h.imageUrl, h.pageUrl)));
  const added: WebImage[] = [];
  fetched.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const w: WebImage = { ...hits[i], id: `w${found.size + 1}`, image: r.value };
    found.set(w.id, w);
    added.push(w);
  });
  if (!added.length) return { added, text: `"${query}"로 쓸 수 있는 이미지를 찾지 못했다.` };

  const seen = await viewImages(
    added.map((w) => ({ label: w.id, ...w.image })),
    `검색어 "${query}"로 찾은 이미지들이다. 이미지마다 한 줄로: 무엇이 보이는지, 검색어의 대상과 맞는지, 워터마크·로고·큰 글자가 있는지.`,
    meter,
  ).catch(() => '(보는 모델이 확인하지 못했다)');
  const list = added.map((w) => `- ${w.id}: ${w.title || '(제목 없음)'} · ${new URL(w.pageUrl).hostname} (${w.width}x${w.height})`);
  return { added, text: `찾은 이미지:\n${list.join('\n')}\n\n보는 모델이 본 내용:\n${seen}` };
}

const NAME_MAX = 40;
export const nameField = z
  .string()
  .max(NAME_MAX)
  .optional()
  .describe('이미지 이름 (짧은 한국어, 사용자가 파일로 저장할 때 파일 이름이 된다. 예: "성산일출봉 일출", "근의 공식 그래프")');

const READ_IMAGES_MAX = 4;
const BLOCK_ONLY = /^blsee:\/\/block\/\d+$/;
/** 사진 블록 URI(blsee://block/N)는 그 블록의 첫 이미지로 본다. */
export const toImageUri = (uri: string) => (BLOCK_ONLY.test(uri) ? `${uri}/image` : uri);

/** 이번 요청에서 검색해 받아 둔 웹 이미지. 이미지 담당을 여러 번 불러도 이어 쓴다. */
export type FoundImages = Map<string, WebImage>;

const WORKER_NOTE = '결과로 새 URI(blsee://lib/images/ 뒤에 무작위 8자)를 돌려준다. URI는 돌려받은 그대로 쓴다.';

/** 문서·보관 자료 읽기 (계획·이미지·인포 공통). DocTool은 read_blocks. */
export function createReadTool(call: CallDocTool) {
  return tool(({ uris }: { uris?: string[] }) => call('read_blocks', uris?.length ? { uris } : {}), {
    name: 'read',
    description:
      '문서·보관 자료를 읽는다. 블록(blsee://block/3)·범위(blsee://block?from=3&to=8)·보관 이미지(blsee://lib/images/…)·' +
      '인포 HTML(blsee://lib/infographics/…)·검색 자료(blsee://lib/research/…)를 섞어 줄 수 있다 (없으면 문서 전체). ' +
      '인포그래픽 이미지는 HTML 원본을 돌려준다. 일반 사진은 메타만 주고 내용은 view로 본다. 글자 수가 많으면 중간에서 끊는다.',
    schema: z.object({
      uris: z.array(readUri).optional().describe('읽을 URI 목록 (블록·범위·lib/images·lib/infographics·lib/research)'),
    }),
  });
}

/** 이미지를 보관 URI로 옮기고(글 속 이미지는 원본으로 보관) 픽셀을 받는다. */
export async function keptImage(call: CallDocTool, uri: string, maxSide?: number): Promise<{ kept: string; image: ImageInput }> {
  const kept = await call('import_image', { uri: toImageUri(uri) });
  if (!kept.startsWith('blsee://')) throw new Error(kept);
  return { kept, image: await imageOf(call, kept, maxSide) };
}

/** view에서 question을 생략했을 때 묻는 것 */
const VIEW_DESCRIBE = '그림에 무엇이 있는지 짧게 묘사한다: 대상, 배치, 화풍·색감, 글자가 있으면 그 글자.';

/**
 * 보기 (모든 담당 공통): 블록·범위·이미지·인포그래픽을 그림으로 만들어 보는 모델에게 묻고, 답 글만 돌려준다.
 * 그림은 에이전트 대화에 넣지 않는다. question을 생략하면 묘사만 받는다.
 */
export function createViewTool(call: CallDocTool, meter: UsageMeter, found?: FoundImages) {
  const view = async ({ targets, question }: { targets: string[]; question?: string }) => {
    try {
      // 웹 이미지 id(search_images 결과)는 받아 둔 픽셀을, 나머지는 확장이 그린 그림을 본다.
      const webIds = targets.filter((t) => WEB_ID.test(t));
      const docTargets = targets.filter((t) => !WEB_ID.test(t));
      const web = webIds.flatMap((id) => {
        const w = found?.get(id);
        return w ? [{ label: id, ...w.image }] : [];
      });
      const missing = webIds.filter((id) => !found?.has(id)).map((id) => `${id}: 찾은 웹 이미지가 아니다. search_images로 먼저 찾는다.`);
      const drawn = docTargets.length
        ? parseJson<ViewImages>(await call('render_view', { targets: docTargets }))
        : { images: [], notes: [] };
      const images = [...web, ...drawn.images];
      const notes = [...missing, ...drawn.notes];
      if (!images.length) return `실패: 그릴 수 있는 대상이 없습니다.\n${notes.join('\n')}`;
      const answer = await viewImages(images, question?.trim() || VIEW_DESCRIBE, meter);
      return notes.length ? `${answer}\n\n(참고: ${notes.join(' / ')})` : answer;
    } catch (err) {
      return `실패: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  return tool(view, {
    name: 'view',
    description:
      '글의 모양이나 이미지 내용을 눈으로 확인한다. targets의 대상마다 그림을 만들어 보는 모델에게 question을 묻고, 답만 글로 돌려준다. ' +
      `대상은 블록(blsee://block/4), 범위(blsee://block?from=1&to=3), 이미지(blsee://block/4/image, blsee://lib/images/k3x9qa2m), 인포그래픽(blsee://lib/infographics/…) URI` +
      `${found ? ', search_images로 찾은 웹 이미지 id(w1)' : ''}이고 한 번에 ${VIEW_MAX_TARGETS}개까지. ` +
      '이미지 블록 하나만 지정하면 사진 원본을 본다. 확인할 곳은 한 번의 호출에 모두 담는다. 글자·인포 HTML은 read가 더 정확하고 싸므로, 모양·배치·이미지 내용이 필요할 때 쓴다.',
    schema: z.object({
      targets: z
        .array(found ? z.union([docUri, z.string().regex(WEB_ID)]) : docUri)
        .min(1)
        .max(VIEW_MAX_TARGETS)
        .describe('보려는 대상 목록'),
      question: z
        .string()
        .optional()
        .describe('보는 모델에게 물을 것. 무엇을 판단해야 하는지 구체적으로. 생략하면 대상·배치·화풍·글자를 묘사한다'),
    }),
  });
}

export function askNoteText(a: AskAnswer): string {
  if (a.action !== 'accept' && a.action !== 'decline') return '';
  const n = a.content?.note;
  return typeof n === 'string' ? n.trim() : '';
}

const BLSEE_URI_RE = /blsee:\/\/[a-zA-Z0-9._~:/?#\[\]@!$&'*+,;=%-]+/g;

/** 확인문에 넣을 짧은 이름 (URI 전문 대신) */
function shortBlseeLabel(uri: string): string {
  let m = /^blsee:\/\/lib\/images\/([a-z0-9]+)$/.exec(uri);
  if (m) return `이미지 ${m[1]}`;
  m = /^blsee:\/\/gen\/([a-z0-9]+)$/.exec(uri);
  if (m) return `이미지 ${m[1]}`;
  m = /^blsee:\/\/lib\/(?:infographics|html)\/([a-z0-9]+)$/.exec(uri);
  if (m) return `인포 ${m[1]}`;
  m = /^blsee:\/\/lib\/research\/([a-z0-9]+)$/.exec(uri);
  if (m) return `자료 ${m[1]}`;
  m = /^blsee:\/\/block\/(\d+)\/image(?:\/(\d+))?$/.exec(uri);
  if (m) return m[2] ? `글 이미지 ${m[1]}/${m[2]}` : `글 이미지 ${m[1]}`;
  m = /^blsee:\/\/block\/(\d+)$/.exec(uri);
  if (m) return `블록 ${m[1]}`;
  return '참조';
}

function humanizeBlseeInText(text: string): string {
  return text.replace(BLSEE_URI_RE, (uri) => shortBlseeLabel(uri));
}

/** fence 한 줄: instruction 속 URI는 짧은 이름으로, ref는 (참고: …) */
function confirmItemLine(kind: string, instruction: string, ref?: string): string {
  const text = humanizeBlseeInText(instruction);
  if (!ref?.startsWith('blsee://')) return `- ${kind}: ${text}`;
  const label = shortBlseeLabel(ref);
  if (text.includes(label)) return `- ${kind}: ${text}`;
  return `- ${kind}: ${text} (참고: ${label})`;
}

function blseeRefChips(items: { label: string; ref?: string }[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const i of items) {
    if (!i.ref?.startsWith('blsee://') || seen.has(i.ref)) continue;
    seen.add(i.ref);
    lines.push(`- [${i.label}](${i.ref})`);
  }
  return lines.length ? `\n\n참고:\n${lines.join('\n')}` : '';
}

/**
 * 이미지 사이클 make/edit용: 읽고·찾고·웹 이미지를 가져오기만 한다 (픽셀 생성은 런타임).
 */
export function createImageSupportTools(o: {
  call: CallDocTool;
  meter: UsageMeter;
  notify: NotifyStep;
  found: FoundImages;
  made: string[];
}) {
  const { call, meter, notify, found } = o;
  const track = (make: () => Promise<string>) =>
    make().then(
      (uri) => {
        o.made.push(uri);
        return `${uri} 를 만들었다.`;
      },
      (err) => failText(err),
    );
  const webImagesOf = (ids: string[]) => {
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) {
      throw new Error(`${missing.join(', ')}: 찾은 이미지가 아니다. 찾은 이미지: ${[...found.keys()].join(', ') || '없음'}. search_images로 먼저 찾는다.`);
    }
    return ids.map((id) => found.get(id)!);
  };

  return [
    createReadTool(call),
    createViewTool(call, meter, found),
    tool(
      async ({ query }: { query: string }) => {
        notify(true, `이미지 검색: ${query}`);
        try {
          return (await searchWebImages(query, meter, found)).text;
        } catch (err) {
          notify(false, `이미지 검색 실패: ${err instanceof Error ? err.message : String(err)}`);
          return failText(err);
        }
      },
      {
        name: 'search_images',
        description:
          '웹에서 이미지를 찾는다. 결과는 이미지 id(w1, w2…), 제목, 출처 사이트, 보는 모델이 본 내용이다. ' +
          '생김새를 참고해 그릴 때는 refs의 uri에 그 웹 id를 넣는다. ' +
          '사진을 그대로 쓸 때만 use_web_image를 쓴다 (실존 장소·제품 사진, 공식 이미지).',
        schema: z.object({
          query: z.string().min(1).describe('찾을 이미지 검색어'),
        }),
      },
    ),
    tool(
      ({ id, name }: { id: string; name?: string }) => {
        notify(true, '웹 이미지 가져오는 중');
        return track(async () => webImageUri(call, webImagesOf([id])[0], name));
      },
      {
        name: 'use_web_image',
        description:
          `찾은 웹 이미지(search_images의 w1 등)를 그대로 쓸 이미지로 만든다. 출처가 캡션으로 붙는다. ${WORKER_NOTE}`,
        schema: z.object({ id: z.string().regex(WEB_ID).describe('쓸 웹 이미지 id'), name: nameField }),
      },
    ),
  ];
}

/** 대화 전용: 문서 편집을 계획 단계에 넘긴다. 부르면 대화는 그 자리에서 멈추고, 편집이 끝나면 결과 보고와 함께 이어진다. */
export function createRequestEditTool(onRequest: (request: string, reviews?: string[]) => void) {
  return tool(
    ({ request, reviews }: { request: string; reviews?: string[] }) => {
      onRequest(request, reviews?.length ? reviews : undefined);
      return '계획 단계로 넘겼다.';
    },
    {
      name: 'request_edit',
      description:
        '문서를 고치거나 글에 무엇을 넣어야 할 때(이미지 만들어 넣기 포함) 부른다. 계획 담당이 사용자의 원래 요청과 대화, 이 request를 함께 보고 문서를 읽어 작업을 세운다. ' +
        '편집 결과를 검토하다 못 미친 곳이 있을 때도 부른다 (이미 적용된 편집은 남고 그 위에 고친다). 고칠 필요가 없으면 부르지 말고 사용자에게 답한다.',
      schema: z.object({
        request: z
          .string()
          .min(1)
          .describe('이룰 것. 처음에는 사용자가 요청한 것 전부를 줄이지 않고, 다시 넘길 때는 더 고칠 곳과 이유를 블록 URI(blsee://block/3 등)와 함께'),
        reviews: z
          .array(z.string().min(1))
          .optional()
          .describe('점검 결과를 고칠 때 그 번호: 점검 전체(rv1) 또는 항목(rv1-3). 서버가 항목 원문을 계획 담당에게 펼쳐 넘긴다'),
      }),
      returnDirect: true,
    },
  );
}
