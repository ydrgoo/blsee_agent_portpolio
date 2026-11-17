import { HumanMessage, type BaseMessage } from 'langchain';
import { GEN_URI_SRC, normalizeSrc, outlineRefs, outlineTypes, type EditOp } from '@blog-helper/se-model';
import {
  isHtmlUri,
  isImageFileUri,
  type AskAnswer,
  type AskRequest,
  type ChatTurn,
  type PlanTaskView,
  type PresetRequest,
  type RefItem,
  type ReviewItem,
  type ReviewResult,
  type TaskState,
  type TurnMeta,
  type TurnPoint,
} from '@blog-helper/shared';
import { config } from '../config';
import { DEFAULT_LOCALE } from '../image';
import { keyCheckOff } from '../keys';
import type { UsageMeter } from '../usage';
import { editPatches, writeText, type Conversation, type DocContext } from './action';
import { applyPatches, checkUnits, dropStrayTitle, lastInserted, parseText, unwrapOutput, writeOp } from './blsee';
import { createChat } from './chat';
import type { Unit } from './ops';
import { createPlanner } from './plan';
import { preparePreset } from './presets';
import { formatTurnPoints, historyMessages, requestMessage, userRequestsOf } from './messages';
import { chatPrompt, planPrompt } from './prompt';
import type { Task } from './schemas';
import { isRecursionError } from './thread';
import { createMakeImageTool } from './image-agent';
import { createMakeInfographicTool } from './infographic-agent';
import { createReviewTool, expandReviewIds, reviewItemsText, reviewSection } from './review';
import { createSharedTools, type CallDocTool, type NotifyStep } from './tools';
import { planWaves, resolvePlan, type PlannedTask } from './waves';

/** 바뀐 블록을 검토에 넘길 때 읽는 최대 개수 */
const REVIEW_READ_MAX = 20;
const GEN_URI_RE = new RegExp(GEN_URI_SRC, 'g');

function lineUri(line: string): string | undefined {
  return line.match(/blsee:\/\/\S+/)?.[0]?.replace(/[:),.]+$/, '');
}

function imageSrcs(points: TurnPoint[] | undefined): string[] {
  return (points ?? []).flatMap((p) => (p.src && isImageFileUri(p.src) ? [p.src] : []));
}

function infographicSrcs(points: TurnPoint[] | undefined): string[] {
  return (points ?? []).flatMap((p) => (p.src && isHtmlUri(p.src) ? [p.src] : []));
}

function fileSrcs(points: TurnPoint[] | undefined, refs: RefItem[] | undefined): string[] {
  return [
    ...(points ?? []).flatMap((p) => (p.src ? [p.src] : [])),
    ...(refs ?? []).flatMap((r) => {
      const src = r.src ?? r.lib;
      return src ? [src] : [];
    }),
  ];
}

export interface RunAgentOptions {
  history: ChatTurn[];
  /** history 사용자 턴 ID → 턴 정보 */
  turnMeta?: Record<string, TurnMeta>;
  /** 이번 요청의 턴 ID (다음 요청에서 history에 같은 ID로 들어온다) */
  turnId?: string;
  message: string;
  /** 이번 요청을 보낸 시각 */
  time?: string;
  /** 이번 요청에 첨부한 이미지 URI */
  attached?: string[];
  /** 요청 시작 시점 문서 개요 */
  outline: string;
  /** 이번 요청에서 가리킨 곳 */
  pointed?: TurnPoint[];
  /** 현재 위치가 아닌 참조 칩 */
  refs?: RefItem[];
  /** 이 대화에서 지금까지 만든 이미지 */
  images?: string[];
  /** 작업공간 라이브러리를 쓸 수 있다 (검색 결과 저장, 라이브러리 검색) */
  library?: boolean;
  /** 빠른 실행: 첫 회차는 계획 모델 대신 정해진 작업 목록으로 한다. */
  preset?: PresetRequest;
  /** 사용자 언어·지역 (BCP 47). 없으면 ko-KR */
  locale?: string;
  /** 아직 만료되지 않은 점검 결과 (편집이 반영되면 비운다) */
  reviews?: ReviewResult[];
  /** 점검 결과가 나왔다 */
  onReview?: (review: ReviewResult) => void;
  /** 편집이 반영되어 점검 결과가 만료됐다 */
  onReviewClear?: () => void;
  callTool: CallDocTool;
  notify?: NotifyStep;
  onPlan?: (round: number, reason: 'review' | 'retry' | undefined, tasks: PlanTaskView[]) => void;
  onTask?: (round: number, id: string, state: TaskState, text?: string) => void;
  /** ask_user로 멈췄을 때 사용자에게 묻고 답을 받는다. */
  ask: (req: AskRequest) => Promise<AskAnswer>;
  meter: UsageMeter;
  signal?: AbortSignal;
}

