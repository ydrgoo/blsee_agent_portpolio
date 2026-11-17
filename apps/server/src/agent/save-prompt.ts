/**
 * 프롬프트 저장 경로. 계획·편집·검토에 들어가지 않는다.
 *
 *   /make-prompt:  ① 프롬프트 생성(에이전트) → ② 칸 추출 → ③ 확인 → 저장
 *   /save-prompt:                            ② 칸 추출 → ③ 확인 → 저장
 *
 * ② 칸 추출은 원문을 다시 쓰지 않는다. 모델은 칸마다 "원래 글 → 바꾼 글"(값 자리만 {{칸}})을 내고,
 *    서버가 원문에서 그 자리만 바꾼다. 값 자리 밖의 글을 바꾸는 패치는 버린다 (내용 손실 없음).
 * ③ 확인 카드: 확인이면 저장, 의견을 적으면 반영해 다시 만든다(만들기는 ①부터, 저장은 ②부터), 거절이면 저장하지 않는다.
 */
import { MemorySaver } from '@langchain/langgraph';
import { createAgent, HumanMessage } from 'langchain';
import { z } from 'zod';
import {
  ASK_DONT_ASK_PROMPT_SAVE,
  PROMPT_MAKE_COMMAND,
  PROMPT_SAVE_COMMAND,
  RESERVED_PROMPT_COMMANDS,
  askNoteSchema,
  commandNameOf,
  paramNameOf,
  type AskAnswer,
  type AskRequest,
  type ChatTurn,
  type DocToolName,
  type PromptCreate,
  type PromptParam,
  type PromptScope,
  type RefItem,
  type TurnMeta,
  type TurnPoint,
} from '@blog-helper/shared';
import { chatModel, config } from '../config';
import { usageCallback, type UsageMeter } from '../usage';
import { applyPatches } from './blsee';
import { historyMessages, userContent } from './messages';
import { PROMPT_EXTRACT_PROMPT, PROMPT_MAKE_PROMPT, PROMPT_NORMALIZE_PROMPT } from './prompt';
import { agentThread } from './thread';
import { askNoteText, createSharedTools, type NotifyStep } from './tools';

/** 확인 카드에서 의견을 받아 다시 만드는 횟수 상한 */
const REDO_MAX = 2;
/** 생성 에이전트에게 주는 도구 (읽고 보고 묻기만) */
const MAKE_TOOLS = new Set(['read', 'get_outline', 'find_text', 'view', 'ask_user']);

/** normalize: 부를 때마다 바꿀 값을 {{칸}}으로 바꿀 자리 */
export const normalizeSchema = z.object({
  fetches: z
    .array(
      z.object({
        name: z.string().min(1).describe('칸 이름. 소문자 영문과 -만 쓴 짧은 이름 (예: character-name). 본문에는 {{칸이름}}으로 들어간다. 같은 값이 여러 곳이면 같은 이름을 쓴다'),
        anchor: z
          .string()
          .default('')
          .describe('칸이 들어갈 자리를 가리키는 원문 조각. 원문에서 그대로 옮긴 한 줄 안의 짧은 글(40자 안팎)로, 원문에서 한 곳에만 맞는다. 원문에 이미 {{칸이름}}이 있으면 비운다'),
        value: z
          .string()
          .default('')
          .describe('anchor 안에서 {{칸이름}}으로 바꿀 값. 값이 비어 있는 자리(예: "캐릭터 이름:")면 비우고, 그러면 anchor 뒤에 칸을 붙인다'),
      }),
    )
    .default([])
    .describe('부를 때마다 바꿔 채울 칸. 최소한으로'),
});

/** extract: 정리된 프롬프트의 이름·설명·칸 설명 */
const extractSchema = z.object({
  name: z.string().default('').describe('슬래시로 부를 이름. 소문자 영문, 숫자, -만 (예: doodle-sheet)'),
  title: z.string().default('').describe('목록에 보일 짧은 한글 이름 (예: 낙서풍 캐릭터 시트)'),
  description: z.string().default('').describe('무엇을 하는 프롬프트인지 한 줄 한글 설명'),
  params: z
    .array(z.object({ name: z.string().describe('칸 이름 (주어진 그대로)'), description: z.string().describe('그 칸에 무엇을 적는지 짧은 한글 안내') }))
    .default([])
    .describe('주어진 칸마다 하나'),
});

