import { EditError, expandUri, outlineRefs, outlineTypes, parseUri, type Placement } from '@blog-helper/se-model';
import { specOf, type OpSpec, type Unit } from './ops';
import type { Target, Task } from './schemas';

export interface PlannedTask {
  /** 계획 안에서의 순서 (0부터) */
  index: number;
  id: string;
  task: Task;
  spec: OpSpec;
  units: Unit[];
  /** 실행 모델이 재료로 읽을 블록 (sources의 블록·범위 URI를 펼친 것) */
  sourceBlocks: string[];
  /** sources의 웹 출처와 자유 입력 */
  notes: string[];
  /** 실행 모델이 출력을 채우는 작업 */
  write: boolean;
  /** 건드리거나 읽는 블록 (대상, 위치, 재료) */
  scope: string[];
  /** 내용이나 위치가 바뀌는 블록 */
  modifies: string[];
}

class PlanError extends Error {}

const fail = (message: string): never => {
  throw new PlanError(message);
};

/** 위치 Target: 블록 URI 하나 + where after/before */
function placementOf(t: Target, field: string, order: readonly string[]): Placement {
  if (t.where !== 'after' && t.where !== 'before') fail(`${field}.where는 after나 before여야 한다.`);
  if (t.uris.length !== 1 || parseUri(t.uris[0])?.kind !== 'block') fail(`${field}에는 블록 URI 하나만 준다 (범위나 이미지가 아니라).`);
  const [ref] = expandUri(t.uris[0], order);
  return t.where === 'after' ? { after: ref } : { before: ref };
}

function blocksOf(t: Target, order: readonly string[]): string[] {
  if (t.where && t.where !== 'on') fail('이 명령의 target.where는 on(또는 비움)이다.');
  for (const uri of t.uris) {
    const kind = parseUri(uri)?.kind;
    if (kind !== 'block' && kind !== 'range') fail(`${uri}: 블록이나 범위 URI를 준다.`);
  }
  const set = new Set(t.uris.flatMap((u) => expandUri(u, order)));
  return order.filter((r) => set.has(r));
}

/** 블록·범위 URI들을 문서 순서로 펼치고, 이어진 묶음(문서에서 붙어 있는 블록들)으로 나눈다. */
function runsOf(blocks: string[], order: readonly string[]): string[][] {
  const runs: string[][] = [];
  for (const b of blocks) {
    const last = runs.at(-1);
    if (last && order.indexOf(last[last.length - 1]) + 1 === order.indexOf(b)) last.push(b);
    else runs.push([b]);
  }
  return runs;
}