/** failures: 다시 써 봐도 적용하지 못해 뺀 작업 (나머지는 반영됐다). failedReviews: 그 작업들이 맡았던 점검 항목 번호 */
type RoundResult =
  | { ok: true; messages: string[]; touched: string[]; failures: string[]; failedReviews: string[] }
  | { ok: false; error: string };

/** 확장의 편집 결과 "실패: 3번째 명령(...) 실패: …"에서 몇 번째 작업인지 찾는다. */
function failedIndex(result: string): number | undefined {
  const m = /(\d+)번째 명령/.exec(result);
  return m ? Number(m[1]) - 1 : undefined;
}

const stripFail = (s: string) => s.replace(/^실패:\s*/, '');

/**
 * 요청 하나를 처리하고 사용자에게 보일 답을 돌려준다.
 * 대화가 먼저 받아 직접 답하거나 편집을 넘기고, 넘기면 계획 → 실행 뒤 대화가 검토하고 답한다.
 * 빠른 실행은 첫 회차를 정해진 작업 목록으로 하고, 검토하지 않는 preset이면 그 회차로 끝낸다.
 * 문서는 확장이 들고 있고, 도구 호출로만 읽고 고친다.
 */
export async function runAgent(o: RunAgentOptions): Promise<string> {
  const { meter, signal, ask } = o;
  const notify = o.notify ?? (() => {});
  const locale = o.locale ?? DEFAULT_LOCALE;

  /**
   * 이 요청에서 쓸 수 있는 lib 이미지. 계획이 지어낸 URI는 실행 전에 걸러 다시 계획시킨다.
   * 대화 목록뿐 아니라 가리킨·첨부 이미지, 도구로 읽거나 보관한 URI도 포함한다.
   */
  const madeUris = new Set((o.images ?? []).flatMap((l) => l.match(GEN_URI_RE) ?? []));
  for (const src of fileSrcs(o.pointed, o.refs)) if (isImageFileUri(src)) madeUris.add(src);
  for (const u of o.attached ?? []) madeUris.add(u);
  const callTool: CallDocTool = async (name, args) => {
    const out = await o.callTool(name, args);
    if (name.startsWith('store_') || name === 'import_image' || name === 'search_library') {
      out.match(GEN_URI_RE)?.forEach((u) => madeUris.add(u));
    }
    // get_image로 실제로 읽힌 URI도 존재하는 것이다 (가리킨 원본 등).
    if (name === 'get_image' && !out.startsWith('실패:') && typeof args.uri === 'string') {
      args.uri.match(GEN_URI_RE)?.forEach((u) => madeUris.add(u));
    }
    return out;
  };
  const unknownImages = (tasks: Task[]) =>
    tasks.flatMap((t, i) => {
      const missing = [t.target.uris, t.sources ?? [], t.from ?? [], t.content ? [t.content] : []]
        .flat()
        .flatMap((s) => s.match(GEN_URI_RE) ?? [])
        .filter((u) => !madeUris.has(u));
      return missing.length
        ? [
            `작업 ${i + 1}(${t.title}): ${missing.join(', ')}는 이 요청에서 알 수 없는 이미지다. ` +
              '대화 목록·가리킨 곳·첨부·도구가 돌려준 URI만 쓰고, 새 그림이면 make_image/make_infographic으로 만든 뒤 그 URI를 쓴다.',
          ]
        : [];
    });

  let fixed: { tasks: Task[]; reply: string; review: boolean } | undefined;
  if (o.preset) {
    const prepared = await preparePreset(o.preset, {
      outline: o.outline,
      callTool,
      meter,
      notify,
      library: !!o.library,
      locale,
      ask,
      signal,
    });
    if (!('tasks' in prepared)) return prepared.reply;
    fixed = prepared;
  }

  const library = !!o.library;
  const currentId = o.turnId ?? `turn-${o.history.length}`;
  /** 사용자 메시지 번호와 원문. make 도구의 구체화가 [Metadata]로 보고 고른다 */
  const userRequests = userRequestsOf(o.history, currentId, o.message);
  const shared = createSharedTools(callTool, meter, notify, library);
  /** 그림 만들기 도구. 대화 담당과 계획 담당이 함께 쓴다. */
  const makeTools = [
      createMakeInfographicTool({
        call: callTool,
        meter,
        notify,
        locale,
        pointed: infographicSrcs(o.pointed),
        ask,
        signal,
        requests: userRequests,
      }),
      createMakeImageTool({
        call: callTool,
        meter,
        locale,
        notify,
        ask,
        signal,
        info: {
          pointed: imageSrcs(o.pointed),
          attached: o.attached,
        },
        requests: userRequests,
      }),
  ];
  /** 아직 만료되지 않은 점검 결과. 대화 담당의 review가 더하고, 편집이 반영되면 비운다. */
  const reviews: ReviewResult[] = [...(o.reviews ?? [])];
  const reviewTool = createReviewTool({ call: callTool, meter, notify, signal, reviews, onReview: o.onReview });
  const plan = createPlanner({ tools: [...shared, ...makeTools], systemPrompt: planPrompt(library), meter, ask, signal });
  const chat = createChat({ tools: [...shared, ...makeTools, reviewTool], systemPrompt: chatPrompt(library), meter, ask, signal });

  /** 실행 모델에게 주는 원래 요청 */
  const pointedText = formatTurnPoints(o.pointed);
  const request = pointedText ? `${o.message}\n(가리킨 곳:\n${pointedText})` : o.message;
  const history = historyMessages(o.history, o.turnMeta);
  const current = requestMessage(
    currentId,
    o.message,
    {
      time: o.time,
      attached: o.attached,
      ...(o.pointed?.length ? { pointed: o.pointed } : {}),
      ...(o.refs?.length ? { refs: o.refs } : {}),
    },
    { outline: o.outline, images: o.images ?? [], library },
  );
  const maxErrors = config.loop.max_consecutive_errors;
  /** 이번 요청 안에서 대화 담당이 넘긴 편집 요청·검토 의견 (write가 함께 본다) */
  const chatEdits: string[] = [];
  const round$ = { request, conv: { messages: [...history, current], edits: chatEdits }, knownImage: (u: string) => madeUris.has(u) };

  /** 대화와 계획은 각자 대화를 이어간다. 처음 부를 때만 대화 기록과 이번 요청을 앞에 붙인다. */
  let chatStarted = false;
  let planStarted = false;
  /** 대화 담당이 처음 받는 이번 요청: 요청 시작 시점의 [Review]를 [Context] 뒤에 붙인다. */
  const startReview = reviewSection(reviews);
  const chatCurrent = startReview ? new HumanMessage({ id: current.id, content: `${current.text}\n\n${startReview}` }) : current;
  const toChat = async (messages: BaseMessage[]) => {
    const turn = await chat(chatStarted ? messages : [...history, chatCurrent, ...messages]);
    chatStarted = true;
    return turn;
  };
  /** 다음에 계획에 줄 메시지. null이면 대화부터 부른다. */
  let planInput: BaseMessage[] | null = null;
  let chatInput: BaseMessage[] = [];
  /** 다시 계획하는 까닭 (첫 계획은 없음) */
  let reason: 'review' | 'retry' | undefined;
  let outline = o.outline;
  let errors = 0;
  let round = 0;
  /** 이번 편집 요청이 반영하라고 한 점검 항목 가운데 계획 담당이 맡은 번호 (계획 검사에서 빠짐을 본다) */
  let wanted: string[] = [];
  /** 고칠 글이 정해진 점검 항목으로 서버가 만든 edit 작업 (회차가 반영될 때까지 계획 결과 앞에 붙인다) */
  let autoTasks: Task[] = [];
  let autoIds = new Set<string>();
  /** 앞 회차까지 적용된 편집 요약 (중간에 멈출 때 사용자에게 알린다) */
  const applied: string[] = [];
  const stopped = (why: string) =>
    applied.length ? `${why}\n\n그전까지 적용된 편집:\n${applied.map((a) => `- ${a}`).join('\n')}` : why;

  try {
    for (;;) {
      const preset = round === 0 ? fixed : undefined;
      let planned: Task[];
      if (preset) {
        planned = preset.tasks;
      } else {
        if (!planInput) {
          const turn = await toChat(chatInput);
          if ('reply' in turn) return turn.reply;
          chatEdits.push(turn.edit);
          if (round > 0) {
            notify(true, `검토 의견으로 다시 고칩니다: ${turn.edit}`);
            reason = 'review';
          }
          const asked = turn.reviews ? expandReviewIds(turn.reviews, reviews) : { items: [], unknown: [] };
          // 고칠 글이 정해진 항목은 서버가 edit 작업(지시에 원래 글 → 고칠 글)으로 바로 만든다. 계획 담당은 정해지지 않은 항목만 맡는다.
          const exact = asked.items.filter((it) => it.original && it.suggestion !== undefined);
          const loose = asked.items.filter((it) => !(it.original && it.suggestion !== undefined));
          autoTasks = reviewEditTasks(exact, outline);
          autoIds = new Set(exact.map((it) => it.id));
          wanted = loose.map((it) => it.id);
          const reviewText = [
            exact.length ? `\n\n점검 항목 ${exact.length}개(고칠 글이 정해진 것)는 서버가 따로 고친다. 이 항목들은 작업으로 만들지 않는다.` : '',
            loose.length
              ? `\n\n반영할 점검 항목 (고칠 글이 정해지지 않았다. 블록을 읽고 고치거나 새로 쓰는 작업으로 반영하고, 각 작업에 반영한 항목 번호를 남긴다):\n${reviewItemsText(loose)}`
              : '',
            exact.length && !loose.length ? '\n\n요청에 점검 항목 밖의 편집이 없으면 작업 없이 그 이유만 남긴다.' : '',
          ].join('');
          const unknownText = asked.unknown.length ? `\n\n(모르는 점검 번호: ${asked.unknown.join(', ')})` : '';
          planInput = [
            new HumanMessage(
              `${instructionText(turn.edit, round > 0 ? { applied, outline } : undefined)}${reviewText}${unknownText}`,
            ),
          ];
        }
        if (config.loop.max_rounds && round >= config.loop.max_rounds) {
          return stopped(`계획하고 고치는 횟수 상한(${config.loop.max_rounds}회)에 닿아 멈췄습니다.`);
        }
        // 첫 계획은 이번 요청 메시지(글, [Turn], [Context]) 끝에 [Instruction]을 붙여 마지막 사용자 메시지 하나로 준다.
        // [Review]는 계획할 때의 점검 결과로 붙인다 (이번 요청 안에서 점검했어도 보이게).
        const nowReview = reviewSection(reviews);
        const planMessages = nowReview ? [new HumanMessage(nowReview), ...planInput] : planInput;
        const p = await plan(planStarted ? planMessages : [...history, withInstruction(current, planMessages)]);
        planStarted = true;
        planInput = null;
        if (keyCheckOff()) console.log(`[plan] ${JSON.stringify({ tasks: p.tasks, note: p.note })}`);
        // 서버가 맡은 점검 항목만 다루는 작업을 계획이 또 냈으면 버린다.
        p.tasks = p.tasks.filter((t) => !(t.reviews?.length && t.reviews.every((id) => autoIds.has(id))));
        if (!p.tasks.length && !autoTasks.length) {
          if (++errors >= maxErrors) return stopped('작업 계획을 세우지 못해 멈췄습니다. 요청을 조금 더 구체적으로 다시 해 주세요.');
          chatInput = [
            new HumanMessage(
              `계획 담당이 작업을 세우지 않았다. 이유: ${p.note?.trim() || '(없음)'}\n이를 바탕으로 사용자에게 답하거나, 요청을 고쳐 request_edit로 다시 넘긴다.`,
            ),
          ];
          continue;
        }
        planned = [...autoTasks, ...p.tasks];
      }

      const resolved = resolvePlan(planned, outline);
      const tasks = resolved.planned;
      const covered = new Set(planned.flatMap((t) => t.reviews ?? []));
      const uncovered = wanted.filter((id) => !covered.has(id));
      const problems = [
        ...resolved.problems,
        ...unknownImages(planned),
        ...(uncovered.length
          ? [
              `점검 항목 ${uncovered.join(', ')}을(를) 반영한 작업이 없다. ` +
                '그 블록을 읽고 고치거나 새로 쓰는 작업으로 반영하고, 각 작업에 반영한 항목 번호를 남긴다.',
            ]
          : []),
      ];
      if (preset && problems.length) return `빠른 실행을 준비하지 못했습니다.\n${problems.join('\n')}`;
      if (problems.length) {
        // 실행 전 검사가 막아 계획 모델이 고쳐 내는 내부 과정이다. 사용자에게 보인 계획이 없으니 "다시 세움"으로 알리지 않고,
        // 회차도 세지 않으며, 다시 계획하는 까닭(review/retry)도 바꾸지 않는다.
        if (++errors >= maxErrors) return stopped(`실행할 수 있는 계획을 세우지 못해 멈췄습니다.\n${problems.join('\n')}`);
        planInput = [new HumanMessage(`계획을 실행하기 전에 검사했더니 고칠 곳이 있다. 아무것도 실행하지 않았다.\n${problems.join('\n')}\n\n고쳐서 작업 목록 전체를 다시 낸다.`)];
        continue;
      }

      round++;
      o.onPlan?.(round, reason, tasks.map((t) => ({ id: t.id, title: t.task.title })));
      const result = await executeRound(round, tasks, round$, o);
      outline = await callTool('get_outline', {});

      if (!result.ok) {
        if (preset || ++errors >= maxErrors) return stopped(`편집을 적용하지 못해 멈췄습니다.\n${result.error}`);
        planInput = [
          new HumanMessage(
            `이번 계획을 실행하다 실패해서 이 회차의 편집은 모두 되돌렸다.\n실패: ${result.error}\n\n지금 문서 개요:\n${outline}\n\n오류를 피해서 다시 계획한다.`,
          ),
        ];
        reason = 'retry';
        continue;
      }
      errors = 0;
      applied.push(...tasks.map((t) => t.task.title));
      // 편집이 반영되면 점검 결과는 만료된다 (원래 글이 더는 맞지 않을 수 있다).
      // 다만 적용하지 못한 작업이 맡았던 항목은 그 블록이 그대로라 남겨, 다시 고칠 수 있게 한다.
      wanted = [];
      autoTasks = [];
      autoIds = new Set();
      if (reviews.length) {
        const keep = new Set(result.failedReviews);
        const remaining = reviews.map((rv) => ({ ...rv, items: rv.items.filter((it) => keep.has(it.id)) })).filter((rv) => rv.items.length);
        reviews.length = 0;
        o.onReviewClear?.();
        for (const rv of remaining) {
          reviews.push(rv);
          o.onReview?.(rv);
        }
      }
      if (preset && !preset.review) return preset.reply;

      const exists = new Set(outlineRefs(outline));
      const readRefs = result.touched.filter((r) => exists.has(r)).slice(0, REVIEW_READ_MAX);
      const after = readRefs.length ? await callTool('read_blocks', { uris: readRefs }) : '(남은 블록 없음)';
      const report = [
        `편집 결과 보고 (${round}회차). 검토하고 사용자에게 답하거나, 못 미친 곳이 있으면 request_edit로 다시 넘긴다.`,
        `계획한 작업:\n${tasks.map((t) => `- ${t.task.title}`).join('\n')}`,
        `적용 결과:\n${result.messages.join('\n')}`,
        result.failures.length
          ? `적용하지 못한 작업 (다시 써 봐도 안 되어 빼고, 나머지만 반영했다):\n${result.failures.map((f) => `- ${f}`).join('\n')}`
          : '',
        `바뀐 블록의 지금 내용:\n${after}`,
        `지금 문서 개요:\n${outline}`,
      ]
        .filter(Boolean)
        .join('\n\n');
      chatInput = [new HumanMessage(report)];
    }
  } catch (err) {
    if (isRecursionError(err)) return stopped('작업 단계가 너무 많아 멈췄습니다. 요청을 나눠서 다시 시도해 주세요.');
    throw err;
  }
}

