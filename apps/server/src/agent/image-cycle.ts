import { createAgent, HumanMessage, SystemMessage, toolStrategy, type BaseMessage } from 'langchain';
import { TOOL_AS_TEXT_FIX, wroteToolAsText } from './tool-text';
import { z } from 'zod';
import type { AskAnswer, AskRequest } from '@blog-helper/shared';
import { chatModel, config } from '../config';
import { keyCheckOff } from '../keys';
import { PIXEL_KINDS } from '../image';
import { usageCallback, type UsageMeter } from '../usage';
import { IMAGE_JUDGE_PROMPT, IMAGE_SPEC_PROMPT } from './prompt';
import { seedMessage, uniqueRefs } from './seed-input';
import {
  MADE,
  REFS_MAX,
  applyPixelSpec,
  cachedImageCall,
  confirmPixelSpec,
  createImageSupportTools,
  repeatsIssues,
  reviewWithUser,
  toImageUri,
  type CallDocTool,
  type FoundImages,
  type NotifyStep,
  type PixelRef,
  type PixelSpec,
} from './tools';

const MAKE_RECURSION = 16;
const JUDGE_MAX_FULL = 3;
const JUDGE_MAX_INFO = 1;
/** 사용자가 고칠 점을 적어 상한을 넘겨 더 고치는 횟수 */
const USER_ROUNDS_MAX = 2;
const LABEL_CHARS = 30;

/** 시드 메타. 대화 원문은 도구 경계의 구체화가 지시로 옮긴 뒤라 여기 없다. */
export interface ImageSeedInfo {
  /** 가리킨 사진·일러스트 (blsee://lib/images/…). 인포그래픽 파일은 넣지 않는다. */
  pointed?: string[];
  attached?: string[];
}

export interface ImageSeedArgs {
  instructions: string[];
  /** 사용자가 직접 적은 지시 원문 (구체화가 고른 메시지). 명세·판정이 함께 본다 */
  requests?: string[];
  context: string;
  /** 고칠 이미지 URI (없으면 새로 그린다) */
  original?: string;
  refs?: { uri: string; role: string }[];
  /** 보관할 이미지 이름 (모델 입력에는 넣지 않는다) */
  name?: string;
}

export interface ImageCycleDeps {
  call: CallDocTool;
  meter: UsageMeter;
  locale: string;
  notify: NotifyStep;
  ask: (req: AskRequest) => Promise<AskAnswer>;
  signal?: AbortSignal;
  /** 인포 배경: 글자 금지 + judge 1회 */
  noExtraText?: boolean;
  judgeMax?: number;
}

const pixelRefSchema = z.object({
  uri: z.string().min(1).describe('참조 이미지 URI 또는 search_images의 웹 id ([Original]은 넣지 않는다)'),
  role: z.string().min(1).describe('이 이미지를 참조하는 까닭 (예: "캐릭터 생김새", "장소 생김새")'),
});

const pixelItemSchema = z.object({
  kind: z
    .enum(PIXEL_KINDS)
    .describe('칸: 인물(사람·캐릭터의 생김새·동작·표정) / 사물(물건·동물·음식) / 배경(장소·시간·날씨) / 구도(시점·배치·비율) / 화풍(그림체·톤·색감) / 글자(그림에 넣을 글자 그대로) / 뺄 것(넣지 말 것)'),
  instruction: z.string().min(1).describe('이 칸의 지시 한 문장 ("~한다"로 끝낸다). 고칠 때는 무엇을 어떻게 바꿀지 쓴다'),
  ref: z.string().optional().describe('이 칸이 생김새를 따를 참조 이미지 URI 또는 웹 id'),
});

const pixelSpecSchema = z.object({
  mode: z
    .enum(['generate', 'edit'])
    .describe('generate: 새로 그린다 ([Original]이 있으면 그 대상을 살려 새로 그린다) / edit: [Original]의 구도를 유지한 채 지시한 곳만 바꾼다'),
  items: z
    .array(pixelItemSchema)
    .min(1)
    .describe('지시사항. 칸마다 한 문장씩 나누고, 내용이 없는 칸과 넣지 말라고 한 글자 칸은 두지 않는다'),
  refs: z.array(pixelRefSchema).max(REFS_MAX).optional().describe('참조: [Original] 밖에 쓸 이미지와 역할'),
});

