import { AIMessage, createAgent, HumanMessage, SystemMessage, tool, toolStrategy, type BaseMessage } from 'langchain';
import { z } from 'zod';
import { askAnswerSchema, type AskAnswer, type AskRequest } from '@blog-helper/shared';
import { chatModel, config } from '../config';
import {
  fetchFont,
  fontSizeLabel,
  hasWebFontDirectives,
  resolveWebFontFiles,
  stripWebFontDirectives,
} from '../font';
import { keyCheckOff } from '../keys';
import { usageCallback, type UsageMeter } from '../usage';
import { checkHtml, HTML_RULES } from './diagram';
import { requestPixelForInfographic } from './image-cycle';
import { TOOL_AS_TEXT_FIX, wroteToolAsText } from './tool-text';
import { seedMessage } from './seed-input';
import { concretizeBrief, concretizeScene } from './concretize';
import type { UserRequests } from './messages';
import { parentMessagesFromRuntime } from './parent-messages';
import { INFOGRAPHIC_FETCH_PROMPT, INFOGRAPHIC_JUDGE_PROMPT, INFOGRAPHIC_WRITE_PROMPT } from './prompt';
import { docUri } from './schemas';
import {
  MADE,
  RESULT_NOTE,
  createImageSupportTools,
  createReadTool,
  failText,
  nameField,
  cachedImageCall,
  toImageUri,
  type CallDocTool,
  type FoundImages,
  type NotifyStep,
  repeatsIssues,
  reviewWithUser,
} from './tools';

/*
 * 인포그래픽 서브그래프: make(전문 재작성) / fetch(구간 패치) / judge(평가) 사이클.
 * 최종 산출은 항상 새 HTML 파일 + PNG URI 하나.
 */

const WRITE_RECURSION = 16;
const FETCH_RECURSION = 24;
const JUDGE_MAX = 3;
/** 사용자가 고칠 점을 적어 상한을 넘겨 더 고치는 횟수 */
const USER_ROUNDS_MAX = 2;
const INSTRUCTIONS_MAX = 8;
const SOURCES_MAX = 6;
const REFS_MAX = 3;
const LABEL_CHARS = 30;

/** make_infographic original: lib 이미지·HTML·글의 블록(이미지) */
const BASE_URI_RE =
  /^blsee:\/\/(?:lib\/(?:images|html)\/[a-z0-9]+|block\/\d+(?:\/image(?:\/\d+)?)?)$/;

export interface InfographicArgs {
  instructions: string[];
  /** 사용자가 직접 적은 지시 원문 (구체화가 고른 메시지). 쓰기·고치기·판정이 함께 본다 */
  requests?: string[];
  sources?: string[];
  context: string;
  refs?: { uri: string; role: string }[];
  /** 고칠 인포 (blsee://lib/images/…, blsee://lib/infographics/…, blsee://block/N[/image]) */
  /** 고칠 인포그래픽 URI. 없으면 새로 만든다 */
  original?: string;
  name?: string;
}

export interface InfographicDeps {
  call: CallDocTool;
  meter: UsageMeter;
  notify: NotifyStep;
  locale: string;
  /** 이번 턴에서 가리킨 인포그래픽 파일 (blsee://lib/infographics/…) */
  pointed?: string[];
  /** 글꼴 받기 전 사용자 확인 */
  ask: (req: AskRequest) => Promise<AskAnswer>;
  signal?: AbortSignal;
  /** 사용자 메시지 번호와 원문 (구체화가 고른다) */
  requests?: UserRequests;
}

const writeSchema = z.object({
  width: z.number().describe('그림 폭(px)'),
  html: z.string().min(1).describe('완성한 인포그래픽 HTML 전문'),
});

const fetchDoneSchema = z.object({
  width: z.number().optional().describe('그림 폭(px). 폭을 바꿀 때만'),
});