/** 작업 단위 하나와 그 단위가 만든 편집 명령 */
interface Piece {
  task: PlannedTask;
  unit: Unit;
  ops: EditOp[];
  /** 계획에서 받은 넣을 위치 (after). 같은 자리에 이어 넣을 때 기준이 된다. */
  anchor?: string;
}

interface RoundInput {
  /** 실행 모델에게 주는 원래 요청 */
  request: string;
  /** write가 보는 대화 */
  conv: Conversation;
  /** 이 요청에서 쓸 수 있는 보관 이미지인지 */
  knownImage: (uri: string) => boolean;
}

/** write가 앞 글로 읽는 최대 글자 수와 블록 수 (섹션 소제목을 만나면 거기까지) */
const WRITE_BEFORE_CHARS = 3000;
const WRITE_BEFORE_BLOCKS = 15;
/** edit이 앞뒤로, write가 뒤로 읽는 블록 수 */
const AROUND_BLOCKS = 2;

/** 실행 모델이 함께 볼 문서 앞뒤 (지금 문서 기준) */
async function docContext(callTool: CallDocTool, outline: string, unit: Unit, kind: 'write' | 'edit'): Promise<DocContext> {
  const order = outlineRefs(outline);
  const types = outlineTypes(outline);
  const chars = new Map(
    outline.split('\n').flatMap((l) => {
      const m = /^(blsee:\/\/block\/\d+) .*? (\d+)자/.exec(l);
      return m ? [[m[1], Number(m[2])] as const] : [];
    }),
  );
  let beforeEnd: number;
  let afterStart: number;
  if (unit.place) {
    const at = order.indexOf(unit.place.after ?? unit.place.before!);
    beforeEnd = unit.place.after ? at + 1 : at;
    afterStart = beforeEnd;
  } else {
    beforeEnd = order.indexOf(unit.blocks[0]);
    afterStart = order.indexOf(unit.blocks[unit.blocks.length - 1]) + 1;
  }
  const titleRef = types.get(order[0]) === 'documentTitle' ? order[0] : undefined;
  const before: string[] = [];
  if (kind === 'edit') {
    before.push(...order.slice(Math.max(titleRef ? 1 : 0, beforeEnd - AROUND_BLOCKS), Math.max(0, beforeEnd)));
  } else {
    let used = 0;
    for (let i = beforeEnd - 1; i >= (titleRef ? 1 : 0); i--) {
      before.unshift(order[i]);
      used += chars.get(order[i]) ?? 0;
      if (types.get(order[i]) === 'sectionTitle' || used >= WRITE_BEFORE_CHARS || before.length >= WRITE_BEFORE_BLOCKS) break;
    }
  }
  const after = order.slice(afterStart, afterStart + AROUND_BLOCKS);
  const read = (uris: string[]) => (uris.length ? callTool('read_blocks', { uris }) : Promise.resolve(''));
  const [beforeText, afterText, title] = await Promise.all([
    read(before),
    read(after),
    titleRef && kind === 'write' ? callTool('read_blocks', { uris: [titleRef], source: true }) : Promise.resolve(''),
  ]);
  const headings =
    kind === 'write'
      ? outline
          .split('\n')
          .filter((l) => /^blsee:\/\/block\/\d+ <소제목/.test(l))
          .join('\n')
      : '';
  return { title: title.replace(/^<title>|<\/title>$/g, ''), headings, before: beforeText, after: afterText };
}