const imageJudgeSchema = z.object({
  checks: z
    .array(z.string())
    .describe('지시 항목마다 [Result]에서 "보임", "안 보임", "다름" 가운데 하나와 근거 한 줄. [Original]이 있으면 바뀌어야 할 곳이 바뀌었는지, [References]가 있으면 생김새가 맞는지도 적는다'),
  action: z
    .enum(['done', 'edit', 'make', 'ask'])
    .describe(
      'done: 작업이 다 되었고 어색한 곳이 없다 / ask: 어색하거나 부족한 곳이 있지만 크지 않다 (사용자에게 이대로 쓸지 묻는다) / ' +
        'edit: 요청이 제대로 반영되지 않아 더 반영해야 한다 / make: 요청과 완전히 다른 것이 나왔다',
    ),
  issues: z.array(z.string()).describe('done이 아니면 어색하거나 부족한 곳, 더 반영할 점 1~3개를 구체적으로 (done이면 빈 목록)'),
  message: z.string().describe('호출 측에 전할 말. ask면 사용자에게 보일 남은 문제를 짧게'),
});

const clip = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > LABEL_CHARS ? `${t.slice(0, LABEL_CHARS)}…` : t;
};

function log(tag: string, detail: string) {
  if (keyCheckOff()) console.log(`[image-cycle] ${tag}\n${detail}`);
}

/** 이번 회차의 원본과 참조 */
interface RoundImages {
  /** 고칠 이미지 (처음 원본, 고치는 회차면 이전 결과) */
  original?: string;
  /** 원본 밖 참조 */
  references: { uri: string; role: string }[];
  issues?: string[];
}

/** 명세 모델 입력: [이미지] 지시 → [Original] → [Context] → [References] (원본·참조 픽셀 포함) */
export function buildImageSeed(call: CallDocTool, args: ImageSeedArgs, round: RoundImages) {
  return seedMessage(call, {
    head: '이미지',
    instructions: args.instructions,
    requests: args.requests,
    issues: round.issues,
    original: round.original ? { uri: round.original } : undefined,
    context: [args.context],
    references: round.references,
  });
}

/** 도구 인자의 원본·참조에, 가리킨·첨부 이미지를 참조로 더한다. */
function seedImages(args: ImageSeedArgs, info: ImageSeedInfo): RoundImages {
  // 원본을 refs의 "고칠 원본"으로 넘긴 호출도 원본으로 본다.
  const original = args.original ?? args.refs?.find((r) => /원본/.test(r.role))?.uri;
  return {
    original,
    references: uniqueRefs(
      [
        ...(args.refs ?? []),
        ...(info.pointed ?? []).map((uri) => ({ uri, role: '가리킨 이미지' })),
        ...(info.attached ?? []).map((uri) => ({ uri, role: '첨부한 이미지' })),
      ],
      original,
    ),
  };
}

async function writePixelSpec(
  d: ImageCycleDeps,
  found: FoundImages,
  made: string[],
  messages: BaseMessage[],
  systemPrompt: string,
  hasOriginal: boolean,
): Promise<PixelSpec> {
  const tools = createImageSupportTools({
    call: d.call,
    meter: d.meter,
    notify: d.notify,
    found,
    made,
  });
  const toolNames = tools.map((t) => t.name);
  const agent = createAgent({
    model: chatModel('image-instruction'),
    tools,
    responseFormat: toolStrategy(pixelSpecSchema),
    systemPrompt,
  });
  const invoke = (input: BaseMessage[]) =>
    agent.invoke(
      { messages: input },
      {
        recursionLimit: MAKE_RECURSION,
        signal: d.signal,
        callbacks: [usageCallback(d.meter, config['image-instruction'].model, 'image_agent')],
      },
    );
  let result = await invoke(messages);
  // 도구를 글로 쓰거나 명세를 내지 않았으면 이어서 한 번 다시 시킨다.
  if (!result.structuredResponse || wroteToolAsText(result.messages, toolNames)) {
    result = await invoke([...result.messages, new HumanMessage(`${TOOL_AS_TEXT_FIX} 명세는 출력 형식으로 낸다.`)]);
  }
  const out = result.structuredResponse as PixelSpec | undefined;
  if (!out?.items?.length) throw new Error('이미지 명세를 내지 못했다.');
  // 원본이 없으면 고칠 바탕이 없으니 새로 그린다.
  if (out.mode === 'edit' && !hasOriginal) out.mode = 'generate';
  log('spec', JSON.stringify(out).slice(0, 800));
  return out;
}