const judgeSchema = z.object({
  checks: z
    .array(z.string())
    .describe('지시 항목마다 [Result]에 "담김", "빠짐", "틀림" 가운데 하나와 근거 한 줄. 개수가 정해진 지시면 그림의 항목 수를 센다. 글자 잘림·겹침·넘침, 읽기 어려운 작은 글자도 적는다'),
  action: z
    .enum(['done', 'fetch', 'make', 'ask'])
    .describe(
      'done: 작업이 다 되었고 어색한 곳이 없다 / ask: 어색하거나 부족한 곳이 있지만 크지 않다 (사용자에게 이대로 쓸지 묻는다) / ' +
        'fetch: 요청이 제대로 반영되지 않아 지금 HTML에 더 반영해야 한다 / make: 요청과 완전히 다른 것이 나왔다',
    ),
  issues: z.array(z.string()).describe('done이 아니면 어색하거나 부족한 곳, 더 반영할 점 1~3개를 구체적으로 (done이면 빈 목록)'),
  message: z
    .string()
    .describe('계획 담당에게 전할 말. ask면 사용자에게 보일 남은 문제를 짧게. 시각화할 내용이 없으면 무엇이 필요한지'),
});

type FetchState = { html: string; width: number };
const clip = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > LABEL_CHARS ? `${t.slice(0, LABEL_CHARS)}…` : t;
};

function log(tag: string, detail: string) {
  if (keyCheckOff()) console.log(`[infographic-agent] ${tag}\n${detail}`);
}

/** 실패 원인 추적용: HTML 앞·뒤를 짧게 남긴다. */
function clipHtml(html: string, head = 400, tail = 200): string {
  const t = html.replace(/\s+/g, ' ').trim();
  if (t.length <= head + tail + 20) return t;
  return `${t.slice(0, head)} …(${t.length}자)… ${t.slice(-tail)}`;
}

/**
 * 쓰기·고치기 모델 입력: [인포그래픽] 지시 → [Original](고칠 때, 렌더한 그림 포함) → [Context](맥락·재료 글·현재 HTML) → [References]
 */
function infoSeed(
  a: InfographicArgs,
  d: InfographicDeps,
  material: string,
  round: { original?: string; html?: string; issues: string[]; previous?: string },
) {
  return seedMessage(d.call, {
    head: '인포그래픽',
    instructions: a.instructions,
    requests: a.requests,
    issues: round.issues,
    original: round.original ? { uri: round.original } : undefined,
    context: [a.context, material && `재료 글:\n${material}`, round.html !== undefined ? `현재 HTML:\n${round.html}` : ''],
    references: [
      ...(a.refs ?? []).map((r) => ({ uri: toImageUri(r.uri), role: r.role })),
      ...(d.pointed ?? []).map((uri) => ({ uri, role: '가리킨 인포그래픽' })),
      ...(round.previous ? [{ uri: round.previous, role: '이전 결과 (고칠 점이 남은 그림)' }] : []),
    ],
  });
}