/**
 * 작업 목록을 차례별로 적용한다. 실행 모델이 쓰는 단위는 차례마다 병렬로 부른다.
 * 같은 자리에 넣는 글은 앞 작업이 넣은 글 뒤에 이어 넣고, 그 글을 보고 쓴다.
 * 하나라도 끝내 실패하면 회차 시작 때의 작업본으로 되돌린다 (회차 단위로 전부 적용 또는 전부 취소).
 */
async function executeRound(round: number, tasks: PlannedTask[], input: RoundInput, o: RunAgentOptions): Promise<RoundResult> {
  const { callTool, meter, signal } = o;
  const emit = (t: PlannedTask, state: TaskState, text?: string) => o.onTask?.(round, t.id, state, text);
  const done = new Set<string>();
  const messages: string[] = [];
  const touched = new Set<string>();
  /** 실패를 일으킨 작업 (알 수 있을 때) */
  let culprit: PlannedTask | undefined;
  /** 다시 써 봐도 적용하지 못해 뺀 작업과 그 범위 */
  const failures: string[] = [];
  const failedTasks = new Set<PlannedTask>();
  const failedScope = new Set<string>();
  const fail = (t: PlannedTask, why: string) => {
    if (!failedTasks.has(t)) failures.push(`작업 ${t.index + 1}(${t.task.title}): ${why}`);
    failedTasks.add(t);
    t.scope.forEach((r) => failedScope.add(r));
    emit(t, 'failed', why);
  };

  /** 작업마다 재료는 한 번만 읽는다. */
  const sources = new Map<string, Promise<string>>();
  const sourceText = (t: PlannedTask) => {
    let p = sources.get(t.id);
    if (!p) sources.set(t.id, (p = t.sourceBlocks.length ? callTool('read_blocks', { uris: t.sourceBlocks }) : Promise.resolve('')));
    return p;
  };
  /** 계획의 넣을 위치(after) → 그 자리에 지금까지 마지막으로 넣은 블록 */
  const lastAfter = new Map<string, string>();
  const anchors = new Map<Unit, string>();

  const produce = async (t: PlannedTask, unit: Unit, outline: string, previousError?: string): Promise<EditOp[]> => {
    if (t.spec.llm === 'none') return t.spec.build!(unit, t.task);
    const kind = t.spec.llm;
    const [doc, src, area] = await Promise.all([
      docContext(callTool, outline, unit, kind),
      sourceText(t),
      unit.place ? Promise.resolve(undefined) : callTool('read_blocks', { uris: unit.blocks, source: true }),
    ]);
    const ui = { task: t, unit, doc, area, sourceText: src, request: input.request, previousError };
    let text: string;
    if (kind === 'write') {
      text = unwrapOutput(await writeText(ui, input.conv, meter, signal));
    } else {
      const patches = await editPatches(ui, meter, signal);
      if (!patches.length) return [];
      if (previousError === undefined) {
        text = applyPatches(area ?? '', patches);
      } else {
        // 다시 쓴 뒤에도 맞지 않는 패치는 그것만 건너뛰고 나머지를 반영한다.
        const skipped: string[] = [];
        text = applyPatches(area ?? '', patches, skipped);
        if (skipped.length === patches.length) throw new Error(skipped.join('\n'));
        if (skipped.length) messages.push(`작업 ${t.index + 1}(${t.task.title}): 맞지 않는 패치 ${skipped.length}개를 건너뛰었다. ${skipped.join(' / ')}`);
      }
      if (normalizeSrc(text) === normalizeSrc(area ?? '')) return [];
    }
    const units = kind === 'write' ? dropStrayTitle(parseText(text), area) : parseText(text);
    if (!units.length && unit.place) throw new Error('쓴 글이 비었다.');
    checkUnits(units, { knownImage: input.knownImage, ...(area !== undefined ? { before: area } : {}) });
    return [writeOp(units, unit.place ? { place: unit.place } : { refs: unit.blocks })];
  };

  /** 단위 하나를 채운다. 실행 모델의 결과가 검사·적용에 걸리면 오류를 보여 주고 한 번만 다시 쓴다. */
  const fill = async (t: PlannedTask, unit: Unit, outline: string, previousError?: string): Promise<EditOp[]> => {
    try {
      return await produce(t, unit, outline, previousError);
    } catch (err) {
      if (signal?.aborted || previousError !== undefined || t.spec.llm === 'none') throw err;
      emit(t, 'running', '다시 쓰는 중');
      return fill(t, unit, outline, err instanceof Error ? err.message : String(err));
    }
  };

  await callTool('begin_round', {});
  try {
    for (const plannedWave of planWaves(tasks)) {
      // 앞에서 실패한 작업이 있으면, 같은 블록을 이어서 건드리는 작업과 지우기 작업은 건너뛴다
      // ("새로 쓰기 → 원래 블록 지우기" 짝에서 쓰기만 실패하면 내용이 사라진다).
      const wave = plannedWave.filter((t) => {
        const blocked = failures.length && (t.task.op === 'delete_block' || t.scope.some((r) => failedScope.has(r)));
        if (blocked) {
          failedTasks.add(t);
          t.scope.forEach((r) => failedScope.add(r));
          failures.push(`작업 ${t.index + 1}(${t.task.title}): 앞 작업이 실패해 건너뛰었다.`);
          emit(t, 'cancelled', '앞 작업 실패로 건너뜀');
        }
        return !blocked;
      });
      if (!wave.length) continue;
      wave.forEach((t) => emit(t, 'running'));
      // 같은 자리(after)에 앞 차례가 넣은 글이 있으면 그 뒤에 이어 넣는다.
      for (const t of wave) {
        for (const u of t.units) {
          if (!u.place?.after) continue;
          if (!anchors.has(u)) anchors.set(u, u.place.after);
          const anchor = anchors.get(u)!;
          u.place = { after: lastAfter.get(anchor) ?? anchor };
        }
      }
      const outline = wave.some((t) => t.write) ? await callTool('get_outline', {}) : '';
      // 다시 써 봐도 안 되는 단위는 빼고, 나머지만 반영한다.
      const settled = await Promise.allSettled(
        wave.flatMap((task) => task.units.map((unit) => fill(task, unit, outline).then((ops) => ({ task, unit, ops, anchor: anchors.get(unit) }) as Piece))),
      );
      const flat = wave.flatMap((task) => task.units.map((unit) => ({ task, unit })));
      let pieces: Piece[] = [];
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') pieces.push(r.value);
        else {
          if (signal?.aborted) throw r.reason;
          fail(flat[i].task, r.reason instanceof Error ? r.reason.message : String(r.reason));
        }
      });
      /** 묶음 안 명령 순서로 그 명령을 만든 단위를 찾는다. */
      const ownerOf = (result: string) => {
        let i = failedIndex(result);
        if (i === undefined) return undefined;
        for (const p of pieces) {
          if (i < p.ops.length) return p;
          i -= p.ops.length;
        }
      };
      const apply = () => callTool('edit_document', { operations: pieces.flatMap((p) => p.ops) });

      let lines: string[] = [];
      const retried = new Set<Piece>();
      while (pieces.some((p) => p.ops.length)) {
        const res = await apply();
        if (!res.startsWith('실패:')) {
          lines = res.split('\n').slice(1);
          break;
        }
        const failed = ownerOf(res);
        // 어느 단위인지 모르면 (확장 쪽 오류 등) 지금처럼 회차를 되돌린다.
        if (!failed) throw new Error(stripFail(res));
        if (failed.task.write && !retried.has(failed)) {
          // 실행 모델이 쓴 단위면 오류를 보여 주고 그 단위만 한 번 다시 쓴다.
          retried.add(failed);
          emit(failed.task, 'running', '다시 쓰는 중');
          try {
            failed.ops = await produce(failed.task, failed.unit, outline, stripFail(res));
            continue;
          } catch (err) {
            if (signal?.aborted) throw err;
          }
        }
        fail(failed.task, stripFail(res));
        pieces = pieces.filter((p) => p !== failed);
      }
      messages.push(...lines);
      // 넣은 블록을 위치별로 기억한다 (명령 하나에 결과 한 줄).
      let at = 0;
      for (const p of pieces) {
        const own = lines.slice(at, at + p.ops.length);
        at += p.ops.length;
        if (!p.anchor) continue;
        for (const line of own) {
          const last = lastInserted(line);
          if (last) lastAfter.set(p.anchor, last);
        }
      }
      for (const t of wave) {
        if (failedTasks.has(t)) continue;
        done.add(t.id);
        emit(t, 'done');
        t.scope.forEach((r) => touched.add(r));
      }
      for (const line of lines) for (const m of line.matchAll(/blsee:\/\/block\/\d+/g)) touched.add(m[0]);
    }
    // 하나도 반영하지 못했으면 실패로 돌려 다시 계획하게 한다.
    if (failures.length && !done.size) {
      await callTool('rollback_round', {}).catch(() => '');
      return { ok: false, error: failures.join('\n') };
    }
    return { ok: true, messages, touched: [...touched], failures, failedReviews: [...failedTasks].flatMap((t) => t.task.reviews ?? []) };
  } catch (err) {
    if (signal?.aborted) throw err;
    await callTool('rollback_round', {}).catch(() => '');
    const message = err instanceof Error ? err.message : String(err);
    for (const t of tasks) {
      if (t === culprit) emit(t, 'failed', message);
      else emit(t, 'cancelled', done.has(t.id) ? '되돌림' : undefined);
    }
    const error = culprit ? `작업 ${culprit.index + 1}(${culprit.task.title}): ${message}` : message;
    return { ok: false, error };
  }
}

