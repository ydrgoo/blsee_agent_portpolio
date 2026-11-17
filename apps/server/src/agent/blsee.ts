/**
 * 서버 쪽 블씨 마크다운 처리: 실행 모델이 쓴 글을 단위로 읽고, 패치를 적용하고, 반영 전에 고정 검사를 한다.
 * 블록과 맞춰 보고 다시 만드는 일은 확장이 se-model(write_blocks)로 한다.
 */
import { parseBlsee, parseUri, normalizeSrc, type BlsUnit, type EditOp, type Placement } from '@blog-helper/se-model';
import { checkLatex } from './latex';
import { parseTableRows } from './table-html';

/** 블씨 마크다운을 단위로. 표는 HTML 파서로 읽는다. 문법 오류면 Error (몇 번째 줄인지 포함) */
export function parseText(text: string): BlsUnit[] {
  return parseBlsee(text, { parseTable: parseTableRows });
}

/** 모델이 글 전체를 ``` 로 감싸 보냈으면 벗긴다. */
export function unwrapOutput(text: string): string {
  const t = text.replace(/\r\n?/g, '\n').trim();
  const m = /^```(?:markdown|md|blsee|text)?\n([\s\S]*?)\n```$/i.exec(t);
  return m ? m[1] : t;
}

export interface Patch {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/** 공백 차이(NBSP, 줄 끝 공백, 연속 공백)를 무시하고 찾을 때 쓰는 정규식 */
function looseRegex(s: string): RegExp {
  const parts = normalizeSrc(s)
    .split(/[ \t]+/)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(parts.join('[ \\t\\u00a0]+'), 'g');
}

/** 꾸밈 태그(<b>, <span …> 등)가 글자 사이에 끼어 있어도 맞는 정규식. old_string에 태그가 있으면 쓰지 않는다. */
function tagFreeRegex(s: string): RegExp | null {
  if (/<[a-z/]/i.test(s)) return null;
  const tag = '(?:</?(?:b|i|u|s|span|a)(?:\\s[^>]*)?>)*';
  const chars = [...normalizeSrc(s)].map((ch) => (/\s/.test(ch) ? '[ \\t\\u00a0]+' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // 앞의 여는 태그와 뒤의 닫는 태그까지 넣어, 새 글이 가진 태그로 그 구간을 통째로 바꾼다.
  const open = '(?:<(?:b|i|u|s|span|a)(?:\\s[^>]*)?>)*';
  const close = '(?:</(?:b|i|u|s|span|a)>)*';
  return new RegExp(open + chars.join(tag) + close, 'g');
}

/**
 * 영역 글에 패치를 차례로 적용한다. skipped를 주면 맞지 않는 패치만 건너뛰고 그 까닭을 모은다. old_string은 한 곳에만 맞아야 한다 (replace_all이면 모두).
 * 정확히 맞지 않으면 공백 차이를 무시하고 한 번 더 찾는다. 못 찾거나 여러 곳이면 Error (이유를 쓴다).
 */
export function applyPatches(text: string, patches: Patch[], skipped?: string[]): string {
  let out = text;
  patches.forEach((p, i) => {
    if (skipped) {
      // 건너뛰기: 맞지 않는 패치만 빼고 나머지를 적용한다. 빠진 까닭은 skipped에 모은다.
      try {
        out = applyPatches(out, [p]);
      } catch (err) {
        skipped.push((err instanceof Error ? err.message : String(err)).replace(/^1번째 패치/, `${i + 1}번째 패치`));
      }
      return;
    }
    const label = `${i + 1}번째 패치`;
    if (!p.old_string) throw new Error(`${label}: old_string이 비었다. 고칠 곳의 지금 글을 그대로 옮긴다.`);
    if (p.old_string === p.new_string) return;
    const exact = out.split(p.old_string).length - 1;
    if (exact === 1 || (exact > 1 && p.replace_all)) {
      out = p.replace_all ? out.split(p.old_string).join(p.new_string) : out.replace(p.old_string, () => p.new_string);
      return;
    }
    if (exact > 1) {
      throw new Error(`${label}: old_string "${p.old_string.slice(0, 60)}"이 ${exact}곳에 있다. 앞뒤 글자를 더 넣어 한 곳에만 맞게 쓰거나, 모두 바꿀 거면 replace_all을 쓴다.`);
    }
    const re = looseRegex(p.old_string);
    const found = [...out.matchAll(re)];
    if (found.length === 1 || (found.length > 1 && p.replace_all)) {
      out = out.replace(re, () => p.new_string);
      return;
    }
    if (found.length > 1) throw new Error(`${label}: old_string "${p.old_string.slice(0, 60)}"이 여러 곳에 맞는다. 앞뒤 글자를 더 넣는다.`);
    // 화면에 보이는 글로 가리켰으면 (꾸밈 태그 없이) 태그를 건너뛰고 한 번 더 찾는다. 바꾼 구간의 꾸밈은 새 글을 따른다.
    const plain = tagFreeRegex(p.old_string);
    const byText = plain ? [...out.matchAll(plain)] : [];
    if (plain && (byText.length === 1 || (byText.length > 1 && p.replace_all))) {
      out = out.replace(plain, () => p.new_string);
      return;
    }
    throw new Error(`${label}: old_string "${p.old_string.slice(0, 60)}"을 고칠 영역에서 찾지 못했다. 영역 글을 한 글자도 바꾸지 않고 그대로 옮긴다.`);
  });
  return out;
}

export interface UnitCheck {
  /** 이 요청에서 쓸 수 있는 보관 이미지인지 (blsee://lib/images/…) */
  knownImage: (uri: string) => boolean;
  /** 원래 영역 글 (고칠 때). 있으면 이미지·블록 표시를 빠뜨렸는지 먼저 본다. */
  before?: string;
}

/**
 * 반영 전 고정 검사: 수식 문법, 이미지 URI, 지울 수 없는 줄. 틀린 곳을 모두 모아 Error로 알린다.
 * 확장의 write_blocks도 같은 규칙을 다시 검사하지만, 여기서 먼저 막아야 실행 모델에게 바로 다시 쓰게 할 수 있다.
 */
export function checkUnits(units: BlsUnit[], check: UnitCheck): void {
  const problems: string[] = [];
  for (const u of units) {
    if (u.t === 'formula') {
      try {
        checkLatex(u.latex);
      } catch (err) {
        problems.push(`수식 ${u.src.slice(0, 60)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const imgs = u.t === 'img' ? [u] : u.t === 'strip' ? u.imgs : [];
    for (const img of imgs) {
      const kind = parseUri(img.uri)?.kind;
      if (kind === 'gen') {
        if (!check.knownImage(img.uri)) problems.push(`${img.uri}: 이 요청에서 알 수 없는 이미지다. 만들거나 받은 URI만 쓴다.`);
      } else if (kind !== 'image') {
        problems.push(`${u.src}: 이미지 주소는 blsee://lib/images/… 또는 blsee://block/N/image여야 한다.`);
      }
    }
  }
  const hasTitle = check.before !== undefined && /^<title>/m.test(check.before);
  if (!hasTitle && units.some((u) => u.t === 'title')) {
    problems.push('<title> 줄은 글 제목 블록을 고칠 때만 쓴다. 이 자리에는 제목이 없으니 <title> 줄을 빼고 본문만 쓴다 (제목은 따로 고친다).');
  }
  if (check.before !== undefined) {
    const before = parseText(check.before);
    const lost = (u: BlsUnit) =>
      `${u.src.slice(0, 80)} 줄이 빠졌다. 이미지·블록 표시(<!-- -->)·제목 줄은 지울 수 없다 (이미지 캡션은 고칠 수 있다). 정말 지우려면 delete_block 작업으로 따로 한다.`;
    const keeps = new Set(units.flatMap((u) => (u.t === 'keep' ? [u.ref] : [])));
    for (const u of before) {
      if (u.t === 'keep' && !keeps.has(u.ref)) problems.push(lost(u));
      if (u.t === 'title' && !units.some((n) => n.t === 'title')) problems.push(lost(u));
    }
    // 이미지는 다른 이미지로 바꿀 수 있으니, 줄 수가 줄었을 때만 빠진 것으로 본다.
    const imgs = new Set(units.flatMap((u) => (u.t === 'img' ? [u.uri] : [])));
    const oldImgs = before.filter((u) => u.t === 'img');
    if (units.filter((u) => u.t === 'img').length < oldImgs.length) {
      for (const u of oldImgs) if (u.t === 'img' && !imgs.has(u.uri)) problems.push(lost(u));
    }
  }
  if (problems.length) throw new Error(problems.join('\n'));
}

/** write 결과에서 쓸 수 없는 제목 줄을 버린다 (영역에 제목이 없을 때). 제목은 다른 작업이 고친다. */
export function dropStrayTitle(units: BlsUnit[], area: string | undefined): BlsUnit[] {
  if (area !== undefined && /^<title>/m.test(area)) return units;
  return units.filter((u) => u.t !== 'title');
}

/** 단위 목록을 편집 명령으로: 영역이 있으면 그 범위를 바꾸고, 없으면 위치에 넣는다. */
export function writeOp(units: BlsUnit[], area: { refs: string[] } | { place: Placement }): EditOp {
  return 'refs' in area ? { op: 'write_blocks', refs: area.refs, units } : { op: 'write_blocks', refs: [], units, ...area.place };
}

/** write_blocks 결과 줄에서 새로 넣은 블록 가운데 마지막 참조 (같은 자리에 이어서 넣을 때) */
export function lastInserted(message: string): string | undefined {
  const m = /넣었습니다: (.*)$/.exec(message);
  if (m) return [...m[1].matchAll(/blsee:\/\/block\/\d+/g)].at(-1)?.[0];
  // copy_block: "… 블록을 복사해 … 뒤에 blsee://block/N로 넣었습니다."
  return /(blsee:\/\/block\/\d+)로 넣었습니다/.exec(message)?.[1];
}
