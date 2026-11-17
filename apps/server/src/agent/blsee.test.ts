/**
 * 블씨 마크다운 왕복·고치기 테스트. 실행: npm test -w @blog-helper/server
 */
import { readdirSync, readFileSync } from 'node:fs';
import { deepStrictEqual, equal, ok, throws } from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyBatch,
  BlockRefs,
  docOrder,
  fillPendingImage,
  PENDING_IMAGE_KEY,
  readBlocks,
  type EditOp,
  type SeComponent,
  type SeDocumentData,
} from '@blog-helper/se-model';
import { applyPatches, checkUnits, parseText, writeOp } from './blsee';

const DATA = new URL('../../../../test-data/', import.meta.url);
const docs = readdirSync(DATA)
  .filter((f) => f.startsWith('document-data'))
  .map((f) => ({ name: f, doc: (JSON.parse(readFileSync(new URL(f, DATA), 'utf8')) as { data: SeDocumentData }).data }));

function setup(doc: SeDocumentData) {
  const refs = new BlockRefs();
  refs.sync(doc);
  const order = docOrder(doc, refs);
  return { refs, order };
}

const source = (doc: SeDocumentData, refs: BlockRefs, uris: string[]) => readBlocks(doc, refs, { uris, source: true });
const apply = (doc: SeDocumentData, refs: BlockRefs, ops: EditOp[]) => applyBatch(doc, ops, refs);
const comps = (doc: SeDocumentData) => doc.document.components;
const ctype = (c: SeComponent) => c['@ctype'];

function textDoc(blocks: { type: string; lines?: string[] }[]): SeDocumentData {
  let n = 0;
  const id = () => `SE-t${++n}`;
  const para = (text: string) => ({ id: id(), nodes: [{ id: id(), value: text, '@ctype': 'textNode' }], '@ctype': 'paragraph' });
  return {
    document: {
      components: [
        { id: id(), title: [para('제목')], '@ctype': 'documentTitle' },
        ...blocks.map((b) => {
          if (b.type === 'image') return { id: id(), src: 'https://x/y.png', '@ctype': 'image' };
          if (b.type === 'oglink') return { id: id(), title: '카드', link: 'https://x', '@ctype': 'oglink' };
          if (b.type === 'sectionTitle') return { id: id(), title: (b.lines ?? []).map(para), '@ctype': 'sectionTitle' };
          return { id: id(), layout: 'default', value: (b.lines ?? []).map(para), '@ctype': b.type };
        }),
      ],
    },
  } as SeDocumentData;
}

for (const { name, doc } of docs) {
  test(`왕복: ${name} 전체를 읽은 그대로 쓰면 문서가 그대로다`, () => {
    const { refs, order } = setup(doc);
    const text = source(doc, refs, order);
    const units = parseText(text);
    deepStrictEqual(units.map((u) => u.src).join('\n'), text);
    const { document } = apply(doc, refs, [writeOp(units, { refs: order })]);
    deepStrictEqual(document, doc);
  });

  test(`왕복: ${name} 블록마다 읽은 그대로 쓰면 그대로다`, () => {
    const { refs, order } = setup(doc);
    for (const ref of order) {
      const units = parseText(source(doc, refs, [ref]));
      const { document } = apply(doc, refs, [writeOp(units, { refs: [ref] })]);
      deepStrictEqual(document, doc, ref);
    }
  });
}

test('고치기: 한 문단만 바꾸면 그 문단만 새로 만들고 나머지 객체·블록 참조는 그대로다', () => {
  const doc = textDoc([{ type: 'text', lines: ['첫 문단', '둘째 문단', '', '셋째 문단'] }, { type: 'text', lines: ['다른 블록'] }]);
  const { refs, order } = setup(doc);
  const range = order.slice(1);
  const text = applyPatches(source(doc, refs, range), [{ old_string: '둘째 문단', new_string: '둘째 문단을 고쳤다' }]);
  const { document } = apply(doc, refs, [writeOp(parseText(text), { refs: range })]);
  const [, a, b] = comps(document);
  equal(a.id, comps(doc)[1].id);
  equal(b.id, comps(doc)[2].id);
  const before = (comps(doc)[1].value as { id: string }[]).map((p) => p.id);
  const after = (a.value as { id: string }[]).map((p) => p.id);
  equal(after[0], before[0]);
  ok(after[1] !== before[1]);
  equal(after[2], before[2]);
  deepStrictEqual(b, comps(doc)[2]);
});

