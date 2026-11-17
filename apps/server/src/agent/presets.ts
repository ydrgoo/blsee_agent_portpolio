import { blockImageUri, expandUri, outlineRefs, outlineTypes, parseUri, rangeUri } from '@blog-helper/se-model';
import { PRESETS, presetBlockOf, type AskAnswer, type AskRequest, type PresetId, type PresetRequest } from '@blog-helper/shared';
import { webSearch } from '../search';
import type { UsageMeter } from '../usage';
import { makeInfographic } from './infographic-agent';
import type { Task } from './schemas';
import { applyPixelSpec, saveResearch, type CallDocTool, type NotifyStep } from './tools';

/*
 * 빠른 실행: 계획 모델 없이 정해진 작업 목록을 만든다. 실행은 일반 요청과 같은 경로를 탄다.
 * 지시문은 모두 이 파일에 둔다.
 */

/** 앞뒤 흐름으로 함께 읽는 블록 수 (한쪽) */
const AROUND = 2;
/** 말투 기준으로 읽는 블록 수 (한쪽) */
const TONE_AROUND = 4;
const LABEL_CHARS = 30;

const TONE_RULE =
  '말투만 다듬는다. 재료로 준 앞뒤 블록의 말투(존댓말·반말, 어미, 문장 길이, 쉼표·느낌표·이모지 쓰는 정도)를 기준으로 맞춘다. ' +
  '뜻, 정보, 문장 순서는 바꾸지 않고, 어색하거나 기준과 다른 곳만 고친다.';
const FACT_CHECK =
  '입력은 블로그 글 한 문단이다. ' +
  '문단에서 확인할 수 있는 사실 주장(수치, 날짜, 이름, 장소, 사건, 인과)을 골라 하나씩 web_search로 확인한다. 감상과 의견은 건너뛴다. ' +
  '주장마다 한 줄로 "✅ 맞음", "⚠️ 다름", "❓ 확인 못함" 중 하나와 주장, 짧은 근거를 쓰고, 근거 문장 끝에 검색 결과 번호를 [1]처럼 붙인다. ' +
  '"다름"이면 맞는 내용을 함께 쓴다. 확인할 사실 주장이 없으면 그렇다고 한 줄로 답한다. 한국어로 쓴다.';
const INFOGRAPHIC =
  '블로그 본문에 넣을 인포그래픽. [재료 글]의 핵심을 한눈에 보이게 정리한다 (비교, 단계, 수치 강조, 체크리스트, 요약 카드 중 내용에 맞는 형태). ' +
  '[맥락]의 앞뒤 흐름은 맥락 파악용이며 그리지 않는다.';
const IMAGE =
  '블로그 본문에 넣을 사진 또는 일러스트로, "중심 내용"의 장면이나 분위기를 담는다. "앞뒤 흐름"은 맥락 파악용이다.';
const REMOVE_BG = '배경을 깨끗한 흰색으로 바꾸고, 주인공인 사람·사물은 모양, 색, 크기를 그대로 둔다';
const TIDY_TABLE =
  '표를 보기 좋게 정리한다. 같은 열의 단위와 표기(숫자 형식, 날짜, 용어)를 통일하고, 머리글을 짧고 분명하게 고치고, 빈 칸은 "-"로 채운다. ' +
  '값과 행·열 구성, 칸 배경색·굵게 같은 서식은 바꾸지 않는다.';

export interface PresetContext {
  req: PresetRequest;
  /** 대상 블록 (문서 순서) */
  blocks: string[];
  /** 문서 순서의 모든 블록 */
  order: string[];
  callTool: CallDocTool;
  meter: UsageMeter;
  notify: NotifyStep;
  /** 작업공간 라이브러리에 검색 결과를 남길 수 있다 */
  library: boolean;
  /** 사용자 언어·지역 (그림 기본값) */
  locale: string;
  ask: (req: AskRequest) => Promise<AskAnswer>;
  signal?: AbortSignal;
}

