import type { EditOp, Placement } from '@blog-helper/se-model';
import { checkUnits, parseText, writeOp } from './blsee';
import type { Task } from './schemas';

/** 작업을 실행하는 단위. edit은 이어진 블록 묶음마다, 그 밖에는 작업 하나가 한 단위다. */
export interface Unit {
  /** 이 단위가 다루는 블록 (문서 순서). 위치에 넣는 작업이면 비어 있다. */
  blocks: string[];
  /** blocks의 블록 종류(@ctype), 같은 순서 */
  types: string[];
  /** replace_image: 바꿀 이미지 URI */
  images: string[];
  /** 넣을 위치, 또는 옮길 위치 */
  place?: Placement;
  /** sources의 이미지 URI (replace_image에 넣을 이미지) */
  sourceImages: string[];
  /** insert from: 서식까지 복사할 블록 (문서 순서로 펼친 것) */
  copies: string[];
}

export interface OpSpec {
  /** 계획 모델에게 보일 설명 */
  describe: string;
  /**
   * target 종류
   * - blocks: 블록·범위
   * - images: 블록 이미지 URI
   * - area: 위치(블록 하나 + where after/before) 또는 덮어쓸 영역(where on + 이어진 블록·범위)
   */
  target: 'blocks' | 'images' | 'area';
  /** move_block: to(위치)가 필요하다 */
  to?: boolean;
  /** 실행 모델: write(글 전체를 쓴다) / edit(패치를 쓴다) / none(작업 필드로 바로 실행) */
  llm: 'write' | 'edit' | 'none';
  /** run: 이어진 블록 묶음마다 실행 모델을 따로 부른다 / once: 작업 하나에 한 번 */
  per: 'run' | 'once';
  /** sources에 이미지 URI가 있어야 한다 */
  needsImages?: boolean;
  /** 이 작업에 꼭 있어야 하는 작업 필드 */
  needs?: (keyof Task)[];
  /** llm none: 작업 필드로 편집 명령을 만든다 */
  build?: (unit: Unit, task: Task) => EditOp[];
}

/** 위치·영역 단위에 블씨 마크다운 단위를 쓰는 명령 */
export function areaOp(unit: Unit, text: string, before?: string): EditOp {
  const units = parseText(text);
  if (!units.length) throw new Error('쓸 글이 비었다.');
  checkUnits(units, { knownImage: () => true, ...(before !== undefined ? { before } : {}) });
  return writeOp(units, unit.place ? { place: unit.place } : { refs: unit.blocks });
}

/** 명령 이름. 스키마가 이것을 쓰므로 OPS와 따로 둔다 (타입 순환을 피한다). */
export const OP_NAMES = ['insert', 'write', 'edit', 'replace_image', 'delete_block', 'move_block', 'set_layout', 'set_type', 'set_font'] as const;
export type OpName = (typeof OP_NAMES)[number];