test('고치기: 붙어 있는 문단 블록 둘은 고쳐도 둘로 남는다', () => {
  const doc = textDoc([{ type: 'text', lines: ['가'] }, { type: 'text', lines: ['나'] }]);
  const { refs, order } = setup(doc);
  const range = order.slice(1);
  const text = applyPatches(source(doc, refs, range), [{ old_string: '나', new_string: '나다\n라' }]);
  const { document } = apply(doc, refs, [writeOp(parseText(text), { refs: range })]);
  equal(comps(document).length, 3);
  equal((comps(document)[2].value as unknown[]).length, 2);
});

test('고치기: 이미지 줄이나 블록 표시를 빼면 거절하고 이유를 알린다', () => {
  const doc = textDoc([{ type: 'text', lines: ['가'] }, { type: 'image' }, { type: 'oglink' }]);
  const { refs, order } = setup(doc);
  const range = order.slice(1);
  const before = source(doc, refs, range);
  const noImage = before.split('\n').filter((l) => !l.startsWith('![')).join('\n');
  throws(() => checkUnits(parseText(noImage), { knownImage: () => true, before }), /지울 수 없다/);
  throws(() => apply(doc, refs, [writeOp(parseText(noImage), { refs: range })]), /지울 수 없다/);
  const noCard = before.split('\n').filter((l) => !l.startsWith('<!--')).join('\n');
  throws(() => apply(doc, refs, [writeOp(parseText(noCard), { refs: range })]), /지울 수 없다/);
});

test('고치기: 이미지 캡션은 고칠 수 있다', () => {
  const doc = textDoc([{ type: 'image' }]);
  const { refs, order } = setup(doc);
  const text = source(doc, refs, [order[1]]).replace('![]', '![새 캡션]');
  const { document } = apply(doc, refs, [writeOp(parseText(text), { refs: [order[1]] })]);
  equal(comps(document)[1].id, comps(doc)[1].id);
  equal(JSON.stringify(comps(document)[1].caption).includes('새 캡션'), true);
});

test('쓰기: 새 글을 블록 종류대로 넣는다', () => {
  const doc = textDoc([{ type: 'text', lines: ['앞 글'] }]);
  const { refs, order } = setup(doc);
  const text = [
    '## 새 소제목',
    '첫 줄 <b>굵게</b> <a href="https://naver.com">링크</a>',
    '',
    '- 목록 하나',
    '  - 목록 둘',
    '> [!bubble]',
    '> 인용 글',
    '> -- 출처: 누군가',
    '--- line3',
    '$$x^2 + y^2 = r^2$$',
    '```',
    'const a = 1;',
    '```',
    '<table>',
    '<tr><td>가</td><td>나</td></tr>',
    '</table>',
    '\\- 목록 아닌 글',
  ].join('\n');
  const units = parseText(text);
  checkUnits(units, { knownImage: () => true });
  const { document } = apply(doc, refs, [writeOp(units, { place: { after: order[1] } })]);
  const added = comps(document).slice(2);
  deepStrictEqual(added.map(ctype), ['sectionTitle', 'text', 'quotation', 'horizontalLine', 'formula', 'code', 'table', 'text']);
  const body = added[1].value as { nodes: { value: string; style?: Record<string, unknown>; link?: { url: string } }[]; style?: Record<string, unknown> }[];
  equal(body.length, 4);
  ok(body[0].nodes.some((n) => n.value === '굵게' && n.style?.bold));
  ok(body[0].nodes.some((n) => n.link?.url === 'https://naver.com'));
  deepStrictEqual((body[2].style?.list as { level: number }).level, 0);
  deepStrictEqual((body[3].style?.list as { level: number }).level, 1);
  equal(added[2].layout, 'quotation_bubble');
  equal(added[3].layout, 'line3');
  const plain = (added[7].value as { nodes: { value: string }[] }[])[0];
  equal(plain.nodes[0].value, '- 목록 아닌 글');
  ok(!(plain as { style?: unknown }).style);
});