/** 고정 작업 목록, 또는 문서를 고치지 않는 일의 답 */
export type PresetPlan = { tasks: Task[]; reply: string } | { reply: string };

interface PresetDef {
  /** 실행 뒤 대화 모델이 결과를 검토할지. 다시 고치라고 하면 일반 계획 흐름으로 이어간다. */
  review: boolean;
  prepare: (c: PresetContext) => Promise<PresetPlan>;
}

/** 커맨드 뒤에 이어서 쓴 글을 고정 지시에 붙인다. */
const plus = (instruction: string, extra?: string) => (extra?.trim() ? `${instruction}\n${extra.trim()}` : instruction);

const clip = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > LABEL_CHARS ? `${t.slice(0, LABEL_CHARS)}…` : t;
};
const last = (c: PresetContext) => c.blocks[c.blocks.length - 1];

/** 대상 앞뒤로 n블록씩 넓힌 범위 URI */
function around(c: PresetContext, n: number): string {
  const a = c.order.indexOf(c.blocks[0]);
  const b = c.order.indexOf(last(c));
  return rangeUri(c.order[Math.max(1, a - n)] ?? c.blocks[0], c.order[Math.min(c.order.length - 1, b + n)]);
}

/** 그림 지시: 중심 내용(고른 글이 있으면 그 글)과 앞뒤 흐름 */
async function drawingBrief(c: PresetContext, rule: string): Promise<string> {
  const read = (uri: string) => c.callTool('read_blocks', { uris: [uri] });
  const [target, context] = await Promise.all([c.req.text?.trim() || read(c.req.target), read(around(c, AROUND))]);
  return `${rule}\n\n중심 내용:\n${target}\n\n앞뒤 흐름:\n${context}`;
}

const insertAfter = (c: PresetContext, title: string, uri: string): Task => ({
  title,
  op: 'insert',
  target: { uris: [last(c)], where: 'after' },
  from: [uri],
});