/**
 * 계획 담당에게 주는 [Instruction]: 대화 담당이 넘긴 편집 지시.
 * 두 번째 회차부터는 앞 회차에 한 작업과 지금 문서 개요를 함께 적는다.
 */
function instructionText(edit: string, prior?: { applied: string[]; outline: string }): string {
  if (!prior) return `[Instruction]\n${edit}`;
  const done = prior.applied.length ? prior.applied.map((a) => `- ${a}`).join('\n') : '- (없음)';
  return `[Instruction]\n앞 회차에 한 작업 (문서에 적용되어 남아 있다):\n${done}\n\n할 작업:\n${edit}\n\n지금 문서 개요:\n${prior.outline}`;
}

/** 이번 요청 메시지 뒤에 [Instruction] 메시지들을 이어 붙여 사용자 메시지 하나로 만든다. */
function withInstruction(current: HumanMessage, input: BaseMessage[]): HumanMessage {
  const extra = input.map((m) => m.text).join('\n\n');
  return new HumanMessage(`${current.text}\n\n${extra}`);
}

/**
 * 고칠 글이 정해진 점검 항목을 edit 작업으로. 문서에서 이어진 블록끼리 한 작업으로 묶고,
 * 지시에는 "원래 글 → 고칠 글"을 그대로 적는다. 실행 모델이 영역을 보고 패치로 고친다 (여러 문단·줄 나누기도 된다).
 * 사진 URI(blsee://block/N/image)를 가리킨 항목(캡션)은 그 블록을 대상으로 한다.
 */