export interface SavePromptInput {
  history: ChatTurn[];
  turnMeta: Record<string, TurnMeta>;
  message: string;
  time?: string;
  attached?: string[];
  pointed?: TurnPoint[];
  refs?: RefItem[];
  library: boolean;
  promptCreate?: PromptCreate;
  callTool: (name: DocToolName, args: Record<string, unknown>) => Promise<string>;
  ask: (req: AskRequest) => Promise<AskAnswer>;
  notify?: NotifyStep;
  meter: UsageMeter;
  signal: AbortSignal;
}

const NEED_WORKSPACE = '프롬프트를 저장하려면 작업공간 폴더가 필요합니다.';

const startsWithCommand = (text: string, command: string) => text === `/${command}` || text.startsWith(`/${command} `) || text.startsWith(`/${command}\n`);

/** 프롬프트 만들기·저장 요청인지 (메시지가 /make-prompt 또는 /save-prompt로 시작) */
export function isPromptCreate(message: string): boolean {
  const text = message.trim();
  return startsWithCommand(text, PROMPT_MAKE_COMMAND) || startsWithCommand(text, PROMPT_SAVE_COMMAND);
}

function createOf(input: SavePromptInput): Required<PromptCreate> {
  const p = input.promptCreate;
  if (p && (p.scope === 'post' || p.scope === 'all')) {
    const mode = p.mode ?? 'make';
    return { instruction: p.instruction ?? '', scope: p.scope, mode, request: mode === 'make' ? (p.instruction ?? '') : (p.request ?? '') };
  }
  const text = input.message.trim();
  const mode = startsWithCommand(text, PROMPT_SAVE_COMMAND) ? 'save' : 'make';
  const command = mode === 'save' ? PROMPT_SAVE_COMMAND : PROMPT_MAKE_COMMAND;
  const instruction = text.slice(command.length + 1).trim();
  return { instruction, scope: 'post', mode, request: mode === 'make' ? instruction : '' };
}

/* ---------- ① 프롬프트 생성 ---------- */

async function makeBody(input: SavePromptInput, instruction: string, note: string | undefined): Promise<string> {
  const tools = createSharedTools(input.callTool, input.meter, input.notify ?? (() => {}), input.library).filter((t) =>
    MAKE_TOOLS.has(t.name),
  );
  const agent = createAgent({ model: chatModel('prompt-make'), tools, checkpointer: new MemorySaver(), systemPrompt: PROMPT_MAKE_PROMPT });
  const send = agentThread(agent, {
    ask: input.ask,
    signal: input.signal,
    callbacks: [usageCallback(input.meter, config['prompt-make'].model, 'chat')],
  });
  const now = userContent(
    [`[요청사항]\n${instruction.trim() || '(없음. 대화만 보고 쓴다)'}`, note ? `[고칠 점] 앞서 만든 프롬프트에 사용자가 남긴 의견: ${note}` : ''].filter(Boolean).join('\n\n'),
    {
      time: input.time,
      ...(input.pointed?.length ? { pointed: input.pointed } : {}),
      ...(input.refs?.length ? { refs: input.refs } : {}),
      ...(input.attached?.length ? { attached: input.attached } : {}),
    },
  );
  const history = historyMessages(input.history.filter((t) => !(t.role === 'user' && isPromptCreate(t.text))), input.turnMeta);
  const result = await send([...history, new HumanMessage(now)]);
  return (result.messages.at(-1)?.text ?? '').replace(/^```(?:markdown|md|text)?\n([\s\S]*?)\n```$/i, '$1').trim();
}

/* ---------- ② 칸 추출 ---------- */

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * 칸 하나를 원문에 넣는다. anchor가 원문에서 한 곳에만 맞아야 하고, value가 있으면 anchor 안의 그 값만 {{칸}}으로 바꾼다.
 * value가 비면 anchor 뒤에 칸을 붙인다. 칸 밖의 글은 바뀌지 않는다. 넣지 못하면 까닭을 돌려준다.
 */