const DEFS: Record<PresetId, PresetDef> = {
  tone: {
    review: false,
    prepare: async (c) => {
      const text = c.req.text?.trim();
      const sources = [around(c, TONE_AROUND)];
      const task: Task = {
        title: '문단 말투 다듬기',
        op: 'edit',
        target: { uris: [c.req.target] },
        instruction: text ? plus(`이 블록에서 다음 글만 고친다: ${JSON.stringify(text)}\n${TONE_RULE}`, c.req.extra) : plus(TONE_RULE, c.req.extra),
        sources,
      };
      return { tasks: [task], reply: '말투를 다듬었어요. 바뀐 곳을 확인해 주세요.' };
    },
  },
  fact_check: {
    review: false,
    prepare: async (c) => {
      const text = c.req.text?.trim() || (await c.callTool('read_blocks', { uris: [c.req.target] }));
      c.notify(true, `사실 확인: ${clip(text)}`);
      const reply = await webSearch(text, c.meter, plus(FACT_CHECK, c.req.extra));
      if (c.library) await saveResearch(c.callTool, `사실 확인: ${clip(text)}`, `확인한 글:\n\n> ${text.replace(/\n/g, '\n> ')}\n\n${reply}`, 'fact_check');
      return { reply };
    },
  },
  infographic: {
    review: false,
    prepare: async (c) => {
      c.notify(true, '인포그래픽 그리는 중');
      const label = `인포그래픽 · ${clip(c.req.text ?? '')}`;
      const text = c.req.text?.trim();
      const { uri, message } = await makeInfographic(
        {
          call: c.callTool,
          meter: c.meter,
          notify: c.notify,
          locale: c.locale,
          ask: c.ask,
          signal: c.signal,
        },
        {
          instructions: [
            ...(text ? [INFOGRAPHIC, `담을 내용은 [재료 글] 가운데 다음 부분이다: ${JSON.stringify(text)}`] : [INFOGRAPHIC]),
            ...(c.req.extra?.trim() ? [c.req.extra.trim()] : []),
          ],
          sources: [c.req.target],
          context: `앞뒤 흐름:\n${await c.callTool('read_blocks', { uris: [around(c, AROUND)] })}`,
          name: label,
        },
        label,
      );
      if (!uri) throw new Error(`인포그래픽을 그리지 못했습니다. ${message}`);
      return { tasks: [insertAfter(c, '인포그래픽 넣기', uri)], reply: '인포그래픽을 만들어 바로 아래에 넣었어요.' };
    },
  },
  image: {
    review: false,
    prepare: async (c) => {
      c.notify(true, '이미지 만드는 중');
      const label = `이미지 · ${clip(c.req.text ?? '')}`;
      const uri = await applyPixelSpec({
        call: c.callTool,
        meter: c.meter,
        locale: c.locale,
        spec: {
          mode: 'generate',
          items: [
            { kind: '배경', instruction: await drawingBrief(c, plus(IMAGE, c.req.extra)) },
            { kind: '뺄 것', instruction: '그림 안에 글자를 넣지 않는다' },
          ],
        },
        name: label,
      });
      return { tasks: [insertAfter(c, '이미지 넣기', uri)], reply: '이미지를 만들어 바로 아래에 넣었어요.' };
    },
  },
  remove_bg: {
    review: false,
    prepare: async (c) => {
      c.notify(true, '배경 지우는 중');
      const parsed = parseUri(c.req.target);
      const source = parsed?.kind === 'image' ? c.req.target : blockImageUri(c.req.target);
      const uri = await applyPixelSpec({
        call: c.callTool,
        meter: c.meter,
        locale: c.locale,
        spec: { mode: 'edit', items: [{ kind: '배경', instruction: plus(REMOVE_BG, c.req.extra) }] },
        original: source,
        name: '배경 지운 사진',
      });
      return {
        tasks: [{ title: '사진 배경 지우기', op: 'replace_image', target: { uris: [source] }, sources: [uri] }],
        reply: '배경을 지운 사진으로 바꿨어요.',
      };
    },
  },
  tidy_table: {
    review: false,
    prepare: async (c) => ({
      tasks: [{ title: '표 정리', op: 'edit', target: { uris: [c.req.target] }, instruction: plus(TIDY_TABLE, c.req.extra) }],
      reply: '표를 정리했어요. 바뀐 곳을 확인해 주세요.',
    }),
  },
};

const BLOCK_NAME = { text: '문단', image: '사진', table: '표' } as const;

/** 요청을 검사하고 고정 작업 목록을 만든다. 쓸 수 없는 블록이면 Error */
export async function preparePreset(
  req: PresetRequest,
  ctx: {
    outline: string;
    callTool: CallDocTool;
    meter: UsageMeter;
    notify: NotifyStep;
    library: boolean;
    locale: string;
    ask: (req: AskRequest) => Promise<AskAnswer>;
    signal?: AbortSignal;
  },
): Promise<PresetPlan & { review: boolean }> {
  const def = DEFS[req.id];
  const info = PRESETS[req.id];
  if (!def || !info) throw new Error(`알 수 없는 빠른 실행입니다: ${req.id}`);
  const kind = parseUri(req.target)?.kind;
  if (kind !== 'block' && kind !== 'range' && kind !== 'image') throw new Error(`${req.target}: 블록이나 범위 URI가 아닙니다.`);

  const order = outlineRefs(ctx.outline);
  const types = outlineTypes(ctx.outline);
  const blocks = expandUri(req.target, order);
  const kinds = blocks.map((b) => presetBlockOf(types.get(b) ?? ''));
  if (kinds.every((k) => k === null)) throw new Error(`${info.label}: 제목에는 쓸 수 없습니다.`);
  const imageOk = info.on === 'image' && kind === 'image' && blocks.length === 1;
  if (info.on !== 'any' && !imageOk && (blocks.length !== 1 || kinds[0] !== info.on)) {
    throw new Error(`${info.label}: ${BLOCK_NAME[info.on]} 하나를 가리킬 때만 쓸 수 있습니다.`);
  }

  const plan = await def.prepare({ req, blocks, order, ...ctx });
  return { ...plan, review: def.review };
}