function createWriteTools(d: InfographicDeps, found: FoundImages, made: string[]) {
  const listFonts = () => d.call('list_fonts', {});

  const downloadFont = async ({
    name,
    family,
    url,
    reason,
  }: {
    name: string;
    family: string;
    url: string;
    reason?: string;
  }) => {
    try {
      const host = (() => {
        try {
          return new URL(url).hostname.replace(/^www\./, '');
        } catch {
          return url;
        }
      })();
      const answer = await d.ask({
        question:
          `인포그래픽에 **${name}** 글꼴을 받으려 합니다.` +
          (reason ? ` (${reason})` : '') +
          `\n출처: ${host}\n주소: <${url}>\n받아 작업공간에 두고 쓸까요?`,
        requestedSchema: askAnswerSchema(['받기', '받지 않기']),
      });
      if (answer.action === 'decline') {
        return '사용자가 글꼴 받기를 거절했다.';
      }
      if (answer.action === 'cancel') {
        return '사용자가 작업을 중지했다.';
      }
      const text = String(answer.content.answer ?? '');
      const denied = /받지\s*않|안\s*받|거절|아니|^no\b/i.test(text);
      const allowed = /받기|네|예|yes|ok|동의/i.test(text);
      if (denied || !allowed) {
        return `사용자가 글꼴 받기를 거절했다: ${text || '(빈 답)'}`;
      }
      d.notify(true, `글꼴 받는 중: ${name}`);
      const font = await fetchFont(url);
      const bytes = Math.round((font.data.length * 3) / 4);
      const uri = await d.call('store_font', {
        name: name.trim(),
        family: family.trim(),
        source: url,
        font,
      });
      if (!uri.startsWith('blsee://')) return uri.startsWith('실패:') ? uri : `실패: ${uri}`;
      return (
        `글꼴을 저장했다 (${fontSizeLabel(bytes)}).\n` +
        `- 이름: ${name}\n- font-family: '${family.trim()}'\n- URI: ${uri}\n` +
        `HTML에서는 font-family: '${family.trim()}' 만 쓴다 (@font-face·url()은 쓰지 않는다).`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      d.notify(false, `글꼴 받기 실패: ${message}`);
      return `실패: ${message}`;
    }
  };

  return [
    createReadTool(d.call),
    tool(listFonts, {
      name: 'list_fonts',
      description:
        '쓸 수 있는 글꼴 목록(번들 + 작업공간)을 본다. HTML font-family에는 여기 나온 family만 쓴다. ' +
        '@font-face·외부 웹 글꼴 URL은 쓰지 않는다. 없으면 download_font.',
      schema: z.object({}),
    }),
    tool(downloadFont, {
      name: 'download_font',
      description:
        '번들에 없는 글꼴 파일(woff2·woff·ttf·otf)을 사용자 확인 후 받아 작업공간에 둔다. ' +
        '반드시 직접 받을 수 있는 글꼴 파일 URL이어야 한다 (Google Fonts CSS·CDN 페이지 HTML 주소 금지). ' +
        '받은 뒤 list_fonts의 family처럼 font-family에만 쓴다.',
      schema: z.object({
        name: z.string().min(1).describe('사람이 읽는 글꼴 이름 (예: "pretendard")'),
        family: z.string().min(1).describe("CSS font-family에 쓸 이름 (예: \"Pretendard\")"),
        url: z.string().url().describe('글꼴 파일 직접 URL (.woff2 등)'),
        reason: z.string().optional().describe('왜 이 글꼴이 필요한지 한 줄 (사용자에게 보여 준다)'),
      }),
    }),
    ...createImageSupportTools({
      call: d.call,
      meter: d.meter,
      notify: d.notify,
      found,
      made,
    }).filter((t) => ['view', 'search_images', 'use_web_image'].includes(t.name)),
    tool(
      async (
        {
          scene,
          refs,
          name,
        }: {
          scene: string;
          refs?: { uri: string; role: string }[];
          name?: string;
        },
        runtime: unknown,
      ) => {
        d.notify(true, `인포 이미지: ${clip(name || scene)}`);
        try {
          const detailed = await concretizeScene({
            messages: parentMessagesFromRuntime(runtime),
            scene,
            meter: d.meter,
            signal: d.signal,
          });
          return await requestPixelForInfographic(
            {
              call: d.call,
              meter: d.meter,
              locale: d.locale,
              notify: d.notify,
              ask: d.ask,
              signal: d.signal,
            },
            { scene: detailed, refs, name },
          );
        } catch (err) {
          return failText(err);
        }
      },
      {
        name: 'request_pixel',
        description:
          '인포그래픽용 배경·일러스트 이미지를 만들어 URI를 돌려준다. 그림 안 글자는 넣지 않는다. ' +
          '참고해서 그려야 하는 이미지가 있으면 refs에 URI와 역할을 넣는다. HTML에는 돌려받은 URI만 쓴다.',
        schema: z.object({
          scene: z.string().min(1).describe('장면·분위기·인물·소품 지시'),
          refs: z
            .array(
              z.object({
                uri: z.string().min(1).describe('참고 이미지 URI 또는 웹 id'),
                role: z.string().min(1).describe('역할'),
              }),
            )
            .max(REFS_MAX)
            .optional()
            .describe('참고 이미지'),
          name: nameField,
        }),
      },
    ),
  ];
}

async function imageExists(d: InfographicDeps, uri: string): Promise<boolean> {
  try {
    const got = await d.call('get_image', { uri });
    return !!got && !got.startsWith('실패:');
  } catch {
    return false;
  }
}

/**
 * HTML의 blsee://lib/images/… 중 실제로 없는 URI를, 이번 쓰기로 만든 이미지(made)로 바꾼다.
 * 모델이 도구가 준 URI 대신 지어낸 ID를 넣는 경우를 막는다.
 * 그래도 없는 URI는 missing에 담아 돌려준다.
 */
async function bindMadeImages(
  d: InfographicDeps,
  html: string,
  made: string[],
): Promise<{ html: string; missing: string[] }> {
  const refs = [...new Set([...html.matchAll(/blsee:\/\/lib\/images\/[a-z0-9]+/gi)].map((m) => m[0]))];
  if (!refs.length) return { html, missing: [] };
  const madeSet = new Set(made);
  let out = html;
  let mi = 0;
  const missing: string[] = [];
  for (const uri of refs) {
    if (madeSet.has(uri) || (await imageExists(d, uri))) continue;
    if (!made.length) {
      log('HTML 이미지 없음', uri);
      missing.push(uri);
      continue;
    }
    const repl = made[mi % made.length];
    mi += 1;
    log('HTML 이미지 URI 치환', `${uri} → ${repl}`);
    out = out.split(uri).join(repl);
  }
  return { html: out, missing };
}

/**
 * 모델이 넣은 @import / 외부 @font-face를 파일로 받아 작업공간에 두고,
 * HTML에서는 지시문만 지워 font-family만 남긴다 (렌더러가 @font-face를 붙인다).
 */
async function embedWebFonts(d: InfographicDeps, html: string): Promise<string> {
  if (!hasWebFontDirectives(html)) return html;
  let files: Awaited<ReturnType<typeof resolveWebFontFiles>> = [];
  try {
    files = await resolveWebFontFiles(html);
  } catch (err) {
    log('웹폰트 해석 실패', err instanceof Error ? err.message : String(err));
    return stripWebFontDirectives(html);
  }
  for (const file of files) {
    try {
      d.notify(true, `글꼴 받는 중: ${file.name}`);
      const font = await fetchFont(file.url);
      const uri = await d.call('store_font', {
        name: file.name,
        family: file.family,
        source: file.url,
        font,
      });
      if (!uri.startsWith('blsee://')) {
        log('웹폰트 저장 실패', `${file.family}: ${uri}`);
        continue;
      }
      log('웹폰트 저장', `${file.family} ← ${file.url} → ${uri}`);
    } catch (err) {
      log('웹폰트 받기 실패', `${file.family}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const cleaned = stripWebFontDirectives(html);
  log('웹폰트 치환', `families=${files.map((f) => f.family).join(', ') || '(없음)'} html=${clipHtml(cleaned)}`);
  return cleaned;
}

function createFetchTools(d: InfographicDeps, found: FoundImages, made: string[], state: FetchState) {
  const strReplace = ({ old_string, new_string }: { old_string: string; new_string: string }) => {
    if (!old_string) return '실패: old_string이 비었다.';
    const n = state.html.split(old_string).length - 1;
    if (n === 0) return '실패: 현재 HTML에서 찾을 수 없다. 더 짧거나 정확한 구간을 줘라.';
    if (n > 1) return `실패: ${n}곳에 있다. 한 곳만 맞게 앞뒤를 더 넣어라.`;
    state.html = state.html.replace(old_string, new_string);
    return '적용함';
  };

  return [
    tool(strReplace, {
      name: 'str_replace',
      description:
        '현재 HTML에서 old_string을 new_string으로 딱 한 곳만 바꾼다. ' +
        '고칠 점과 무관한 배경 URI·레이아웃은 건드리지 않는다.',
      schema: z.object({
        old_string: z.string().min(1).describe('현재 HTML에 있는 문자열 (정확히 한 곳)'),
        new_string: z.string().describe('바꿀 문자열 (빈 글이면 삭제)'),
      }),
    }),
    tool(() => state.html, {
      name: 'read_html',
      description: '지금 패치가 반영된 HTML 전체를 본다. str_replace 뒤 확인할 때 쓴다.',
      schema: z.object({}),
    }),
    ...createWriteTools(d, found, made),
  ];
}

async function finalizeHtml(
  d: InfographicDeps,
  html: string,
  width: number,
  made: string[],
): Promise<{ html: string; width: number }> {
  const { html: bound, missing } = await bindMadeImages(d, html, made);
  if (missing.length) {
    const err = new Error(
      `HTML 이미지 없음: ${missing.join(', ')}. request_pixel로 다시 만들어 HTML에 넣어라.`,
    );
    (err as Error & { missingImages?: string[] }).missingImages = missing;
    throw err;
  }
  const embedded = await embedWebFonts(d, bound);
  try {
    return checkHtml(embedded, width);
  } catch (err) {
    log('checkHtml 실패', `${err instanceof Error ? err.message : String(err)}\nhtml=${clipHtml(embedded)}`);
    throw err;
  }
}

function logToolCalls(tag: string, messages: BaseMessage[], width: number, made: string[], html: string) {
  if (!keyCheckOff()) return;
  const calls = messages.flatMap((m) =>
    AIMessage.isInstance(m) ? (m.tool_calls ?? []).map((c) => `  ${c.name}`) : [],
  );
  log(
    tag,
    `도구\n${calls.join('\n') || '  (없음)'}\nwidth=${width}\nmade=${made.join(', ') || '(없음)'}\nhtml=${clipHtml(html)}`,
  );
}

/** make: HTML 전문을 structured output으로 낸다. */
async function writeHtml(d: InfographicDeps, input: HumanMessage): Promise<{ html: string; width: number }> {
  const found: FoundImages = new Map();
  const made: string[] = [];
  const tools = createWriteTools(d, found, made);
  const agent = createAgent({
    model: chatModel('infographic-draw'),
    tools,
    responseFormat: toolStrategy(writeSchema),
    systemPrompt: `${INFOGRAPHIC_WRITE_PROMPT}\n\nHTML 규칙:\n${HTML_RULES}`,
  });
  const invoke = (messages: BaseMessage[]) =>
    agent.invoke(
      { messages },
      {
        recursionLimit: WRITE_RECURSION,
        signal: d.signal,
        callbacks: [usageCallback(d.meter, config['infographic-draw'].model, 'draw_agent')],
      },
    );
  let result = await invoke([input]);
  // 도구를 글로 쓰거나 HTML을 내지 않았으면 이어서 한 번 다시 시킨다.
  if (!result.structuredResponse?.html || wroteToolAsText(result.messages, tools.map((t) => t.name))) {
    result = await invoke([...result.messages, new HumanMessage(`${TOOL_AS_TEXT_FIX} 완성한 HTML은 출력 형식으로 낸다.`)]);
  }
  const out = result.structuredResponse;
  if (!out?.html) throw new Error('쓰기 에이전트가 HTML을 내지 못했다.');
  logToolCalls('make', result.messages, out.width, made, out.html);
  return finalizeHtml(d, out.html, out.width, made);
}

/** fetch: str_replace 패치만. 전체 HTML 재작성 금지. */
async function patchHtml(
  d: InfographicDeps,
  input: HumanMessage,
  state: FetchState,
): Promise<{ html: string; width: number }> {
  const found: FoundImages = new Map();
  const made: string[] = [];
  const before = state.html;
  const tools = createFetchTools(d, found, made, state);
  const agent = createAgent({
    model: chatModel('infographic-draw'),
    tools,
    responseFormat: toolStrategy(fetchDoneSchema),
    systemPrompt: `${INFOGRAPHIC_FETCH_PROMPT}\n\nHTML 규칙:\n${HTML_RULES}`,
  });
  const invoke = (messages: BaseMessage[]) =>
    agent.invoke(
      { messages },
      {
        recursionLimit: FETCH_RECURSION,
        signal: d.signal,
        callbacks: [usageCallback(d.meter, config['infographic-draw'].model, 'draw_agent')],
      },
    );
  let result = await invoke([input]);
  // 도구를 글로 쓰면 (str_replace를 글로 적는 등) 이어서 한 번 다시 시킨다.
  if (wroteToolAsText(result.messages, tools.map((t) => t.name))) {
    result = await invoke([...result.messages, new HumanMessage(`${TOOL_AS_TEXT_FIX} 고친 뒤 출력 형식으로 마친다.`)]);
  }
  const out = result.structuredResponse;
  if (out?.width != null) state.width = out.width;
  if (state.html === before && !made.length) {
    log('fetch', '패치 없음 — 현재 HTML 유지');
  }
  logToolCalls('fetch', result.messages, state.width, made, state.html);
  return finalizeHtml(d, state.html, state.width, made);
}

/** base URI → HTML 본문. block이면 import_image 후 get_html. */
async function loadBaseHtml(d: InfographicDeps, base: string): Promise<{ html: string; uri: string } | null> {
  let uri = base;
  if (/^blsee:\/\/block\/\d+$/.test(uri)) uri = `${uri}/image`;
  if (/^blsee:\/\/block\/\d+\/image/.test(uri)) {
    try {
      const kept = await d.call('import_image', { uri });
      if (!kept.startsWith('blsee://')) {
        log('base import 실패', kept);
        return null;
      }
      log('base import', `${base} → ${kept}`);
      uri = kept;
    } catch (err) {
      log('base import 예외', err instanceof Error ? err.message : String(err));
      return null;
    }
  }
  try {
    const got = await d.call('get_html', { uri });
    if (got && !got.startsWith('실패:')) return { html: got, uri };
    log('base get_html 실패', `${uri}: ${got || '(빈 응답)'}`);
    return null;
  } catch (err) {
    log('base get_html 예외', err instanceof Error ? err.message : String(err));
    return null;
  }
}
async function render(d: InfographicDeps, html: string, width: number, label: string, name?: string): Promise<string> {
  log('store_html', `width=${width} label=${label} html=${clipHtml(html)}`);
  let uri: string;
  try {
    uri = await d.call('store_html', { html, width, instruction: label, ...(name ? { name } : {}) });
  } catch (err) {
    log('store_html 예외', err instanceof Error ? err.message : String(err));
    throw err;
  }
  if (!uri.startsWith('blsee://')) {
    log('store_html 실패', uri);
    throw new Error(uri);
  }
  log('store_html ok', uri);
  return uri;
}

/**
 * 판정: 지시, 고치라고 받은 원본(있으면), 렌더 결과, 맥락·재료 글, 참조를 한 번에 보고 정한다.
 * 원본·결과는 원래 크기, 참조는 줄여서 이미지로 넣는다. 재료 글은 자르지 않는다.
 */
async function judge(
  d: InfographicDeps,
  args: InfographicArgs,
  material: string,
  original: string | undefined,
  uri: string,
  issuesPrev: string[],
): Promise<z.infer<typeof judgeSchema>> {
  const input = await seedMessage(d.call, {
    head: '인포그래픽',
    instructions: args.instructions,
    requests: args.requests,
    issues: issuesPrev,
    issuesLabel: '앞서 지적 (고쳐졌는지 확인한다)',
    original: original ? { uri: original } : undefined,
    result: { uri },
    context: [args.context, material && `재료 글:\n${material}`],
    references: [
      ...(args.refs ?? []).map((r) => ({ uri: toImageUri(r.uri), role: r.role })),
      ...(d.pointed ?? []).map((u) => ({ uri: u, role: '가리킨 인포그래픽' })),
    ],
  });
  const model = chatModel('infographic-judge').withStructuredOutput(judgeSchema);
  const out = (await model.invoke([new SystemMessage(INFOGRAPHIC_JUDGE_PROMPT), input.message], {
    signal: d.signal,
    callbacks: [usageCallback(d.meter, config['infographic-judge'].model, 'draw_agent')],
  })) as z.infer<typeof judgeSchema>;
  log('judge', JSON.stringify(out));
  return out;
}

/**
 * make/fetch/judge 사이클. 최종 그림 URI가 없으면 실패한 것이다.
 */
export async function makeInfographic(
  d: InfographicDeps,
  args: InfographicArgs,
  label?: string,
): Promise<{ uri?: string; message: string }> {
  d = { ...d, call: cachedImageCall(d.call) };
  const title = label ?? `인포그래픽 · ${clip(args.name || args.instructions[0])}`;
  const material = args.sources?.length ? await d.call('read_blocks', { uris: args.sources }) : '';
  let html = '';
  /** 고칠 때 [Original]로 보일 그림 (바탕 인포, 이후에는 마지막 결과) */
  let original = '';
  let width = 720;
  let mode: 'make' | 'fetch' = 'make';
  /** 고치라고 받은 인포그래픽 (평가에서 [Original]로 보인다) */
  let asked: string | undefined;
  /** 고치라고 받은 인포그래픽의 HTML (다시 그릴 때 여기서 다시 시작한다) */
  let askedHtml = '';
  /** 다시 그리는 회차에 참조로 보일 이전 결과 */
  let previous: string | undefined;
  let issues: string[] = [];
  let lastUri = '';
  let message = '';
  /** 사용자가 고칠 점을 적어 늘어난 회차 */
  let userRounds = 0;

  if (args.original) {
    const got = await loadBaseHtml(d, args.original);
    if (got) {
      html = got.html;
      original = got.uri;
      asked = got.uri;
      askedHtml = got.html;
      mode = 'fetch';
      log('start', `fetch original=${args.original}`);
      const broken = await missingHtmlImages(d, html);
      if (broken.length) {
        issues = [
          `다음 이미지를 읽을 수 없다: ${broken.join(', ')}. request_pixel로 배경·일러스트를 다시 만들어 str_replace로 src/url의 URI만 바꿔라.`,
        ];
        log('base 깨진 이미지', broken.join(', '));
      }
    } else {
      log('start', `make (original HTML 없음: ${args.original})`);
    }
  } else {
    log('start', 'make');
  }

  /**
   * 다시 그린다. 고치라고 받은 원본이 있으면 원본 HTML에서 다시 고치고, 없으면 처음부터 새로 쓴다.
   * 어느 쪽이든 방금 결과는 "이전 결과" 참조로 보인다.
   */
  const redraw = () => {
    previous = lastUri || undefined;
    if (asked) {
      html = askedHtml;
      original = asked;
      mode = 'fetch';
    } else {
      html = '';
      mode = 'make';
    }
  };

  for (let i = 0; i < JUDGE_MAX + userRounds; i++) {
    d.notify(true, `인포그래픽 ${mode === 'make' ? '생성' : '수정'} 중 (${i + 1}/${JUDGE_MAX + userRounds})`);
    log('cycle', `${mode} ${i + 1}/${JUDGE_MAX + userRounds}`);
    try {
      if (mode === 'make') {
        const input = await infoSeed(args, d, material, { issues, previous });
        log('input', input.text.slice(0, 1500));
        const written = await writeHtml(d, input.message);
        html = written.html;
        width = written.width;
      } else {
        const input = await infoSeed(args, d, material, { original: original || undefined, html, issues, previous });
        log('input', input.text.slice(0, 1500));
        const written = await patchHtml(d, input.message, { html, width });
        html = written.html;
        width = written.width;
      }
      lastUri = await render(d, html, width, title, args.name);
      original = lastUri;
      previous = undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const missing = (err as Error & { missingImages?: string[] }).missingImages;
      log('cycle 실패', `${mode} ${i + 1}/${JUDGE_MAX}: ${msg}`);
      // 깨진 이미지 URI면 같은 HTML을 두고 generate_image + str_replace로 고치게 한 번 더 시도한다.
      if (missing?.length && i + 1 < JUDGE_MAX + userRounds) {
        issues = [
          `다음 이미지를 읽을 수 없다: ${missing.join(', ')}. request_pixel로 다시 만들어 str_replace로 HTML의 URI만 바꿔라. 없는 URI를 그대로 두지 마라.`,
        ];
        mode = 'fetch';
        continue;
      }
      throw err;
    }
    d.notify(true, '인포그래픽 확인 중');
    const verdict = await judge(d, args, material, asked, lastUri, issues);
    message = verdict.message;
    if (verdict.action === 'done') return { uri: lastUri, message };
    // 재료가 비어 make를 되풀이하면 같은 실패만 반복한다 → 여기서 끊고 메모만 올린다.
    if (verdict.action === 'make' && emptyMaterial(verdict.issues, verdict.message)) {
      log('stop', '재료 없음 → 재작성 중단');
      return {
        uri: undefined,
        message: message || verdict.issues.join(' ') || '인포그래픽으로 담을 내용이 없습니다.',
      };
    }
    // 애매하거나, 고쳐 보았는데 같은 문제가 남았거나, 더 고칠 회차가 없으면 사용자에게 이대로 쓸지 묻는다.
    const repeated = repeatsIssues(verdict.issues, issues);
    const lastRound = i + 1 >= JUDGE_MAX + userRounds;
    if (verdict.action === 'ask' || repeated || lastRound) {
      log('review', `${verdict.action}${repeated ? ' (같은 지적 반복)' : ''}${lastRound ? ' (마지막 회차)' : ''}`);
      const review = await reviewWithUser(d.ask, { what: '인포그래픽', uri: lastUri, message: verdict.message, issues: verdict.issues });
      if (review.use) return { uri: lastUri, message };
      if (userRounds >= USER_ROUNDS_MAX && lastRound) return { uri: lastUri, message: `${message} (더 고칠 수 있는 횟수를 넘었습니다)`.trim() };
      if (lastRound) userRounds++;
      // 사용자가 거절했거나 의견을 적었으면 다시 그린다.
      issues = review.issues;
      redraw();
      continue;
    }
    issues = verdict.issues;
    if (verdict.action === 'make') redraw();
    else mode = 'fetch';
  }
  return { uri: lastUri || undefined, message: message || '평가 횟수 상한에 닿아 마지막 그림을 쓴다.' };
}

async function missingHtmlImages(d: InfographicDeps, html: string): Promise<string[]> {
  const refs = [...new Set([...html.matchAll(/blsee:\/\/lib\/images\/[a-z0-9]+/gi)].map((m) => m[0]))];
  const missing: string[] = [];
  for (const uri of refs) {
    if (!(await imageExists(d, uri))) missing.push(uri);
  }
  return missing;
}

/** 재료·데이터가 없어 다시 그려도 소용없는 평가인지 */
function emptyMaterial(issues: string[], message: string): boolean {
  const text = [...issues, message].join(' ');
  return /재료.{0,24}(?:비어|없)|내용이 (?:비어|없)|데이터가 없|정보가 없|입력된 (?:재료|정보|내용).{0,12}없|시각화할 .{0,30}없/.test(
    text,
  );
}

/** 계획 전용: make_infographic 도구 */
export function createMakeInfographicTool(d: Omit<InfographicDeps, 'locale'> & { locale?: string }) {
  const deps: InfographicDeps = { ...d, locale: d.locale ?? 'ko-KR' };
  const run = async (args: InfographicArgs, runtime: unknown) => {
    deps.notify(true, `인포그래픽 생성: ${clip(args.name || args.instructions[0])}`);
    const brief = await concretizeBrief({
      messages: parentMessagesFromRuntime(runtime),
      requests: deps.requests,
      instructions: args.instructions,
      context: args.context,
      meter: deps.meter,
      signal: deps.signal,
    });
    const detailed = { ...args, instructions: brief.instructions, context: brief.context, requests: brief.requests };
    log('tool', `instructions=${detailed.instructions.length} original=${args.original ?? '(없음)'} name=${args.name ?? '(없음)'}`);
    try {
      const { uri, message } = await makeInfographic(deps, detailed);
      if (!uri) {
        const fail = `실패: 그림을 그리지 못했다.${message ? ` 인포그래픽 생성: ${message}` : ''}`;
        log('tool 실패(uri 없음)', fail);
        return fail;
      }
      log('tool ok', `${uri}${message ? ` · ${message}` : ''}`);
      return [`${uri} ${MADE}`, message && `인포그래픽 생성 메모: ${message}`].filter(Boolean).join('\n');
    } catch (err) {
      if (deps.signal?.aborted) {
        log('tool abort', err instanceof Error ? err.message : String(err));
        throw err;
      }
      const fail = failText(err);
      log('tool 실패', fail);
      return fail;
    }
  };

  return tool(run, {
    name: 'make_infographic',
    description:
      '글자와 배치가 중심인 인포그래픽(표, 비교 카드, 요약, 타임라인, 체크리스트, 단계 안내)을 생성해 PNG로 보관한다. ' +
      'HTML을 쓰고 평가·패치한다. 배경·일러스트는 request_pixel로 만든 뒤 HTML에 넣는다 (글자는 HTML). ' +
      '고칠 인포그래픽은 original에, 참조 이미지는 refs에, 담을 내용은 sources에 URI로 넘긴다. ' +
      `사진만이면 make_image. ${RESULT_NOTE}`,
    schema: z.object({
      instructions: z
        .array(z.string().min(1))
        .min(1)
        .max(INSTRUCTIONS_MAX)
        .describe('만들 형태, 고칠 점, 글에 없는 내용을 상세히 (글에 있는 내용은 sources로)'),
      sources: z.array(docUri).max(SOURCES_MAX).optional().describe('담을 내용이 있는 블록·범위·이미지·HTML URI'),
      context: z.string().min(1).describe('글 주제·넣을 자리·대화에서 합의한 방향'),
      original: z
        .string()
        .regex(BASE_URI_RE)
        .optional()
        .describe('고칠 인포그래픽 URI (blsee://lib/infographics/…, 인포그래픽으로 만든 보관 이미지, 글 속 인포그래픽 이미지). 고칠 대상이 있을 때만'),
      refs: z
        .array(
          z.object({
            uri: z.string().regex(/^blsee:\/\/\S+$/).describe('관련 URI'),
            role: z.string().min(1).describe('역할'),
          }),
        )
        .max(REFS_MAX)
        .optional()
        .describe('참고할 이미지·HTML과 역할'),
      name: nameField,
    }),
  });
}