export function fillSlot(body: string, name: string, anchor: string, value: string): { body: string } | { error: string } {
  const slot = `{{${name}}}`;
  if (!anchor) return { error: `${name}: 자리를 가리키는 원문 조각이 없다` };
  let at = body.indexOf(anchor);
  const count = body.split(anchor).length - 1;
  if (count > 1 && !value) {
    // 값이 빈 자리는 줄 끝에 있다: 조각 뒤가 줄 끝인 곳이 하나면 그곳이다.
    const ends: number[] = [];
    for (let i = body.indexOf(anchor); i >= 0; i = body.indexOf(anchor, i + 1)) {
      if (/^[ \t]*(\n|$)/.test(body.slice(i + anchor.length))) ends.push(i);
    }
    if (ends.length === 1) at = ends[0];
    else return { error: `${name}: "${anchor.slice(0, 40)}"이 원문에 ${count}곳에 있다. 앞 글자를 더 넣어 한 곳에만 맞게 고른다` };
  } else if (count !== 1) {
    return { error: `${name}: "${anchor.slice(0, 40)}"이 원문에 ${count ? `${count}곳에 있다. 앞뒤 글자를 더 넣어 한 곳에만 맞게 고른다` : '없다. 원문 글자를 그대로 옮긴다'}` };
  }
  let filled: string;
  if (value) {
    if (anchor.split(value).length - 1 !== 1) return { error: `${name}: 값 "${value.slice(0, 40)}"이 조각 안에 한 번만 있어야 한다` };
    filled = anchor.replace(value, () => slot);
  } else {
    filled = `${anchor}${/\s$/.test(anchor) ? '' : ' '}${slot}`;
  }
  return { body: body.slice(0, at) + filled + body.slice(at + anchor.length) };
}

type Fetch = z.infer<typeof normalizeSchema>['fetches'][number];