test('쓰기: 같은 자리에 두 번 넣으면 명령 순서대로 이어진다', () => {
  const doc = textDoc([{ type: 'text', lines: ['앞'] }, { type: 'text', lines: ['뒤'] }]);
  const { refs, order } = setup(doc);
  const { document } = apply(doc, refs, [
    writeOp(parseText('하나'), { place: { after: order[1] } }),
    writeOp(parseText('둘'), { place: { after: order[1] } }),
  ]);
  const texts = comps(document).map((c) => JSON.stringify(c.value ?? c.title));
  ok(texts[2].includes('하나') && texts[3].includes('둘') && texts[4].includes('뒤'));
});

test('패치: 공백 차이는 무시하고, 여러 곳이면 이유를 알린다', () => {
  equal(applyPatches('가 나 다', [{ old_string: '가 나', new_string: '라' }]), '라 다');
  throws(() => applyPatches('가 가', [{ old_string: '가', new_string: '나' }]), /2곳/);
  equal(applyPatches('가 가', [{ old_string: '가', new_string: '나', replace_all: true }]), '나 나');
  throws(() => applyPatches('가', [{ old_string: '없음', new_string: '나' }]), /찾지 못했다/);
});

test('검사: 틀린 수식과 모르는 이미지는 막는다', () => {
  throws(() => checkUnits(parseText('$$\\frac{1}{$$'), { knownImage: () => true }), /수식/);
  throws(() => checkUnits(parseText('![](blsee://lib/images/zzzzzzzz)'), { knownImage: () => false }), /알 수 없는 이미지/);
});

test('계획: 같은 자리에 쓰는 write는 다음 차례로 미루고, edit은 이어진 블록끼리 묶는다', async () => {
  const { resolvePlan, planWaves } = await import('./waves');
  const { outline } = await import('@blog-helper/se-model');
  const doc = textDoc([{ type: 'text', lines: ['가'] }, { type: 'text', lines: ['나'] }, { type: 'image' }, { type: 'text', lines: ['다'] }]);
  const { refs, order } = setup(doc);
  const o = outline(doc, refs);
  const brief = { goal: '이어 쓴다' };
  const { planned, problems } = resolvePlan(
    [
      { title: '1', op: 'write', target: { uris: [order[1]], where: 'after' }, brief },
      { title: '2', op: 'write', target: { uris: [order[1]], where: 'after' }, brief },
      { title: '3', op: 'edit', target: { uris: [order[1], order[2], order[4]] }, instruction: '고친다' },
      { title: '4', op: 'insert', target: { uris: [order[4]], where: 'after' }, content: '---' },
    ],
    o,
  );
  deepStrictEqual(problems, []);
  deepStrictEqual(planned[2].units.map((u) => u.blocks), [[order[1], order[2]], [order[4]]]);
  const waves = planWaves(planned).map((w) => w.map((t) => t.task.title));
  // 1이 먼저, 같은 자리의 2는 1의 글을 본 뒤, 4는 같은 블록을 고치는 3과 순서를 지킨다.
  deepStrictEqual(waves[0], ['1']);
  ok(waves.findIndex((w) => w.includes('2')) > 0);
  ok(waves.findIndex((w) => w.includes('4')) >= waves.findIndex((w) => w.includes('3')));
});

test('계획: 필드가 빠지거나 영역이 이어지지 않으면 이유를 돌려준다', async () => {
  const { resolvePlan } = await import('./waves');
  const { outline } = await import('@blog-helper/se-model');
  const doc = textDoc([{ type: 'text', lines: ['가'] }, { type: 'text', lines: ['나'] }, { type: 'text', lines: ['다'] }]);
  const { refs, order } = setup(doc);
  const { problems } = resolvePlan(
    [
      { title: 'a', op: 'write', target: { uris: [order[1]], where: 'after' } },
      { title: 'b', op: 'insert', target: { uris: [order[1], order[3]], where: 'on' }, content: '새 글' },
      { title: 'c', op: 'set_layout', target: { uris: [order[1]] } },
      { title: 'd', op: 'insert', target: { uris: [order[1]], where: 'after' } },
    ],
    outline(doc, refs),
  );
  // 글 지시(brief)가 빠진 write는 반려하지 않고 작업 제목으로 채운다.
  equal(problems.length, 3);
  ok(problems[0].includes('이어진'));
  ok(problems[1].includes('layout'));
  ok(problems[2].includes('content와 from'));
});

