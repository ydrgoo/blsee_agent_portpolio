import { z } from 'zod';
import {
  DOC_URI_SRC,
  FONT_NAMES,
  FONT_SIZES,
  IMAGE_URI_SRC,
  LINE_LAYOUTS,
  QUOTATION_LAYOUTS,
  TEXT_KINDS,
  WRAP_LAYOUTS,
} from '@blog-helper/se-model';
import { RESEARCH_URI_SRC } from '@blog-helper/shared';
import { OP_NAMES, OPS } from './ops';

const anchored = (src: string) => new RegExp(`^(?:${src})$`);
export const docUri = z.string().regex(anchored(DOC_URI_SRC));
export const imageUri = z.string().regex(anchored(IMAGE_URI_SRC));
/** read 도구: 문서 블록·보관 이미지·인포 HTML·검색 자료 */
export const readUri = z.string().regex(anchored(`${DOC_URI_SRC}|${RESEARCH_URI_SRC}`));

export const targetSchema = z.object({
  uris: z.array(docUri).min(1).describe('블록·범위·이미지 URI 목록. 같은 일을 여러 블록에 하면 여러 개 또는 범위 하나'),
  where: z
    .enum(['on', 'after', 'before'])
    .optional()
    .describe('on: 그 블록·영역 자체 (insert·write면 그 영역을 덮어쓴다. 이어진 블록이나 범위 URI 하나) / after: 그 블록 뒤에 / before: 그 블록 앞에 (after·before는 블록 URI 하나)'),
});

export type Target = z.infer<typeof targetSchema>;

const ALL_LAYOUTS = [...new Set([...QUOTATION_LAYOUTS, ...LINE_LAYOUTS, ...WRAP_LAYOUTS])] as [string, ...string[]];

/** write의 글 지시. 실행 모델이 이것과 대화·문서 앞뒤를 보고 쓴다. */
export const briefSchema = z.object({
  goal: z.string().min(1).describe('필수. 이 글이 할 일 (예: "앞 문단에 이어 2일차 일정을 소개한다")'),
  points: z.array(z.string().min(1)).optional().describe('담을 요점과 대화에서 정한 구성·사실'),
  length: z.string().optional().describe('분량 (예: "문단 3~4개", "300자 안팎")'),
  tone: z.string().optional().describe('말투. 앞 글과 다르게 쓸 때만'),
  connect: z.string().optional().describe('앞뒤 글과 잇는 법'),
  avoid: z.string().optional().describe('넣지 말 것'),
});

const LAYOUT_TEXT =
  'set_layout: 인용구 default(큰따옴표)·quotation_line(왼쪽 세로선)·quotation_bubble(말풍선)·quotation_underline(밑줄)·quotation_postit(포스트잇)·quotation_corner(모서리 프레임) / ' +
  '구분선 default·line1~line7 / 이미지+글 감싸기 inner-left(작은 이미지 왼쪽)·inner-right(작은 이미지 오른쪽)·inner-big-left(큰 이미지 왼쪽)·inner-big-right(큰 이미지 오른쪽)';

/** 작업 하나. 필드의 뜻은 describe가, 언제 어떤 작업을 고를지는 계획 프롬프트가 맡는다. */
export const taskSchema = z.object({
  title: z.string().min(1).describe('사용자 화면에 보일 작업 한 줄 설명. URI 없이 (예: "두 번째 문단을 더 간결하게 다듬기")'),
  op: z.enum(OP_NAMES).describe(`명령\n${OP_NAMES.map((name) => `- ${name}: ${OPS[name].describe}`).join('\n')}`),
  target: targetSchema.describe(
    'edit·delete_block·move_block·set_*: 대상 블록·범위 / insert·write: 넣을 위치(where after·before) 또는 덮어쓸 영역(where on) / replace_image: 바꿀 이미지 URI(blsee://block/4/image/2)',
  ),
  to: targetSchema.optional().describe('move_block: 옮길 위치 (블록 URI 하나 + where after·before)'),
  instruction: z.string().optional().describe('edit: 읽은 글에서 고칠 곳을 모두 찾아, 곳마다 무엇을 어떻게 바꿀지 빠짐없이. 바꿀 글자가 정해져 있으면 그대로 적는다'),
  brief: briefSchema.optional().describe('write: 글 지시. 쓰는 모델은 대화 전체, 글 제목, 소제목 목록, 위치 앞뒤 글을 직접 보니 이 글이 할 일, 대화에서 정한 요점, 분량을 담는다'),
  sources: z
    .array(z.string().min(1))
    .optional()
    .describe('write·edit: 실행 모델이 읽을 재료(다른 블록·범위, 검색 자료 blsee://lib/research/…, 출처 URL) / replace_image: 넣을 새 이미지 URI (target과 같은 수)'),
  content: z
    .string()
    .optional()
    .describe('insert: 그대로 넣을 블씨 마크다운 원문 (사용자가 준 글, 소제목 한 줄, 구분선, "![](이미지 URI)", 나란히 놓을 이미지 2~3장은 "![](URI) ![](URI)" 한 줄). from 대신 쓴다'),
  from: z
    .array(z.string().min(1))
    .optional()
    .describe('insert: 넣을 이미지 URI들, 또는 서식까지 복사할 블록·범위 URI들. content 대신 쓴다'),
  layout: z.enum(ALL_LAYOUTS).optional().describe(LAYOUT_TEXT),
  type: z.enum(TEXT_KINDS).optional().describe('set_type: text(본문) / sectionTitle(소제목) / quotation(인용구)'),
  line: z.number().int().min(1).optional().describe('set_type: 블록 안 이 줄만 바꿀 때 몇 번째 줄인지 (1부터)'),
  font: z.enum(FONT_NAMES as unknown as [string, ...string[]]).optional().describe('set_font: 글꼴'),
  size: z
    .number()
    .int()
    .optional()
    .describe(`set_font: 글자 크기 (${FONT_SIZES.join(', ')})`),
  find: z.string().optional().describe('set_font: 블록 안 이 글자에만 적용할 때 그 글자'),
  reviews: z
    .array(z.string().min(1))
    .optional()
    .describe('이 작업이 반영하는 점검 항목 번호 ([Review]의 rv1-3 등). 점검 결과를 고칠 때 빠짐없이 적는다'),
});

export type Task = z.infer<typeof taskSchema>;
export type Brief = z.infer<typeof briefSchema>;

export const planSchema = z.object({
  tasks: z.array(taskSchema).describe('실행할 작업 목록'),
  note: z.string().optional().describe('고칠 것이 없거나 할 수 없어 작업이 비었을 때 그 이유'),
});

export type Plan = z.infer<typeof planSchema>;