/** make_image(또는 request_pixel)가 넘긴 refs는 명세에 없어도 픽셀 참조로 붙인다. */
function withSeedRefs(spec: PixelSpec, seedRefs: PixelRef[], original?: string): PixelSpec {
  if (!seedRefs.length) return { ...spec, refs: uniqueRefs(spec.refs ?? [], original) };
  const must = seedRefs.map((r) => ({ uri: toImageUri(r.uri), role: r.role }));
  const refs = uniqueRefs([...must, ...(spec.refs ?? [])], original);
  return { ...spec, refs: refs.slice(0, Math.max(REFS_MAX, must.length)) };
}

async function runPixel(
  d: ImageCycleDeps,
  found: FoundImages,
  made: string[],
  spec: PixelSpec,
  o: { original?: string; name?: string },
): Promise<string> {
  const confirmed = await confirmPixelSpec(d.ask, spec, o);
  if (!confirmed.ok) {
    throw new Error(`사용자가 이미지 ${spec.mode === 'edit' ? '수정' : '생성'}을 거절했다.${confirmed.note ? ` 의견: ${confirmed.note}` : ''}`);
  }
  d.notify(true, spec.mode === 'edit' ? '이미지 고치는 중' : '이미지 그리는 중');
  const uri = await applyPixelSpec({
    call: d.call,
    meter: d.meter,
    locale: d.locale,
    spec: confirmed.spec,
    original: o.original,
    name: o.name,
    noExtraText: d.noExtraText,
    found,
  });
  made.push(uri);
  return uri;
}

/**
 * 판정: 지시, 원본(있으면), 결과, 참조를 한 번에 보고 정한다.
 * 원본·결과는 원래 크기, 참조는 줄여서 이미지로 넣는다.
 */
async function judgeImage(
  d: ImageCycleDeps,
  args: ImageSeedArgs,
  first: RoundImages,
  uri: string,
  issuesPrev: string[],
): Promise<z.infer<typeof imageJudgeSchema>> {
  const input = await seedMessage(d.call, {
    head: '이미지',
    instructions: args.instructions,
    requests: args.requests,
    issues: issuesPrev,
    issuesLabel: '앞서 지적 (고쳐졌는지 확인한다)',
    original: first.original ? { uri: first.original } : undefined,
    result: { uri },
    context: [args.context],
    references: first.references,
  });
  const model = chatModel('image-judge').withStructuredOutput(imageJudgeSchema);
  const out = (await model.invoke([new SystemMessage(IMAGE_JUDGE_PROMPT), input.message], {
    signal: d.signal,
    callbacks: [usageCallback(d.meter, config['image-judge'].model, 'image_agent')],
  })) as z.infer<typeof imageJudgeSchema>;
  log('judge', JSON.stringify(out));
  return out;
}

/**
 * make → pixel → judge → edit|make 사이클.
 */