test('계획: 빠진 brief·instruction은 작업 제목으로 채운다', async () => {
  const { resolvePlan } = await import('./waves');
  const { outline } = await import('@blog-helper/se-model');
  const doc = textDoc([{ type: 'text', lines: ['가'] }]);
  const { refs, order } = setup(doc);
  const { planned, problems } = resolvePlan(
    [
      { title: '이어 쓰기', op: 'write', target: { uris: [order[1]], where: 'after' } },
      { title: '오타 고치기', op: 'edit', target: { uris: [order[1]] } },
    ],
    outline(doc, refs),
  );
  deepStrictEqual(problems, []);
  equal(planned[0].task.brief?.goal, '이어 쓰기');
  equal(planned[1].task.instruction, '오타 고치기');
});

test('쓰기: 제목 없는 자리에 쓴 <title> 줄은 버리고, 검사는 이유를 알린다', async () => {
  const { dropStrayTitle } = await import('./blsee');
  const units = parseText('<title>애국가</title>\n동해 물과 백두산이');
  deepStrictEqual(dropStrayTitle(units, undefined).map((u) => u.t), ['p']);
  equal(dropStrayTitle(units, '<title>옛 제목</title>').length, 2);
  throws(() => checkUnits(units, { knownImage: () => true }), /<title> 줄은/);
});

test('실행: insert의 content와 from(이미지·블록 복사)을 편집 명령으로 만든다', async () => {
  const { resolvePlan } = await import('./waves');
  const { outline } = await import('@blog-helper/se-model');
  const { lastInserted } = await import('./blsee');
  const doc = textDoc([{ type: 'text', lines: ['가'] }, { type: 'text', lines: ['나'] }]);
  const { refs, order } = setup(doc);
  const { planned } = resolvePlan(
    [
      { title: 'a', op: 'insert', target: { uris: [order[1]], where: 'after' }, content: '## 소제목\n본문' },
      { title: 'b', op: 'insert', target: { uris: [order[2]], where: 'after' }, from: [order[1]] },
    ],
    outline(doc, refs),
  );
  const ops = planned.flatMap((t) => t.units.flatMap((u) => t.spec.build!(u, t.task)));
  const { document, messages } = apply(doc, refs, ops);
  deepStrictEqual(comps(document).map(ctype), ['documentTitle', 'text', 'sectionTitle', 'text', 'text', 'text']);
  ok(lastInserted(messages[0]));
  ok(lastInserted(messages[1]));
});

test('평가: 고쳐 본 뒤에도 같은 지적이면 반복으로 본다', async () => {
  const { repeatsIssues } = await import('./tools');
  const before = ['태극기의 건곤감리 괘 배열이 실제와 일치하지 않음', '태극 문양의 형태가 부자연스러움'];
  const now = ['태극기의 건곤감리 괘 순서와 모양을 실제 태극기 규격에 맞춰 정확하게 수정해야 합니다.', '태극 문양의 곡선 형태를 정확한 대칭과 색상 분할로 수정해야 합니다.'];
  ok(repeatsIssues(now, before));
  ok(!repeatsIssues(['제목 글자가 칸을 넘친다'], before));
  ok(!repeatsIssues(now, []));
});

test('쓰기: 모델이 쓴 마크다운 꾸밈(**, __, ~~, [](), ``)은 서식으로 바꾼다', () => {
  const [u] = parseText('**일본 - 기미가요** 와 ~~옛 이름~~ [위키](https://ko.wikipedia.org) `코드`');
  const runs = (u as { para: { runs: { text: string; bold?: boolean; strike?: boolean; link?: string }[] } }).para.runs;
  deepStrictEqual(runs.map((r) => r.text).join(''), '일본 - 기미가요 와 옛 이름 위키 코드');
  ok(runs.find((r) => r.text === '일본 - 기미가요')?.bold);
  ok(runs.find((r) => r.text === '옛 이름')?.strike);
  equal(runs.find((r) => r.text === '위키')?.link, 'https://ko.wikipedia.org');
});

