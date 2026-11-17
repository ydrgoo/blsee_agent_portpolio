import Perplexity from '@perplexity-ai/perplexity_ai';
import { config, IMAGE_SEARCH_TOOL, SEARCH_TOOL } from './config';
import type { UsageMeter } from './usage';

const MAX_SOURCES = 8;

const INSTRUCTIONS =
  '질문을 web_search로 찾아보고, 검색 결과에 근거한 내용만 한국어로 짧게 답한다. ' +
  '근거로 쓴 문장 끝에 검색 결과 번호를 [1]처럼 붙인다. 검색 결과에 없는 내용은 추측하지 않는다.';

interface SearchResult {
  id: number;
  url?: string;
  title?: string;
}

interface OutputItem {
  type?: string;
  results?: SearchResult[];
}

let client: Perplexity | null = null;
function perplexity(): Perplexity {
  if (!process.env.PERPLEXITY_API_KEY) throw new Error('PERPLEXITY_API_KEY가 없습니다.');
  client ??= new Perplexity({ apiKey: process.env.PERPLEXITY_API_KEY });
  return client;
}

/**
 * Perplexity Agent API(POST /v1/agent)를 한 번 불러 웹을 검색하고 질문에 답한다. 결과는 요약 글과 출처 목록(번호는 본문의 인용 번호와 같다)이다.
 * 에이전트 모델에서 검색과 문서 도구를 함께 켜기 어려워 별도 호출로 감쌌다.
 */
export async function webSearch(query: string, meter?: UsageMeter, instructions = INSTRUCTIONS): Promise<string> {
  // 지시를 입력에 덧붙이면 검색어에 섞여 엉뚱한 결과가 나온다. 입력은 질문만, 지시는 instructions로 준다.
  const res = await perplexity().responses.create({
    ...config.search.params,
    model: config.search.model,
    input: query,
    instructions,
    tools: [{ type: 'web_search', search_type: config.search.search_type, user_location: { country: config.search.country } }],
  });

  const items = (res.output ?? []) as OutputItem[];
  const searches = items.filter((item) => item.type === 'search_results');
  meter?.add(config.search.model, 'search', {
    input: res.usage?.input_tokens ?? 0,
    output: res.usage?.output_tokens ?? 0,
    tools: { [SEARCH_TOOL]: searches.length },
  });
  if (res.status && res.status !== 'completed') throw new Error(`검색이 끝나지 않았습니다 (${res.status}).`);

  const answer = res.output_text.trim() || '(검색 결과로 답하지 못했습니다.)';
  const results = searches.flatMap((item) => item.results ?? []);
  // 본문의 [1], [web:1]은 검색 결과 id다. 출처도 그 번호로 적고, 인용된 것이 있으면 그것만 적는다.
  const cited = new Set([...answer.matchAll(/\[(?:web:)?(\d+)\]/g)].map((m) => Number(m[1])));
  const seen = new Set<string>();
  const sources = results
    .filter((r) => (cited.size ? cited.has(r.id) : true) && !!r.url && !seen.has(r.url) && !!seen.add(r.url))
    .slice(0, cited.size || MAX_SOURCES);
  if (!sources.length) return `${answer}\n\n(출처 없음: 검색 결과에 근거하지 않은 답일 수 있다.)`;
  return `${answer}\n\n출처:\n${sources.map((r) => `${r.id}. [${r.title || '출처'}](${r.url})`).join('\n')}`;
}

/** 이미지 검색 결과 하나. pageUrl은 그 이미지가 실린 페이지 (출처) */
export interface WebImageHit {
  imageUrl: string;
  pageUrl: string;
  title: string;
  width: number;
  height: number;
}

interface ImageOutputItem {
  type?: string;
  error?: string;
  results?: { image_url?: string; origin_url?: string; title?: string; width?: number; height?: number }[];
}

const IMAGE_INSTRUCTIONS = '입력을 검색어로 image_search를 한 번만 부르고, 답은 "완료" 한 마디로 한다.';

/** Perplexity Agent API의 image_search 도구로 이미지를 찾는다. 출처 페이지가 없는 결과는 버린다. */
export async function imageSearch(query: string, max: number, meter?: UsageMeter): Promise<WebImageHit[]> {
  const res = await perplexity().responses.create({
    model: config.search.model,
    input: query,
    instructions: IMAGE_INSTRUCTIONS,
    max_output_tokens: 50,
    tools: [{ type: 'image_search', max_results: max, filters: { format_filter: ['jpeg', 'png', 'webp'], safe_search: true } }],
  });

  const items = ((res.output ?? []) as ImageOutputItem[]).filter((item) => item.type === 'image_search_results');
  meter?.add(config.search.model, 'search', {
    input: res.usage?.input_tokens ?? 0,
    output: res.usage?.output_tokens ?? 0,
    tools: { [IMAGE_SEARCH_TOOL]: items.filter((item) => !item.error).length },
  });
  const seen = new Set<string>();
  return items
    .flatMap((item) => item.results ?? [])
    .flatMap((r) =>
      r.image_url && r.origin_url && !seen.has(r.image_url) && seen.add(r.image_url)
        ? [{ imageUrl: r.image_url, pageUrl: r.origin_url, title: r.title?.trim() || '', width: r.width ?? 0, height: r.height ?? 0 }]
        : [],
    )
    .slice(0, max);
}
