/**
 * 문서 점검(review). 대화 담당의 review 도구가 부르는 별도 노드다. 문서를 고치지 않고 읽기만 한다.
 *
 *  ① 나누기: 글 조각(소제목 경계 + 글자 수 상한), 이어진 사진 범위(블록 경계에서 높이 상한)
 *  ② 병렬 점검: 모든 단위에 점검 사항(notes)을 다 넘기고, 단위가 판단할 수 있는 것만 지적한다
 *     - 글 조각 → 지적 + 확인할 주장(claims)
 *     - 사진 범위 → 블록을 그린 그림 + 위에서부터의 순서 + 앞뒤 글
 *     - 전체 → 섹션을 넘는 문제만 (조각이 둘 이상일 때)
 *  ③ 사실 확인: 주장을 모아 검색하고 판정한다
 *  ④ 합치기: 범위 밖·중복 지적을 거르고 문서 순서로 번호를 붙인다
 *
 * 결과는 대화 상태에 남고(편집이 반영되면 만료), 계획 담당은 번호로 받아 고친다.
 */
import { HumanMessage, SystemMessage, tool } from 'langchain';
import { z } from 'zod';
import { expandUri, outlineRefs, outlineTypes } from '@blog-helper/se-model';
import type { ReviewItem, ReviewResult, ViewImages } from '@blog-helper/shared';
import { chatModel, config } from '../config';
import { keyCheckOff } from '../keys';
import { webSearch } from '../search';
import { usageCallback, type UsageMeter } from '../usage';
import { REVIEW_CLAIMS_PROMPT, REVIEW_IMAGES_PROMPT, REVIEW_TEXT_PROMPT, REVIEW_WHOLE_PROMPT } from './prompt';
import { docUri } from './schemas';
import type { CallDocTool, NotifyStep } from './tools';

/** 글 조각 하나의 글자 수 상한 */
const CHUNK_CHARS = 2500;
/** 사진 범위 한 번에 보는 그림 높이 상한 (px) */
const IMAGE_HEIGHT = 2400;
/** 동시에 부르는 점검 수 */
const CONCURRENCY = 5;
/** 한 번에 그리는 블록 수 (확장의 render_view 상한) */
const RENDER_BATCH = 10;
/** 사실 확인할 주장 수 상한, 검색 한 번에 묶는 주장 수 */
const CLAIMS_MAX = 12;
const CLAIMS_PER_SEARCH = 4;
/** [Review]에 줄로 넣는 항목 수 상한 */
const SECTION_ITEMS_MAX = 50;

export const REVIEW_KINDS = ['문단', '소제목', '인용구', '표', '이미지', '수식', '코드'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

const KIND_OF: Record<string, ReviewKind> = {
  documentTitle: '문단',
  text: '문단',
  wrappingParagraph: '문단',
  sectionTitle: '소제목',
  quotation: '인용구',
  table: '표',
  image: '이미지',
  imageStrip: '이미지',
  formula: '수식',
  code: '코드',
};

export interface ReviewArgs {
  notes: string[];
  ranges?: string[];
  kinds?: ReviewKind[];
}

export interface ReviewDeps {
  call: CallDocTool;
  meter: UsageMeter;
  notify: NotifyStep;
  signal?: AbortSignal;
}

function log(tag: string, detail: string) {
  if (keyCheckOff()) console.log(`[review] ${tag}\n${detail}`);
}

/* ---------- 모델 출력 ---------- */

const findingSchema = z.object({
  note: z.number().int().min(1).describe('몇 번째 점검 사항에서 나온 지적인지 (1부터)'),
  uri: z.string().describe('지적한 곳: 블록 URI(blsee://block/N), 사진이면 사진 URI(blsee://block/N/image…)'),
  original: z
    .string()
    .optional()
    .describe('고칠 곳의 원래 글. 블록에 보이는 글 그대로 (꾸밈 태그·마크다운 기호 없이), 블록 안에서 한 곳에만 맞게 앞뒤 글자를 넣는다'),
  suggestion: z.string().optional().describe('바꿀 글. 정해지지 않으면 (흐름·보강·사진 교체 등) 비운다'),
  reason: z.string().min(1).describe('왜 고쳐야 하는지 한 줄'),
});

const unitSchema = z.object({
  findings: z.array(findingSchema).describe('지적 목록. 찾은 것이 없으면 빈 목록'),
  claims: z
    .array(
      z.object({
        note: z.number().int().min(1).describe('몇 번째 점검 사항 때문에 확인하는지'),
        uri: z.string().describe('주장이 있는 블록 URI'),
        original: z.string().describe('주장이 담긴 원래 글 그대로 (블록에 보이는 글)'),
        claim: z.string().describe('검색으로 확인할 사실 (예: "성산일출봉 입장료는 5,000원이다")'),
      }),
    )
    .optional()
    .describe('사실을 확인하라는 점검 사항이 있을 때, 지금 정보와 맞는지 검색으로 확인할 날짜·가격·시간·수치·고유 정보'),
  skipped: z.array(z.number().int().min(1)).optional().describe('이 범위만으로는 판단할 수 없어 건너뛴 점검 사항 번호'),
});

const claimsSchema = z.object({
  findings: z.array(findingSchema).describe('검색 결과와 다른 주장만 지적한다. 고칠 글은 검색으로 확인한 값으로 쓴다'),
});

type Finding = z.infer<typeof findingSchema>;
type Claim = NonNullable<z.infer<typeof unitSchema>['claims']>[number];

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: string };