/** 원문에 칸을 넣는다. 넣지 못한 칸은 빼고, 그 까닭을 errors에 모은다. */
export function applySlots(body: string, params: Fetch[], errors: string[] = []): { body: string; params: PromptParam[] } {
  let out = body;
  const kept: PromptParam[] = [];
  const seen = new Set<string>();
  for (const p of params) {
    const name = paramNameOf(p.name);
    if (!name) continue;
    // 같은 이름이 여러 곳이면 자리마다 넣고, 칸은 하나로 둔다.
    if (seen.has(name) && !p.anchor) continue;
    if (!out.includes(`{{${name}}}`) || (seen.has(name) && p.anchor)) {
      const r = fillSlot(out, name, p.anchor ?? '', p.value ?? '');
      if ('error' in r) {
        errors.push(r.error);
        continue;
      }
      out = r.body;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    kept.push({ name });
  }
  // 원문에 사용자가 직접 적은 {{칸}}도 칸으로 둔다.
  for (const m of out.matchAll(PLACEHOLDER)) {
    const name = m[1].trim();
    if (seen.has(name)) continue;
    seen.add(name);
    kept.push({ name });
  }
  return { body: out, params: kept };
}

const NORMALIZE_TRIES = 2;

/** normalize: 부를 때마다 바꿀 값을 {{칸}}으로 바꾼다. 원문은 칸 자리 밖에서 바뀌지 않는다. */
/** 정리·추출 담당에게 주는 범위와 요청사항 */
interface Direction {
  scope: PromptScope;
  request: string;
  note?: string;
}

function directionText(d: Direction): string {
  return [
    `[범위] ${d.scope === 'all' ? '모든 글 — 어느 글에서나 부른다' : '이 글 — 이 글에서만 다시 부른다'}`,
    d.request ? `[요청사항] ${d.request}` : '',
    d.note ? `[고칠 점] 사용자 의견: ${d.note}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function normalizePrompt(input: SavePromptInput, body: string, dir: Direction) {
  const model = chatModel('prompt-normalize').withStructuredOutput(normalizeSchema);
  let retry = '';
  let slots: ReturnType<typeof applySlots> | undefined;
  for (let i = 0; i < NORMALIZE_TRIES; i++) {
    let out: z.infer<typeof normalizeSchema>;
    try {
      out = (await model.invoke(
        [
          { role: 'system', content: PROMPT_NORMALIZE_PROMPT },
          {
            role: 'user',
            content: [`[프롬프트 원문]\n${body}`, directionText(dir), retry].filter(Boolean).join('\n\n'),
          },
        ],
        { signal: input.signal, callbacks: [usageCallback(input.meter, config['prompt-normalize'].model, 'chat')] },
      )) as z.infer<typeof normalizeSchema>;
    } catch (err) {
      if (input.signal.aborted) throw err;
      console.warn('[prompt-normalize] 출력 오류', err instanceof Error ? err.message.slice(0, 200) : err);
      retry = '[다시] 지난 출력을 읽지 못했다. anchor는 원문에서 옮긴 짧은 조각 하나만 쓴다.';
      continue;
    }
    console.log(`[prompt-normalize] ${i + 1}회 출력 ${JSON.stringify(out).slice(0, 1500)}`);
    const errors: string[] = [];
    slots = applySlots(body, out.fetches ?? [], errors);
    console.log(`[prompt-normalize] 넣은 칸: ${slots.params.map((p) => p.name).join(', ') || '없음'}`);
    if (!errors.length) break;
    console.warn('[prompt-normalize] 넣지 못한 칸', errors);
    retry = `[다시] 넣지 못한 칸이 있다. anchor를 원문에서 글자 그대로, 한 곳에만 맞게 고른다:\n${errors.map((e) => `- ${e}`).join('\n')}`;
  }
  if (!slots) throw new Error('프롬프트를 정리하지 못했다');
  return slots;
}

/** extract: 정리된 프롬프트에서 이름·설명·칸 설명을 뽑는다. 실패하면 기본값으로 둔다. */
async function extractInfo(input: SavePromptInput, slots: { body: string; params: PromptParam[] }, dir: Direction) {
  let out: z.infer<typeof extractSchema> = { name: '', title: '', description: '', params: [] };
  try {
    out = (await chatModel('prompt-extract')
      .withStructuredOutput(extractSchema)
      .invoke(
        [
          { role: 'system', content: PROMPT_EXTRACT_PROMPT },
          {
            role: 'user',
            content: [
              `[프롬프트]\n${slots.body}`,
              `[칸] ${slots.params.map((p) => p.name).join(', ') || '없음'}`,
              directionText(dir),
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
        ],
        { signal: input.signal, callbacks: [usageCallback(input.meter, config['prompt-extract'].model, 'chat')] },
      )) as z.infer<typeof extractSchema>;
    console.log(`[prompt-extract] 출력 ${JSON.stringify(out).slice(0, 800)}`);
  } catch (err) {
    if (input.signal.aborted) throw err;
    console.warn('[prompt-extract] 실패', err instanceof Error ? err.message.slice(0, 200) : err);
  }
  const notes = new Map((out.params ?? []).map((p) => [p.name.trim(), p.description.trim()]));
  const command = commandNameOf(out.name ?? '');
  return {
    failed: false,
    name: out.title?.trim() || out.description?.trim() || '새 프롬프트',
    description: out.description?.trim() ?? '',
    command: command && !RESERVED_PROMPT_COMMANDS.includes(command) ? command : 'prompt',
    body: slots.body,
    params: slots.params.map((p) => (notes.get(p.name) ? { ...p, description: notes.get(p.name) } : p)),
  };
}

/* ---------- ③ 확인 ---------- */

type Draft = Awaited<ReturnType<typeof extractInfo>>;

function confirmQuestion(d: Draft, mode: 'make' | 'save', scope: PromptScope): string {
  const params = d.params.length
    ? d.params.map((p) => `- \`${p.name}\`${p.description ? ` — ${p.description}` : ''}`).join('\n')
    : '- 없음';
  return [
    mode === 'make' ? '프롬프트를 이렇게 만들었어요. 저장할까요?' : '프롬프트를 이렇게 저장할까요?',
    `**${d.name}**${d.description ? `\n${d.description}` : ''}\n\`/${d.command}\` · ${scope === 'all' ? '모든 글' : '이 글에서만'}`,
    `칸 ${d.params.length}개\n${params}${d.failed ? '\n(칸을 뽑지 못했어요. 고칠 점을 적으면 다시 해 볼게요.)' : ''}`,
    `최종 프롬프트 (${d.body.length.toLocaleString('ko-KR')}자)\n\`\`\`\n${d.body}\n\`\`\``,
    '확인을 누르면 저장하고, 고칠 점을 적으면 반영해 다시 만들어요. 거절하면 저장하지 않아요.',
  ].join('\n\n');
}

/**
 * 프롬프트를 만들거나 받아 칸을 뽑고, 확인을 받아 저장한다. 채팅에 남길 짧은 답을 돌려준다.
 * 작업공간이 없거나 저장에 실패하면 그 이유를 답으로 돌려준다.
 */
export async function createSavedPrompt(input: SavePromptInput): Promise<string> {
  if (!input.library) return NEED_WORKSPACE;
  const { instruction, scope, mode, request } = createOf(input);
  if (mode === 'save' && !instruction.trim()) return `저장할 프롬프트 원문을 /${PROMPT_SAVE_COMMAND} 뒤에 붙여 주세요.`;

  let note: string | undefined;
  let body = mode === 'save' ? instruction.trim() : '';
  let draft: Draft | undefined;
  for (let round = 0; round <= REDO_MAX; round++) {
    if (mode === 'make' && (round === 0 || note)) {
      input.notify?.(true, '프롬프트 쓰는 중');
      body = (await makeBody(input, instruction, note)) || body;
      if (!body) return '프롬프트를 만들지 못했습니다. 대화를 조금 더 나눈 뒤 다시 시도해 주세요.';
    }
    console.log(`[prompt-save] ${mode} ${round + 1}회 · 범위 ${scope} · 원문 ${body.length}자${request ? ` · 요청: ${request.slice(0, 100)}` : ''}${note ? ` · 의견: ${note}` : ''}`);
    input.notify?.(true, '프롬프트 정리 중');
    try {
      const dir: Direction = { scope, request, note };
      const slots = await normalizePrompt(input, body, dir);
      input.notify?.(true, '이름·설명 정하는 중');
      draft = await extractInfo(input, slots, dir);
    } catch (err) {
      if (input.signal.aborted) throw err;
      console.warn('[prompt-normalize] 실패', err instanceof Error ? err.message : err);
      // 칸을 뽑지 못해도 원문은 저장할 수 있게 한다. 확인 카드에 그 사실을 적는다.
      draft = { name: draft?.name ?? '새 프롬프트', description: draft?.description ?? '', command: draft?.command ?? 'prompt', ...applySlots(body, []), failed: true };
    }
    const answer = await input.ask({
      question: confirmQuestion(draft, mode, scope),
      requestedSchema: askNoteSchema('고칠 점'),
      dontAskKey: ASK_DONT_ASK_PROMPT_SAVE,
    });
    if (answer.action === 'cancel' || answer.action === 'decline') return '프롬프트를 저장하지 않았습니다.';
    note = askNoteText(answer) || undefined;
    if (!note) break;
    if (round === REDO_MAX) break;
  }
  if (!draft) return '프롬프트를 저장하지 못했습니다.';

  const saved = await input.callTool('store_prompt', {
    name: draft.name,
    command: draft.command,
    description: draft.description,
    scope: scope satisfies PromptScope,
    body: draft.body,
    params: draft.params,
  });
  const savedCommand = saved.trim();
  if (!savedCommand || savedCommand.startsWith('저장 안 함') || savedCommand.startsWith('실패')) {
    return savedCommand || '프롬프트를 저장하지 못했습니다.';
  }
  return `프롬프트를 저장했습니다. /${savedCommand}`;
}