function reviewEditTasks(items: ReviewItem[], outline: string): Task[] {
  const order = outlineRefs(outline);
  const blockOf = (uri: string) => /^blsee:\/\/block\/\d+/.exec(uri)?.[0] ?? '';
  const byBlock = new Map<string, ReviewItem[]>();
  for (const it of items) {
    const b = blockOf(it.uri);
    if (!order.includes(b)) continue;
    byBlock.set(b, [...(byBlock.get(b) ?? []), it]);
  }
  const blocks = [...byBlock.keys()].sort((x, y) => order.indexOf(x) - order.indexOf(y));
  const runs: string[][] = [];
  for (const b of blocks) {
    const last = runs.at(-1);
    if (last && order.indexOf(last[last.length - 1]) + 1 === order.indexOf(b)) last.push(b);
    else runs.push([b]);
  }
  return runs.map((run) => {
    const its = run.flatMap((b) => byBlock.get(b)!);
    const lines = its.map((it) => `- ${blockOf(it.uri)}: ${JSON.stringify(it.original)} → ${JSON.stringify(it.suggestion)} (${it.reason})`);
    return {
      title: `점검 결과 ${its.length}곳 고치기`,
      op: 'edit' as const,
      target: { uris: run },
      instruction: `점검에서 찾은 곳을 아래대로 고친다. 원래 글은 블록에 보이는 글이니 영역에서 그 부분을 찾아 고칠 글로 바꾸고, 나머지는 그대로 둔다.\n${lines.join('\n')}`,
      reviews: its.map((it) => it.id),
    };
  });
}