test('왕복: 원래 글에 있던 ** 같은 기호는 다시 써도 글자 그대로 남는다', () => {
  const doc = textDoc([{ type: 'text', lines: ['별표 **두 개**와 a_b__c, `x`'] }]);
  const { refs, order } = setup(doc);
  const text = source(doc, refs, [order[1]]);
  const units = parseText(text);
  equal((units[0] as { para: { runs: { text: string }[] } }).para.runs.map((r) => r.text).join(''), '별표 **두 개**와 a_b__c, `x`');
  const { document } = apply(doc, refs, [writeOp(parseText(`${text}\n추가 줄`), { refs: [order[1]] })]);
  const first = (comps(document)[1].value as { nodes: { value: string }[] }[])[0];
  equal(first.nodes.map((n) => n.value).join(''), '별표 **두 개**와 a_b__c, `x`');
});

test('이미지 묶음: 한 줄의 이미지 2~3장은 새 묶음이 되고, 올린 뒤 같은 높이로 가로 비율을 맞춘다', () => {
  const doc = textDoc([{ type: 'text', lines: ['앞 글'] }]);
  const { refs, order } = setup(doc);
  const units = parseText('![바다](blsee://lib/images/aaaa1111) ![산](blsee://lib/images/bbbb2222)');
  deepStrictEqual(units.map((u) => u.t), ['strip']);
  checkUnits(units, { knownImage: () => true });
  const { document } = apply(doc, refs, [writeOp(units, { place: { after: order[1] } })]);
  const strip = comps(document)[2];
  equal(ctype(strip), 'imageStrip');
  const imgs = strip.images as SeComponent[];
  equal(imgs.length, 2);
  equal(imgs[0].widthPercentage, 50);
  // 올린 사진 크기로 가로 비율을 다시 맞춘다 (2:1 사진과 1:1 사진 → 2/3, 1/3).
  let filled = fillPendingImage(document, imgs[0].id, { id: 'x', '@ctype': 'image', width: 800, height: 400, src: 'a' });
  filled = fillPendingImage(filled, imgs[1].id, { id: 'y', '@ctype': 'image', width: 500, height: 500, src: 'b' });
  const fitted = comps(filled)[2].images as SeComponent[];
  equal(Math.round(Number(fitted[0].widthPercentage)), 67);
  equal(Math.round(Number(fitted[1].widthPercentage)), 33);
  ok(fitted.every((img) => img.width !== undefined));
  throws(() => parseText('![](blsee://lib/images/a1) ![](blsee://lib/images/a2) ![](blsee://lib/images/a3) ![](blsee://lib/images/a4)'), /3장까지/);
});

test('이미지 묶음: 읽은 묶음은 그대로 두고, 묶음 안 사진 한 장만 바꿀 수 있다', () => {
  const found = docs.find(({ doc }) => doc.document.components.some((c) => ctype(c) === 'imageStrip'));
  ok(found, 'test-data에 이미지 묶음이 있어야 한다');
  const doc = found.doc;
  const { refs } = setup(doc);
  const at = comps(doc).findIndex((c) => ctype(c) === 'imageStrip');
  const ref = refs.refOf(comps(doc)[at].id);
  const before = (comps(doc)[at].images as SeComponent[]).map((img) => img.id);
  const { document } = apply(doc, refs, [{ op: 'replace_image', target: `${ref}/image/2`, image: 'blsee://lib/images/cccc3333' }]);
  const after = comps(document)[at].images as SeComponent[];
  deepStrictEqual(after.map((img) => img.id), before);
  equal(after[0].src, (comps(doc)[at].images as SeComponent[])[0].src);
  ok(after[1][PENDING_IMAGE_KEY]);
});