async function askModel<T>(d: ReviewDeps, schema: z.ZodType<T>, system: string, content: Part[] | string): Promise<T> {
  const model = chatModel('review').withStructuredOutput(schema);
  const run = () =>
    model.invoke([new SystemMessage(system), new HumanMessage({ content })], {
      signal: d.signal,
      callbacks: [usageCallback(d.meter, config.review.model, 'review')],
    }) as Promise<T>;
  try {
    return await run();
  } catch (err) {
    if (d.signal?.aborted) throw err;
    return run();
  }
}

/** 동시 실행 수를 지키며 차례로 돌린다. 실패는 결과에 담는다. */
async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<PromiseSettledResult<T>[]> {
  const out: PromiseSettledResult<T>[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      try {
        out[i] = { status: 'fulfilled', value: await jobs[i]() };
      } catch (reason) {
        out[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
}

/* ---------- 나누기 ---------- */

interface BlockInfo {
  ref: string;
  ctype: string;
  chars: number;
  /** 블록 안 사진 URI */
  images: string[];
  line: string;
}

function readOutline(outline: string): Map<string, BlockInfo> {
  const types = outlineTypes(outline);
  const out = new Map<string, BlockInfo>();
  for (const line of outline.split('\n')) {
    const ref = /^(blsee:\/\/block\/\d+) /.exec(line)?.[1];
    if (!ref) continue;
    out.set(ref, {
      ref,
      ctype: types.get(ref) ?? '',
      chars: Number(/ (\d+)자/.exec(line)?.[1] ?? 0),
      images: [...line.matchAll(/blsee:\/\/block\/\d+\/image(?:\/\d+)?/g)].map((m) => m[0]),
      line,
    });
  }
  return out;
}

/** 범위 안 블록을 소제목 경계와 글자 수 상한으로 나눈다. */
function textChunks(blocks: BlockInfo[]): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const b of blocks) {
    if (cur.length && (b.ctype === 'sectionTitle' || chars + b.chars > CHUNK_CHARS)) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(b.ref);
    chars += b.chars;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** 사이에 글 없이 이어진 사진 블록들. 빈 문단·구분선은 사이에 있어도 이어진 것으로 본다. */
function imageRuns(order: string[], selected: Set<string>, info: Map<string, BlockInfo>): string[][] {
  const runs: string[][] = [];
  let cur: string[] = [];
  for (const ref of order) {
    const b = info.get(ref);
    if (!b) continue;
    const isImage = KIND_OF[b.ctype] === '이미지';
    if (isImage && selected.has(ref)) {
      cur.push(ref);
      continue;
    }
    const gap = b.ctype === 'horizontalLine' || (b.ctype === 'text' && b.chars === 0);
    if (!gap && cur.length) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);
  return runs;
}

/** PNG 높이 (IHDR). 읽을 수 없으면 상한의 절반으로 본다. */
function pngHeight(base64: string): number {
  const head = Buffer.from(base64.slice(0, 64), 'base64');
  if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47) return head.readUInt32BE(20);
  return IMAGE_HEIGHT / 2;
}

/** 읽기 결과(블록 머리줄 + 본문)를 블록별 보이는 글로 나눈다. 원래 글이 그 블록에 있는지 확인할 때 쓴다. */
export function blockTexts(read: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = read.split(/^(blsee:\/\/block\/\d+) .*$/m);
  for (let i = 1; i + 1 < parts.length; i += 2) out.set(parts[i], visible(parts[i + 1]));
  return out;
}

/** 보이는 글: 태그를 빼고, 엔티티를 풀고, 공백을 하나로 */
const visible = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

/**
 * 원래 글이 가리킨 블록에 실제로 있는지 본다. 없으면 읽은 다른 블록에서 한 곳에만 있으면 그 블록으로 바로잡고,
 * 찾지 못하면 버린다 (모델이 위치를 잘못 적은 지적). 원래 글이 없는 지적(흐름 등)과 사진 지적은 그대로 둔다.
 */
export function placeFindings<T extends { uri: string; original?: string }>(findings: T[], texts: Map<string, string>): T[] {
  return findings.flatMap((f) => {
    if (!f.original || /\/image/.test(f.uri) || !texts.size) return [f];
    const want = visible(f.original).trim();
    const block = /^blsee:\/\/block\/\d+/.exec(f.uri)?.[0] ?? '';
    if (texts.get(block)?.includes(want)) return [f];
    const hits = [...texts].filter(([, t]) => t.includes(want)).map(([ref]) => ref);
    return hits.length === 1 ? [{ ...f, uri: hits[0] }] : [];
  });
}

/* ---------- 점검 ---------- */

const numbered = (lines: string[]) => lines.map((s, i) => `${i + 1}. ${s}`).join('\n');

interface UnitOutcome {
  findings: Finding[];
  claims: Claim[];
}

export async function runReview(d: ReviewDeps, args: ReviewArgs, id: string): Promise<ReviewResult> {
  const notes = args.notes.map((n) => n.trim()).filter(Boolean);
  const outline = await d.call('get_outline', {});
  const order = outlineRefs(outline);
  const info = readOutline(outline);
  const ranged = args.ranges?.length ? new Set(args.ranges.flatMap((u) => expandUri(u, order))) : new Set(order);
  const kinds = new Set<ReviewKind>(args.kinds?.length ? args.kinds : REVIEW_KINDS.filter((k) => k !== '이미지'));
  const selected = new Set(order.filter((ref) => ranged.has(ref) && kinds.has(KIND_OF[info.get(ref)?.ctype ?? ''])));
  const textBlocks = order.filter((ref) => selected.has(ref) && KIND_OF[info.get(ref)!.ctype] !== '이미지').map((ref) => info.get(ref)!);
  const chunks = textChunks(textBlocks);
  const runs = kinds.has('이미지') ? imageRuns(order, selected, info) : [];
  const scope = args.ranges?.length ? args.ranges.join(', ') : '문서 전체';
  const headings = [...info.values()].filter((b) => b.ctype === 'documentTitle' || b.ctype === 'sectionTitle').map((b) => b.line).join('\n');
  const notesText = `[점검 사항]\n${numbered(notes)}`;

  d.notify(true, `문서 점검: 글 ${chunks.length}조각${runs.length ? `, 사진 ${runs.length}묶음` : ''}`);
  log('start', `${id} notes=${notes.length} chunks=${chunks.length} runs=${runs.length} scope=${scope}`);

  /** 범위 앞뒤의 글 (읽기 전용 맥락) */
  const around = async (first: string, last: string): Promise<string> => {
    const prev = order[order.indexOf(first) - 1];
    const next = order[order.indexOf(last) + 1];
    const refs = [prev, next].filter(Boolean);
    return refs.length ? d.call('read_blocks', { uris: refs }) : '';
  };

  const chunkTexts: string[] = new Array(chunks.length).fill('');
  const missed: string[] = [];
  type Job = { label: string; run: () => Promise<UnitOutcome> };
  const jobs: Job[] = [];

  chunks.forEach((chunk, i) => {
    jobs.push({
      label: `${chunk[0]} 부근 글`,
      run: async () => {
        const [text, ctx] = await Promise.all([d.call('read_blocks', { uris: chunk }), around(chunk[0], chunk[chunk.length - 1])]);
        chunkTexts[i] = text;
        const out = await askModel(d, unitSchema, REVIEW_TEXT_PROMPT, [
          notesText,
          `[점검할 글]\n${text}`,
          ctx ? `[앞뒤 글] (읽기 전용, 지적하지 않는다)\n${ctx}` : '',
          headings ? `[글 제목·소제목]\n${headings}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'));
        return { findings: out.findings, claims: out.claims ?? [] };
      },
    });
  });

  // 사진: 블록을 하나씩 그려 높이 상한까지 묶고, 묶음마다 한 번 본다.
  for (const run of runs) {
    jobs.push({
      label: `${run[0]} 부근 사진`,
      run: async () => {
        const drawn: ViewImages['images'] = [];
        for (let i = 0; i < run.length; i += RENDER_BATCH) {
          const view = JSON.parse(await d.call('render_view', { targets: run.slice(i, i + RENDER_BATCH), perBlock: true })) as ViewImages;
          drawn.push(...view.images);
        }
        const groups: (typeof drawn)[] = [];
        let cur: typeof drawn = [];
        let height = 0;
        for (const img of drawn) {
          const h = pngHeight(img.data);
          if (cur.length && height + h > IMAGE_HEIGHT) {
            groups.push(cur);
            cur = [];
            height = 0;
          }
          cur.push(img);
          height += h;
        }
        if (cur.length) groups.push(cur);
        const ctx = await around(run[0], run[run.length - 1]);
        const results = await Promise.all(
          groups.map((group, g) => {
            const refs = [...new Set(group.map((img) => img.label))];
            const orderText = refs
              .map((ref, k) => `${k + 1}. ${ref} (사진: ${(info.get(ref)?.images ?? []).join(', ') || ref})`)
              .join('\n');
            const parts: Part[] = [
              {
                type: 'text',
                text: [
                  notesText,
                  `[점검할 사진] 이어진 사진 ${groups.length > 1 ? `묶음 ${g + 1}/${groups.length}` : ''}을 글에 보이는 모습으로 그린 그림이다. 위에서부터:\n${orderText}`,
                  ctx ? `[앞뒤 글] (읽기 전용)\n${ctx}` : '',
                ]
                  .filter(Boolean)
                  .join('\n\n'),
              },
              ...group.map((img) => ({ type: 'image_url' as const, image_url: `data:${img.mimeType};base64,${img.data}` })),
            ];
            return askModel(d, unitSchema, REVIEW_IMAGES_PROMPT, parts);
          }),
        );
        return { findings: results.flatMap((r) => r.findings), claims: [] };
      },
    });
  }

  const settled = await pool(
    jobs.map((j) => j.run),
    CONCURRENCY,
  );
  const findings: Finding[] = [];
  const claims: Claim[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      findings.push(...r.value.findings);
      claims.push(...r.value.claims);
    } else {
      if (d.signal?.aborted) throw r.reason;
      missed.push(`${jobs[i].label}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  });

  // 전체: 조각이 둘 이상이면 섹션을 넘는 문제만 한 번 본다.
  const later: Promise<void>[] = [];
  if (chunks.length > 1) {
    later.push(
      askModel(d, unitSchema, REVIEW_WHOLE_PROMPT, `${notesText}\n\n[글 전체]\n${chunkTexts.filter(Boolean).join('\n\n')}`).then(
        (out) => void findings.push(...out.findings),
        (err) => {
          if (d.signal?.aborted) throw err;
          missed.push(`전체 흐름 점검: ${err instanceof Error ? err.message : String(err)}`);
        },
      ),
    );
  }

  // 사실: 주장을 모아 검색하고 판정한다.
  const uniqueClaims = [...new Map(claims.map((c) => [c.claim.trim(), c])).values()].slice(0, CLAIMS_MAX);
  if (uniqueClaims.length) {
    later.push(
      (async () => {
        d.notify(true, `사실 확인: 주장 ${uniqueClaims.length}개`);
        const groups: Claim[][] = [];
        for (let i = 0; i < uniqueClaims.length; i += CLAIMS_PER_SEARCH) groups.push(uniqueClaims.slice(i, i + CLAIMS_PER_SEARCH));
        const searched = await Promise.all(
          groups.map(async (g) => {
            const query = `다음 정보가 지금도 맞는지 확인: ${g.map((c) => c.claim).join(' / ')}`;
            try {
              return `[검색: ${query}]\n${await webSearch(query, d.meter)}`;
            } catch (err) {
              return `[검색 실패: ${query}] ${err instanceof Error ? err.message : String(err)}`;
            }
          }),
        );
        const claimList = uniqueClaims.map((c, i) => `${i + 1}. (점검 ${c.note}) ${c.uri} · "${c.original}" — ${c.claim}`).join('\n');
        const out = await askModel(
          d,
          claimsSchema,
          REVIEW_CLAIMS_PROMPT,
          `${notesText}\n\n[확인할 주장]\n${claimList}\n\n[검색 결과]\n${searched.join('\n\n')}`,
        );
        findings.push(...out.findings);
      })().catch((err) => {
        if (d.signal?.aborted) throw err;
        missed.push(`사실 확인: ${err instanceof Error ? err.message : String(err)}`);
      }),
    );
  }
  await Promise.all(later);

  // 원래 글로 위치를 확인·바로잡는다 (읽은 글 조각 기준).
  const texts = blockTexts(chunkTexts.join('\n\n'));
  const placed = placeFindings(findings, texts);
  if (placed.length < findings.length) log('place', `위치를 확인하지 못해 버린 지적 ${findings.length - placed.length}개`);
  findings.length = 0;
  findings.push(...placed);

  // 합치기: 범위 밖·번호 밖·중복을 거르고 문서 순서로 번호를 붙인다.
  const blockOf = (uri: string) => /^blsee:\/\/block\/\d+/.exec(uri)?.[0] ?? '';
  const seen = new Set<string>();
  const kept = findings
    .filter((f) => f.note >= 1 && f.note <= notes.length && ranged.has(blockOf(f.uri)))
    .filter((f) => {
      const key = `${f.uri}|${f.original ?? ''}|${f.suggestion ?? ''}|${f.original ? '' : f.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter((f) => !(f.original && f.suggestion !== undefined && f.original === f.suggestion))
    .sort((a, b) => order.indexOf(blockOf(a.uri)) - order.indexOf(blockOf(b.uri)) || a.note - b.note);
  const items: ReviewItem[] = kept.map((f, i) => ({
    id: `${id}-${i + 1}`,
    uri: f.uri,
    note: f.note,
    ...(f.original ? { original: f.original } : {}),
    ...(f.original && f.suggestion !== undefined ? { suggestion: f.suggestion } : {}),
    reason: f.reason,
  }));
  log('done', `${id} items=${items.length} missed=${missed.length}`);
  return { id, notes, scope, items, ...(missed.length ? { missed } : {}) };
}

/* ---------- 보고·상태 ---------- */

const itemLine = (it: ReviewItem, withReason: boolean) => {
  const change = it.original
    ? it.suggestion !== undefined
      ? `"${it.original}" → "${it.suggestion}"`
      : `"${it.original}" (고칠 글 없음)`
    : '(고칠 글 없음)';
  return `- ${it.id} ${it.uri} · ${change}${withReason || it.suggestion === undefined ? ` · ${it.reason}` : ''}`;
};

/** 대화 담당에게 돌려주는 점검 결과 (도구 결과) */
export function reviewReport(r: ReviewResult): string {
  const sections = r.notes.map((note, i) => {
    const items = r.items.filter((it) => it.note === i + 1);
    return `[점검 ${i + 1}: ${note}]\n${items.length ? items.map((it) => itemLine(it, true)).join('\n') : '찾은 것 없음'}`;
  });
  const fixable = r.items.filter((it) => it.suggestion !== undefined).length;
  return [
    `점검 결과 ${r.id} (범위: ${r.scope}) — ${r.items.length}개 (고칠 글이 정해진 것 ${fixable}개)`,
    ...sections,
    r.missed?.length ? `점검하지 못한 곳:\n${r.missed.map((m) => `- ${m}`).join('\n')}` : '',
    r.items.length ? `고치려면 편집을 넘길 때 점검 번호(${r.id})나 항목 번호(${r.id}-1 …)를 함께 넘긴다.` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** 마지막 사용자 메시지에 붙이는 [Review]: 아직 만료되지 않은 점검 결과 */
export function reviewSection(reviews: ReviewResult[]): string {
  if (!reviews.length) return '';
  let budget = SECTION_ITEMS_MAX;
  const blocks = reviews.map((r) => {
    const shown = r.items.slice(0, Math.max(0, budget));
    budget -= shown.length;
    const rest = r.items.length - shown.length;
    return [
      `${r.id} (${r.notes.join(' / ')}; 범위: ${r.scope}) — ${r.items.length}개`,
      ...shown.map((it) => itemLine(it, false)),
      rest > 0 ? `(그 밖 ${rest}개. 번호로 가리키면 서버가 펼쳐 넘긴다)` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
  return `[Review]\n${blocks.join('\n\n')}`;
}

/** request_edit의 reviews(점검 번호 또는 항목 번호)를 항목으로 펼친다. 모르는 번호는 따로 돌려준다. */
export function expandReviewIds(ids: string[], reviews: ReviewResult[]): { items: ReviewItem[]; unknown: string[] } {
  const items: ReviewItem[] = [];
  const unknown: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    const whole = reviews.find((r) => r.id === id);
    if (whole) {
      items.push(...whole.items);
      continue;
    }
    const one = reviews.flatMap((r) => r.items).find((it) => it.id === id);
    if (one) items.push(one);
    else unknown.push(id);
  }
  return { items: [...new Map(items.map((it) => [it.id, it])).values()], unknown };
}

/** 계획 담당 [Instruction]에 넣는 점검 항목 원문 */
export function reviewItemsText(items: ReviewItem[]): string {
  return items
    .map((it) => {
      const lines = [`- ${it.id} ${it.uri}`];
      if (it.original !== undefined) lines.push(`  원래 글: ${JSON.stringify(it.original)}`);
      if (it.suggestion !== undefined) lines.push(`  고칠 글: ${JSON.stringify(it.suggestion)}`);
      lines.push(`  이유: ${it.reason}`);
      return lines.join('\n');
    })
    .join('\n');
}

/** 다음 점검 번호 (rv1, rv2 …) */
export function nextReviewId(reviews: ReviewResult[]): string {
  const max = reviews.reduce((m, r) => Math.max(m, Number(/^rv(\d+)$/.exec(r.id)?.[1] ?? 0)), 0);
  return `rv${max + 1}`;
}

/** 대화 담당의 review 도구. 결과는 상태(reviews)에 더하고 onReview로 알린다. */
export function createReviewTool(o: ReviewDeps & { reviews: ReviewResult[]; onReview?: (r: ReviewResult) => void }) {
  return tool(
    async (args: ReviewArgs) => {
      try {
        const result = await runReview(o, args, nextReviewId(o.reviews));
        o.reviews.push(result);
        o.onReview?.(result);
        return reviewReport(result);
      } catch (err) {
        if (o.signal?.aborted) throw err;
        return `실패: 점검하지 못했다. ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: 'review',
      description:
        '문서를 점검한다 (고치지 않는다). 범위를 섹션 조각으로 나눠 병렬로 보고, 점검 사항마다 찾은 곳을 번호 붙은 목록으로 돌려준다. ' +
        '고칠 글이 정해진 항목은 "원래 글 → 고칠 글"로 나온다. 결과는 다음 요청에도 [Review]로 남고, 편집이 반영되면 만료된다.',
      schema: z.object({
        notes: z
          .array(z.string().min(1))
          .min(1)
          .describe('점검 사항. 무엇을 어떤 기준으로 볼지 한 줄씩, 사용자 말에 가깝게 (예: "맞춤법·띄어쓰기", "가격·영업시간이 지금 정보와 맞는지", "존댓말(~요체)로 통일됐는지")'),
        ranges: z
          .array(docUri)
          .optional()
          .describe('볼 범위 (blsee://block?from=3&to=8 같은 범위 URI, 블록 URI도 된다). 없으면 문서 전체'),
        kinds: z
          .array(z.enum(REVIEW_KINDS))
          .optional()
          .describe('볼 블록 종류. 없으면 이미지를 뺀 글 종류 전부. 사진을 볼 점검 사항이 있으면 "이미지"를 넣는다'),
      }),
    },
  );
}