export const OPS: Record<OpName, OpSpec> = {
  insert: {
    describe:
      '정해진 내용을 그대로 넣는다. content(블씨 마크다운 원문: 사용자가 준 글, 소제목 한 줄, 구분선, ![](이미지 URI) 등) 또는 ' +
      'from(넣을 이미지 URI들, 또는 서식까지 그대로 복사할 블록·범위 URI)을 준다. 이미지 2~3장을 나란히 놓으려면 content 한 줄에 이어 쓴다.  새로 지어 쓰는 글은 write로 한다. ' +
      'where on이면 target 영역을 content로 덮어쓴다.',
    target: 'area',
    llm: 'none',
    per: 'once',
    build: (u, t) => {
      if (t.content?.trim()) return [areaOp(u, t.content)];
      // 블록 복사는 서식까지 그대로 두는 확장 명령으로 한다.
      if (u.copies.length) return u.copies.map((ref) => ({ op: 'copy_block', ref, ...u.place! }) as EditOp);
      return [areaOp(u, (t.from ?? []).map((uri) => `![](${uri})`).join('\n'))];
    },
  },
  write: {
    describe:
      '새 글을 지어 쓴다 (이어 쓰기, 새 섹션, 요약·정리 글, 다른 블록 내용으로 새 글·표, 영역 통째로 다시 쓰기). ' +
      'target이 where after/before면 그 자리에 넣고, where on이면 그 영역(이어진 블록)을 새 글로 덮어쓴다. ' +
      'brief에 목적·요점·분량 등을 채운다. 소제목·목록·인용구·표·수식·구분선이 섞인 글도 한 작업으로 쓴다. ' +
      '덮어쓰는 영역의 이미지·이미지 묶음·링크 카드·제목 블록은 그대로 남는다 (없애려면 delete_block을 따로 둔다).',
    target: 'area',
    llm: 'write',
    per: 'once',
    needs: ['brief'],
  },
  edit: {
    describe:
      'target 블록의 글을 패치로 고친다 (오타, 단어, 문장 다듬기, 문단 나누기·합치기, 소제목 단계, ' +
      '목록, 인용구 모양·출처, 표 칸, 수식, 이미지 캡션). 안 고친 곳은 서식까지 그대로 남는다. 이미지·이미지 묶음·링크 카드·제목 블록도 그대로 남는다. 고칠 곳과 방향을 instruction에 적는다.',
    target: 'blocks',
    llm: 'edit',
    per: 'run',
    needs: ['instruction'],
  },
  replace_image: {
    describe:
      'target 이미지 URI(blsee://block/4/image/2)를 sources의 이미지 URI로 바꾼다 (캡션·정렬 유지). 여러 개면 순서대로 짝짓는다. ' +
      '수정본·새 그림은 make_image/make_infographic으로 만든 뒤 그 URI를 sources에 준다.',
    target: 'images',
    llm: 'none',
    per: 'once',
    needsImages: true,
    build: (u) => u.images.map((target, i) => ({ op: 'replace_image', target, image: u.sourceImages[i] })),
  },
  delete_block: {
    describe: 'target 블록들을 지운다.',
    target: 'blocks',
    llm: 'none',
    per: 'once',
    build: (u) => u.blocks.map((ref) => ({ op: 'delete_block', ref })),
  },
  move_block: {
    describe: 'target 블록들을 문서 순서 그대로 to 위치(where: after/before)로 옮긴다.',
    target: 'blocks',
    to: true,
    llm: 'none',
    per: 'once',
    build: (u) => u.blocks.map((ref) => ({ op: 'move_block', ref, ...u.place }) as EditOp),
  },
  set_layout: {
    describe: 'target 블록들의 모양을 layout으로 바꾼다 (인용구·구분선·이미지+글 감싸기).',
    target: 'blocks',
    llm: 'none',
    per: 'once',
    needs: ['layout'],
    build: (u, t) => u.blocks.map((ref) => ({ op: 'set_layout', ref, layout: t.layout! })),
  },
  set_type: {
    describe: 'target 블록들의 글 종류를 type(text=본문, sectionTitle=소제목, quotation=인용구)으로 바꾼다. 블록 안 한 줄만 바꾸려면 line(1부터).',
    target: 'blocks',
    llm: 'none',
    per: 'once',
    needs: ['type'],
    build: (u, t) => u.blocks.map((ref) => ({ op: 'set_type', ref, type: t.type!, ...(t.line ? { line: t.line } : {}) })),
  },
  set_font: {
    describe: 'target 블록들의 글꼴(font)이나 글자 크기(size)를 바꾼다. 블록 안 특정 글자에만 적용하려면 find에 그 글자를 준다.',
    target: 'blocks',
    llm: 'none',
    per: 'once',
    build: (u, t) =>
      u.blocks.map((ref) => ({
        op: 'set_font',
        ref,
        ...(t.font ? { font: t.font } : {}),
        ...(t.size ? { size: t.size } : {}),
        ...(t.find ? { find: t.find } : {}),
      })),
  },
};

export function specOf(op: OpName): OpSpec {
  return OPS[op];
}