test('점검: 번호를 항목으로 펼치고, [Review]는 줄로 보이며, replace는 못 찾으면 건너뛴다', async () => {
  const { expandReviewIds, reviewSection, nextReviewId } = await import('./review');
  const reviews = [
    {
      id: 'rv1',
      notes: ['맞춤법'],
      scope: '문서 전체',
      items: [
        { id: 'rv1-1', uri: 'blsee://block/2', note: 1, original: '안녕하세여', suggestion: '안녕하세요', reason: '오타' },
        { id: 'rv1-2', uri: 'blsee://block/3', note: 1, reason: '흐름이 끊긴다' },
      ],
    },
  ];
  deepStrictEqual(expandReviewIds(['rv1'], reviews).items.map((it) => it.id), ['rv1-1', 'rv1-2']);
  const one = expandReviewIds(['rv1-2', 'rv9-1'], reviews);
  deepStrictEqual(one.items.map((it) => it.id), ['rv1-2']);
  deepStrictEqual(one.unknown, ['rv9-1']);
  const section = reviewSection(reviews);
  ok(section.startsWith('[Review]') && section.includes('rv1-1 blsee://block/2 · "안녕하세여" → "안녕하세요"'));
  equal(nextReviewId(reviews), 'rv2');

  const doc = textDoc([{ type: 'text', lines: ['안녕하세여 반가워요'] }]);
  const { refs, order } = setup(doc);
  const { document, messages } = apply(doc, refs, [
    { op: 'replace_text', ref: order[1], find: '안녕하세여', replace: '안녕하세요', skipMissing: true },
    { op: 'replace_text', ref: order[1], find: '없는 글', replace: 'x', skipMissing: true },
  ]);
  ok(JSON.stringify(comps(document)[1].value).includes('안녕하세요'));
  ok(messages.some((m) => m.includes('건너뛰었습니다')));
});

test('도구를 글로 쓴 답: 호출 모양과 "동작:" 줄은 잡고, 보통 답은 그대로 둔다', async () => {
  const { wroteToolAsText } = await import('./tool-text');
  const { AIMessage, HumanMessage } = await import('langchain');
  const names = ['review', 'request_edit', 'read'];
  const said = (text: string) => [new HumanMessage('질문'), new AIMessage(text)];
  ok(wroteToolAsText(said('[review(notes: ["맞춤법"])] 점검하겠습니다.'), names));
  ok(wroteToolAsText(said('동작:\n- 문서 전체를 점검한다'), names));
  ok(wroteToolAsText(said('request_edit(request: "고친다")'), names));
  ok(!wroteToolAsText(said('12곳이 있어요. 고칠까요?'), names));
  ok(!wroteToolAsText(said('이 글을 다시 읽어(read) 보세요'), names));
});

test('패치: 화면에 보이는 글로 가리켜도 꾸밈 태그를 건너뛰고 찾는다', () => {
  const area = '<b>John Nagle</b>이라는 사람이 제안한 방법이고, 그의 이름을 따 만들어 졌습니다.';
  const out = applyPatches(area, [
    { old_string: 'John Nagle이라는 사람이 제안한 방법이고, 그의 이름을 따 만들어 졌습니다.', new_string: '<b>John Nagle</b>이라는 사람이 제안한 방법이고, 그의 이름을 따 만들어졌습니다.' },
  ]);
  equal(out, '<b>John Nagle</b>이라는 사람이 제안한 방법이고, 그의 이름을 따 만들어졌습니다.');
  throws(() => applyPatches(area, [{ old_string: '없는 글', new_string: 'x' }]), /찾지 못했다/);
});

test('왕복: 꾸밈이 바뀌기 직전의 끝 공백은 읽고 고쳐도 남는다', () => {
  const doc = textDoc([{ type: 'text', lines: ['x'] }]);
  const block = comps(doc)[1];
  (block.value as { nodes: unknown[] }[])[0].nodes = [
    { id: 'SE-n1', value: '따라서, ', '@ctype': 'textNode' },
    { id: 'SE-n2', value: '모든 것을 적용시키지 말고', style: { bold: true, '@ctype': 'nodeStyle' }, '@ctype': 'textNode' },
  ];
  const { refs, order } = setup(doc);
  const src = source(doc, refs, [order[1]]);
  ok(src.includes('따라서, <b>모든'), src);
  const { document } = apply(doc, refs, [writeOp(parseText(src.replace('적용시키지', '적용하지')), { refs: [order[1]] })]);
  const nodes = (comps(document)[1].value as { nodes: { value: string }[] }[])[0].nodes.map((n) => n.value);
  deepStrictEqual(nodes, ['따라서, ', '모든 것을 적용하지 말고']);
});