/** 작업 하나를 문서 순서에 맞춰 풀고 검사한다. 틀리면 PlanError/EditError */
function resolveTask(task: Task, index: number, order: readonly string[], types: ReadonlyMap<string, string>): PlannedTask {
  const spec = specOf(task.op);
  const write = spec.llm !== 'none';
  // 글 지시가 빠졌으면 반려하지 않고 작업 제목으로 채운다 (실행 모델은 원래 요청도 함께 본다).
  if (task.op === 'write' && !task.brief?.goal?.trim()) {
    task = { ...task, brief: { ...task.brief, goal: task.instruction?.trim() || task.title } };
  }
  if (task.op === 'edit' && !task.instruction?.trim()) task = { ...task, instruction: task.title };
  for (const key of spec.needs ?? []) {
    const v = task[key];
    if (v === undefined || (typeof v === 'string' && !v.trim())) fail(`${String(key)}가 필요하다.`);
  }
  if (task.op === 'set_font' && !task.font && !task.size) fail('font나 size가 필요하다.');
  if (spec.to && !task.to) fail('to(옮길 위치)가 필요하다.');
  if (!spec.to && task.to) fail('to는 move_block에만 쓴다.');
  if (task.op === 'insert' && !!task.content?.trim() === !!task.from?.length) fail('insert에는 content와 from 중 하나만 준다.');

  const sourceBlocks: string[] = [];
  const sourceImages: string[] = [];
  const notes: string[] = [];
  for (const s of task.sources ?? []) {
    const u = parseUri(s);
    if (u?.kind === 'block' || u?.kind === 'range') sourceBlocks.push(...expandUri(s, order));
    else if (u?.kind === 'image' || u?.kind === 'gen') sourceImages.push(s);
    else if (u?.kind === 'html') notes.push(`인포 HTML: ${s}`);
    else if (/^blsee:\/\/lib\/research\//.test(s)) sourceBlocks.push(s);
    else if (s.startsWith('blsee://')) fail(`${s}: 알 수 없는 URI 형식이다.`);
    else notes.push(/^https?:\/\//.test(s) ? `출처: ${s}` : s);
  }
  if (spec.needsImages && !sourceImages.length) fail('sources에 넣을 이미지 URI가 필요하다.');

  const copies: string[] = [];
  for (const s of task.from ?? []) {
    const u = parseUri(s);
    if (u?.kind === 'block' || u?.kind === 'range') copies.push(...expandUri(s, order));
    else if (u?.kind !== 'image' && u?.kind !== 'gen') fail(`from의 ${s}: 이미지 URI나 복사할 블록·범위 URI를 준다.`);
  }
  if (copies.length && (task.from ?? []).some((s) => ['image', 'gen'].includes(parseUri(s)?.kind ?? ''))) {
    fail('from에는 이미지 URI들 또는 복사할 블록·범위 URI들 중 한 가지만 준다.');
  }

  const base = { images: [], sourceImages, copies: [...new Set(copies)] };
  const typesOf = (blocks: string[]) => blocks.map((b) => types.get(b) ?? '');
  let units: Unit[];
  let touched: string[];
  let modified: string[];
  if (spec.target === 'area') {
    if (task.target.where === 'after' || task.target.where === 'before') {
      const place = placementOf(task.target, 'target', order);
      const anchor = place.after ?? place.before!;
      units = [{ ...base, blocks: [], types: [], place }];
      touched = [anchor];
      // 같은 자리에 쓰는 뒤 작업이 앞 작업의 글을 보고 쓰도록 위치 블록을 "바뀌는 블록"으로 둔다.
      modified = [anchor];
    } else {
      if (copies.length) fail('블록 복사(from)는 where after/before 위치에만 넣는다.');
      const blocks = blocksOf(task.target, order);
      if (runsOf(blocks, order).length !== 1) fail('where on으로 덮어쓸 영역은 문서에서 이어진 블록이어야 한다 (범위 URI 하나).');
      units = [{ ...base, blocks, types: typesOf(blocks) }];
      touched = blocks;
      modified = blocks;
    }
  } else if (spec.target === 'images') {
    for (const uri of task.target.uris) if (parseUri(uri)?.kind !== 'image') fail(`${uri}: 이미지 URI(blsee://block/N/image[/k])를 준다.`);
    if (sourceImages.length !== task.target.uris.length || new Set(sourceImages).size !== sourceImages.length) {
      fail(
        'sources의 이미지는 바꿀 이미지 수만큼 서로 다르게 준다 (같은 이미지를 여러 자리에 넣지 않는다). ' +
          '이미지 묶음 전체를 이미지 하나로 바꾸려면 insert(from)로 묶음 뒤에 넣고 delete_block으로 묶음을 지운다.',
      );
    }
    const blocks = task.target.uris.map((u) => expandUri(u, order)[0]);
    units = [{ ...base, blocks, types: typesOf(blocks), images: task.target.uris }];
    touched = blocks;
    modified = blocks;
  } else {
    const blocks = blocksOf(task.target, order);
    const place = task.to ? placementOf(task.to, 'to', order) : undefined;
    if (place && blocks.includes(place.after ?? place.before!)) fail('옮기는 블록 자신을 위치로 줄 수 없다.');
    units =
      spec.per === 'run'
        ? runsOf(blocks, order).map((run) => ({ ...base, blocks: run, types: typesOf(run) }))
        : [{ ...base, blocks, types: typesOf(blocks), place }];
    touched = place ? [...blocks, place.after ?? place.before!] : blocks;
    modified = blocks;
  }

  return {
    index,
    id: `t${index + 1}`,
    task,
    spec,
    units,
    sourceBlocks: [...new Set(sourceBlocks)],
    notes,
    write,
    scope: [...new Set([...touched, ...sourceBlocks.filter((b) => b.startsWith('blsee://block/')), ...copies])],
    modifies: modified,
  };
}

/**
 * 계획을 계획 시점 개요(블록 순서와 종류)에 맞춰 풀고 검사한다.
 * 고칠 곳이 있으면 "작업 N(제목): 이유" 목록을 돌려준다.
 */
export function resolvePlan(tasks: Task[], outline: string): { planned: PlannedTask[]; problems: string[] } {
  const order = outlineRefs(outline);
  const types = outlineTypes(outline);
  const planned: PlannedTask[] = [];
  const problems: string[] = [];
  const deleted = new Set<string>();
  tasks.forEach((task, i) => {
    const label = `작업 ${i + 1}(${task.title})`;
    try {
      const t = resolveTask(task, i, order, types);
      const gone = t.scope.filter((r) => deleted.has(r));
      if (gone.length) problems.push(`${label}: ${gone.join(', ')}를 앞 작업이 지운다. 지우는 작업보다 앞에 둔다.`);
      if (task.op === 'delete_block') t.units.forEach((u) => u.blocks.forEach((b) => deleted.add(b)));
      planned.push(t);
    } catch (err) {
      if (!(err instanceof PlanError || err instanceof EditError)) throw err;
      problems.push(`${label}: ${err.message}`);
    }
  });
  return { planned, problems };
}

const overlaps = (a: string[], b: string[]) => a.some((r) => b.includes(r));

/**
 * 작업을 차례(wave)로 나눈다. 한 차례의 명령은 계획 순서대로 한 묶음으로 적용한다.
 * - 범위가 겹치는 작업은 앞 작업보다 이른 차례에 놓지 않는다 (계획 순서 유지).
 *   그래서 재료 블록을 지우는 작업이 글 작성 작업 뒤에 있으면, 실행 모델이 읽기 전에 지워지지 않는다.
 * - 실행 모델이 앞 작업이 바꾸는 블록을 읽어야 하면 다음 차례로 미뤄, 바뀐 내용을 보고 쓰게 한다.
 * - 겹치지 않는 작업은 같은 차례에서 함께(실행 모델은 병렬로) 실행한다.
 */
export function planWaves(tasks: PlannedTask[]): PlannedTask[][] {
  const waveOf: number[] = [];
  tasks.forEach((t, i) => {
    let w = 0;
    for (let j = 0; j < i; j++) {
      const u = tasks[j];
      if (!overlaps(u.scope, t.scope)) continue;
      const mustSee = t.write && overlaps(u.modifies, t.scope);
      w = Math.max(w, waveOf[j] + (mustSee ? 1 : 0));
    }
    waveOf.push(w);
  });
  const waves: PlannedTask[][] = [];
  tasks.forEach((t, i) => (waves[waveOf[i]] ??= []).push(t));
  return waves.filter(Boolean);
}