export async function runImageCycle(
  d: ImageCycleDeps,
  seed: { args: ImageSeedArgs; info: ImageSeedInfo },
  label?: string,
): Promise<{ uri?: string; message: string }> {
  d = { ...d, call: cachedImageCall(d.call) };
  const title = label ?? `이미지 · ${clip(seed.args.name || seed.args.instructions[0] || '')}`;
  const found: FoundImages = new Map();
  const made: string[] = [];
  const judgeMax = d.judgeMax ?? (d.noExtraText ? JUDGE_MAX_INFO : JUDGE_MAX_FULL);
  let mode: 'make' | 'edit' = 'make';
  let issues: string[] = [];
  let lastUri = '';
  let message = '';
  /** 사용자가 고칠 점을 적어 늘어난 회차 */
  let userRounds = 0;
  const first = seedImages(seed.args, seed.info);
  const firstSeed = await buildImageSeed(d.call, seed.args, first);

  log('start', `${title} judgeMax=${judgeMax} noExtraText=${!!d.noExtraText}\n${firstSeed.text}`);

  for (let i = 0; i < judgeMax + userRounds; i++) {
    d.notify(true, `이미지 ${mode === 'make' ? '생성' : '수정'} 명세 (${i + 1}/${judgeMax + userRounds})`);
    // 고치는 회차: 이전 결과가 원본이 되고, 처음 원본은 참조로 남는다.
    // 다시 그리는 회차: 처음 원본은 그대로, 이전 결과는 고칠 점이 남은 그림으로 참조에 둔다.
    const round: RoundImages =
      i === 0
        ? first
        : mode === 'edit'
          ? {
              original: lastUri,
              references: [...(first.original ? [{ uri: first.original, role: '처음 원본' }] : []), ...first.references],
              issues,
            }
          : { ...first, references: [...first.references, { uri: lastUri, role: '이전 결과 (고칠 점이 남은 그림)' }], issues };
    try {
      const input = i === 0 ? firstSeed : await buildImageSeed(d.call, seed.args, round);
      const spec = await writePixelSpec(
        d,
        found,
        made,
        [input.message],
        IMAGE_SPEC_PROMPT,
        !!round.original,
      );
      lastUri = await runPixel(d, found, made, { ...withSeedRefs(spec, round.references, round.original), requests: seed.args.requests }, {
        original: round.original,
        name: seed.args.name,
      });
    } catch (err) {
      if (d.signal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      log('cycle 실패', `${mode} ${i + 1}: ${msg}`);
      if (/거절/.test(msg)) return { uri: lastUri || undefined, message: msg };
      throw err;
    }

    if (judgeMax <= 1) {
      return {
        uri: lastUri,
        message: message || '',
      };
    }

    d.notify(true, '이미지 확인 중');
    const verdict = await judgeImage(d, seed.args, first, lastUri, issues);
    message = verdict.message;
    if (verdict.action === 'done') {
      return { uri: lastUri, message };
    }
    // 애매하거나, 고쳐 보았는데 같은 문제가 남았거나, 더 고칠 회차가 없으면 사용자에게 이대로 쓸지 묻는다.
    const repeated = repeatsIssues(verdict.issues, issues);
    const lastRound = i + 1 >= judgeMax + userRounds;
    if (verdict.action === 'ask' || repeated || lastRound) {
      log('review', `${verdict.action}${repeated ? ' (같은 지적 반복)' : ''}${lastRound ? ' (마지막 회차)' : ''}`);
      const review = await reviewWithUser(d.ask, { what: '이미지', uri: lastUri, message: verdict.message, issues: verdict.issues });
      if (review.use) return { uri: lastUri, message };
      if (userRounds >= USER_ROUNDS_MAX && lastRound) return { uri: lastUri, message: `${message} (더 고칠 수 있는 횟수를 넘었습니다)`.trim() };
      if (lastRound) userRounds++;
      // 사용자가 거절했거나 의견을 적었으면 다시 그린다 (원본이 있으면 원본에서 다시 시작한다).
      issues = review.issues;
      mode = 'make';
      continue;
    }
    issues = verdict.issues;
    mode = verdict.action === 'make' ? 'make' : 'edit';
  }

  return {
    uri: lastUri || undefined,
    message: message || '평가 횟수 상한에 닿아 마지막 그림을 쓴다.',
  };
}

/** 인포 request_pixel. scene은 이미 구체화된 지시여도, 그대로여도 된다. */
export async function requestPixelForInfographic(
  d: ImageCycleDeps,
  o: {
    scene: string;
    refs?: { uri: string; role: string }[];
    name?: string;
  },
): Promise<string> {
  const { uri, message } = await runImageCycle(
    { ...d, noExtraText: true, judgeMax: JUDGE_MAX_INFO },
    {
      args: {
        instructions: [
          o.scene,
          '그림 안에 글자·문구·로고 텍스트·워터마크를 넣지 않는다. 글자는 HTML에서 쓴다.',
        ],
        context: '인포그래픽 배경·일러스트용',
        refs: o.refs,
        name: o.name,
      },
      info: {},
    },
    o.name || clip(o.scene),
  );
  if (!uri) throw new Error(message || '이미지를 만들지 못했다.');
  return `${uri} ${MADE}${message ? ` (${message})` : ''}`;
}