test('점검: 원래 글이 다른 블록에 있으면 위치를 바로잡고, 어디에도 없으면 버린다', async () => {
  const { blockTexts, placeFindings } = await import('./review');
  const read = 'blsee://block/2 <문단 1>\n이번 환경설정 방법\n\nblsee://block/9 <문단 5>\n이 자료는 <b>Microsoft</b>사의 답변을 참고했습니다.';
  const texts = blockTexts(read);
  const out = placeFindings(
    [
      { uri: 'blsee://block/2', original: '이 자료는 Microsoft사의 답변' },
      { uri: 'blsee://block/2', original: '이번 환경설정' },
      { uri: 'blsee://block/2', original: '없는 글' },
      { uri: 'blsee://block/2' },
    ],
    texts,
  );
  deepStrictEqual(out.map((f) => f.uri), ['blsee://block/9', 'blsee://block/2', 'blsee://block/2']);
});

test('패치: 건너뛰기를 주면 맞지 않는 패치만 빼고 나머지를 적용한다', () => {
  const skipped: string[] = [];
  const out = applyPatches(
    '가나다 라마바',
    [
      { old_string: '가나다', new_string: '가나 다' },
      { old_string: '없는 글', new_string: 'x' },
      { old_string: '라마바', new_string: '라마 바' },
    ],
    skipped,
  );
  equal(out, '가나 다 라마 바');
  equal(skipped.length, 1);
  ok(skipped[0].startsWith('2번째 패치'));
});

test('프롬프트 칸: 가리킨 자리에만 칸을 넣고, 원문의 다른 글은 그대로 둔다', async () => {
  const { applySlots, fillSlot } = await import('./save-prompt');
  deepStrictEqual(fillSlot('제주 여행 3일차', 'place', '제주 여행', '제주'), { body: '{{place}} 여행 3일차' });
  ok('error' in fillSlot('여행\n여행', '여행지', '여행', ''), '여러 곳에 맞으면 넣지 않는다');
  deepStrictEqual(fillSlot('캐릭터 이름: 이 있으면 넣는다.\n캐릭터 이름:', '캐릭터 이름', '캐릭터 이름:', ''), { body: '캐릭터 이름: 이 있으면 넣는다.\n캐릭터 이름: {{캐릭터 이름}}' }, '값이 빈 자리는 줄 끝인 곳');
  ok('error' in fillSlot('제주 여행', '여행지', '제주 여행', '부산'), '조각에 없는 값이면 넣지 않는다');
  const body = '첨부된 이미지를 참고한다.\n그 이름을 손글씨로 넣는다 ({{메모}}).\n캐릭터 이름:';
  const errors: string[] = [];
  const out = applySlots(
    body,
    [
      { name: 'Character Name', anchor: '캐릭터 이름:', value: '' },
      { name: 'character-name', anchor: '이름을 손글씨로', value: '이름' },
      { name: 'image', anchor: '없는 글', value: '' },
    ],
    errors,
  );
  equal(out.body, '첨부된 이미지를 참고한다.\n그 {{character-name}}을 손글씨로 넣는다 ({{메모}}).\n캐릭터 이름: {{character-name}}');
  deepStrictEqual(out.params.map((p) => p.name), ['character-name', '메모'], '같은 이름은 칸 하나');
  equal(errors.length, 1);
});

test('구체화 입력: 사용자 메시지에 [Metadata] 번호를 붙이고, 마지막 사용자 메시지 뒤 도구 호출은 뺀다', async () => {
  const { AIMessage, HumanMessage, ToolMessage } = await import('langchain');
  const { historyMessages, userRequestsOf, withMetadata } = await import('./messages');
  const history = [
    { id: 'a', role: 'user' as const, text: '바다 그림 그려 줘. 사람 없이.' },
    { id: 'b', role: 'assistant' as const, text: '넣었어요.' },
  ];
  const requests = userRequestsOf(history, 'c', '다시 해 줘');
  const current = new HumanMessage({ id: 'c', content: '다시 해 줘' });
  const call = new AIMessage({ content: '', tool_calls: [{ id: 't1', name: 'make_image', args: {} }] });
  const messages = [...historyMessages(history), current, call];
  const out = withMetadata(messages, requests);
  equal(out.length, 3, '마지막 사용자 메시지 뒤는 뺀다');
  ok(String(out[0].content).endsWith('[Metadata]\nid: 1'));
  ok(String(out[2].content).endsWith('[Metadata]\nid: 2'));
  ok(!String(messages[0].content).includes('[Metadata]'), '원래 메시지는 그대로');
  equal(requests.textOf.get(1), '바다 그림 그려 줘. 사람 없이.');
  void ToolMessage;
});
