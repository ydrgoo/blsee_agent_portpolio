import { HumanMessage, SystemMessage, type BaseMessage } from 'langchain';
import { z } from 'zod';
import { chatModel, config } from '../config';
import { usageCallback, type UsageMeter } from '../usage';
import type { Patch } from './blsee';
import { EDIT_PROMPT, WRITE_PROMPT } from './prompt';
import type { Unit } from './ops';
import type { Brief } from './schemas';
import type { PlannedTask } from './waves';

/** 실행 모델이 함께 보는 문서 앞뒤 */
export interface DocContext {
  /** 글 제목 */
  title: string;
  /** 소제목 목록 (개요 줄) */
  headings: string;
  /** 위치·영역 앞 글 (블록 머리줄 포함, 읽기 전용) */
  before: string;
  /** 위치·영역 뒤 글 (읽기 전용) */
  after: string;
}

export interface UnitInput {
  task: PlannedTask;
  unit: Unit;
  doc: DocContext;
  /** 덮어쓰거나 고칠 영역의 지금 글 (블씨 마크다운). 위치에 넣을 때는 없다. */
  area?: string;
  /** 재료 블록·자료의 지금 내용 */
  sourceText: string;
  /** 사용자의 원래 요청과 가리킨 곳 */
  request: string;
  /** 앞서 같은 단위가 실패했을 때의 오류 */
  previousError?: string;
}

/** write가 보는 대화: 지난 대화와 이번 요청, 그리고 이번 요청 안에서 대화 담당이 넘긴 편집 요청·검토 의견 */
export interface Conversation {
  messages: BaseMessage[];
  edits: string[];
}

const AREA_START = '----- 영역 시작 -----';
const AREA_END = '----- 영역 끝 -----';

function placeText(unit: Unit): string {
  if (unit.place) return unit.place.after ? `넣을 위치: ${unit.place.after} 뒤` : `넣을 위치: ${unit.place.before} 앞`;
  const [a, b] = [unit.blocks[0], unit.blocks[unit.blocks.length - 1]];
  return `영역: ${a === b ? a : `${a} ~ ${b}`}`;
}

function briefText(brief: Brief | undefined, instruction: string | undefined): string {
  if (!brief) return `지시:\n${instruction ?? ''}`;
  return [
    `목적: ${brief.goal}`,
    brief.points?.length ? `담을 요점:\n${brief.points.map((p) => `- ${p}`).join('\n')}` : '',
    brief.length ? `분량: ${brief.length}` : '',
    brief.tone ? `말투: ${brief.tone}` : '말투: 앞 글을 따른다',
    brief.connect ? `앞뒤와 잇기: ${brief.connect}` : '',
    brief.avoid ? `넣지 말 것: ${brief.avoid}` : '',
    instruction ? `덧붙인 지시: ${instruction}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function docText(doc: DocContext): string[] {
  return [
    doc.title ? `글 제목: ${doc.title}` : '',
    doc.headings ? `글의 소제목 (전체 구성):\n${doc.headings}` : '',
    `앞 글 (읽기 전용):\n${doc.before || '(없음)'}`,
    `뒤 글 (읽기 전용):\n${doc.after || '(없음)'}`,
  ];
}

const join = (parts: string[]) => parts.filter(Boolean).join('\n\n');

/** write: 위치나 영역에 들어갈 블씨 마크다운 글 전체를 쓴다. */
export async function writeText(input: UnitInput, conv: Conversation, meter: UsageMeter, signal?: AbortSignal): Promise<string> {
  const { task, unit } = input;
  const prompt = join([
    '이 작업의 글을 쓴다. 결과는 블씨 마크다운 본문만 낸다.',
    conv.edits.length ? `이번 요청 안에서 대화 담당이 넘긴 편집 요청·검토 의견:\n${conv.edits.map((e) => `- ${e}`).join('\n')}` : '',
    `작업: ${task.task.title}`,
    placeText(unit),
    briefText(task.task.brief, task.task.instruction),
    task.notes.length ? `참고 내용:\n${task.notes.map((n) => `- ${n}`).join('\n')}` : '',
    input.sourceText ? `재료 (읽기 전용):\n${input.sourceText}` : '',
    ...docText(input.doc),
    input.area !== undefined ? `덮어쓸 영역의 지금 글 (결과가 이 영역 전체를 대신한다):\n${AREA_START}\n${input.area}\n${AREA_END}` : '',
    input.previousError ? `앞서 쓴 결과를 반영하지 못했다. 이 오류가 나지 않게 다시 쓴다:\n${input.previousError}` : '',
  ]);
  const res = await chatModel('write').invoke([new SystemMessage(WRITE_PROMPT), ...conv.messages, new HumanMessage(prompt)], {
    signal,
    callbacks: [usageCallback(meter, config.write.model, 'action')],
  });
  return res.text;
}

const patchSchema = z.object({
  edits: z
    .array(
      z.object({
        old_string: z.string().min(1).describe('고칠 곳: 영역에 있는 글을 그대로 옮긴 것 (영역에서 한 곳에만 맞게 앞뒤를 넣는다)'),
        new_string: z.string().describe('바꾼 뒤의 글. 줄바꿈이 문단 경계다 (지우려면 빈 문자열)'),
        replace_all: z.boolean().optional().describe('같은 글을 모두 바꿀 때만 true'),
      }),
    )
    .describe('고칠 곳 목록. 차례로 적용된다. 고칠 것이 없으면 빈 목록'),
});

/** edit: 영역 글에 적용할 패치를 쓴다. */
export async function editPatches(input: UnitInput, meter: UsageMeter, signal?: AbortSignal): Promise<Patch[]> {
  const { task, unit } = input;
  const prompt = join([
    `사용자의 원래 요청:\n${input.request}`,
    `작업: ${task.task.title}`,
    `지시:\n${task.task.instruction ?? ''}`,
    task.notes.length ? `참고 내용:\n${task.notes.map((n) => `- ${n}`).join('\n')}` : '',
    input.sourceText ? `재료 (읽기 전용):\n${input.sourceText}` : '',
    `앞 글 (읽기 전용, 패치하지 않는다):\n${input.doc.before || '(없음)'}`,
    `고칠 ${placeText(unit)}\n${AREA_START}\n${input.area ?? ''}\n${AREA_END}`,
    `뒤 글 (읽기 전용, 패치하지 않는다):\n${input.doc.after || '(없음)'}`,
    input.previousError ? `앞서 낸 패치를 적용하지 못했다. 이 오류가 나지 않게 다시 낸다:\n${input.previousError}` : '',
  ]);
  const model = chatModel('action').withStructuredOutput(patchSchema);
  const out = (await model.invoke([new SystemMessage(EDIT_PROMPT), new HumanMessage(prompt)], {
    signal,
    callbacks: [usageCallback(meter, config.action.model, 'action')],
  })) as z.infer<typeof patchSchema>;
  return out.edits ?? [];
}
