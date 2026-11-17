import { WOOD_KRW } from '@blog-helper/shared';

/** 원/달러 환율. 장작 환산에만 쓴다. */
const KRW_PER_USD = Number(process.env.KRW_PER_USD) || 1450;

/** 모델 단가 (USD, 토큰 100만 개당). 각 API의 유료 표준 단가(2026-10 기준)이며 바뀌면 고친다. */
interface Price {
  input: number;
  /** 텍스트와 생각 출력 */
  output: number;
  /** 이미지 출력 (이미지 모델만) */
  imageOutput?: number;
  /** 캐시에서 읽은 입력 단가. 없으면 캐시 할인이 없다. */
  cachedInput?: number;
}

/** 위에서부터 먼저 맞는 것을 쓴다 (더 구체적인 이름을 위에). 같은 이름으로 시작하는 변형 모델은 단가가 같다. */
const PRICES: { match: RegExp; price: Price }[] = [
  // 이미지 모델: 캐시 할인 없음. 1K 이미지는 출력 토큰 약 1120개.
  { match: /nano-banana-2\.1/, price: { input: 1.5, output: 7.5, imageOutput: 30 } },
  { match: /3\.1-flash-lite-image/, price: { input: 0.25, output: 1.5, imageOutput: 30 } },
  { match: /3\.1-flash-image/, price: { input: 0.5, output: 3, imageOutput: 60 } },
  { match: /2\.5-flash-image/, price: { input: 0.3, output: 2.5, imageOutput: 30 } },
  { match: /3\.5-flash-lite/, price: { input: 0.3, output: 2.5, cachedInput: 0.03 } },
  { match: /3\.1-flash-lite/, price: { input: 0.25, output: 1.5, cachedInput: 0.025 } },
  { match: /2\.5-flash-lite/, price: { input: 0.1, output: 0.4, cachedInput: 0.01 } },
  { match: /3\.5-flash/, price: { input: 1.5, output: 9, cachedInput: 0.15 } },
  // 3.8 Flash는 2026-12-31까지 할인가. 2027-01-01부터 input 1.5, output 7.5, cachedInput 0.15
  { match: /3\.[678]-flash/, price: { input: 0.75, output: 3.75, cachedInput: 0.075 } },
  { match: /3-flash/, price: { input: 0.5, output: 3, cachedInput: 0.05 } },
  { match: /2\.5-flash/, price: { input: 0.3, output: 2.5, cachedInput: 0.03 } },
  { match: /3\.1-pro/, price: { input: 2, output: 12, cachedInput: 0.2 } },
  { match: /2\.5-pro/, price: { input: 1.25, output: 10, cachedInput: 0.125 } },
  // Perplexity Agent API (docs.perplexity.ai/docs/agent-api/models)
  { match: /^perplexity\/sonar$/, price: { input: 0.25, output: 2.5, cachedInput: 0.0625 } },
];

/** 도구 호출 1회 요금 (USD). Perplexity Agent API 도구 (docs.perplexity.ai/docs/getting-started/pricing) */
const TOOL_PRICES: Record<string, number> = {
  'perplexity/web_search': 0.0025,
  'perplexity/web_search_fast': 0.001,
  'perplexity/image_search': 0.0025,
};

function priceOf(model: string): Price {
  const p = PRICES.find((x) => x.match.test(model))?.price;
  if (!p) throw new Error(`가격표에 없는 모델입니다: ${model} (apps/server/src/pricing.ts에 단가를 넣는다)`);
  return p;
}

function toolPriceOf(tool: string): number {
  const p = TOOL_PRICES[tool];
  if (p === undefined) throw new Error(`가격표에 없는 도구입니다: ${tool} (apps/server/src/pricing.ts에 요금을 넣는다)`);
  return p;
}

/** 서버 시작 시 설정의 모델과 도구가 모두 가격표에 있는지 확인한다. 없으면 던진다. */
export function assertPriced(models: string[], tools: string[] = []): void {
  for (const m of models) priceOf(m);
  for (const t of tools) toolPriceOf(t);
}

/** 모델 호출 한 번의 토큰 수 */
export interface TokenCounts {
  /** 입력 전체 (캐시에서 읽은 것 포함) */
  input: number;
  /** 입력 중 캐시에서 읽은 것 */
  cached?: number;
  /** 텍스트와 생각 출력 */
  output: number;
  /** 이미지 출력 */
  imageOutput?: number;
  /** 호출 안에서 쓴 유료 도구와 횟수 (예: { 'perplexity/web_search_fast': 1 }) */
  tools?: Record<string, number>;
}

/** 모델 호출 한 번의 비용을 장작 개수로 (소수) */
export function woodOf(model: string, t: TokenCounts): number {
  const p = priceOf(model);
  const cached = p.cachedInput === undefined ? 0 : Math.min(t.cached ?? 0, t.input);
  const tokenUsd =
    ((t.input - cached) * p.input +
      cached * (p.cachedInput ?? p.input) +
      t.output * p.output +
      (t.imageOutput ?? 0) * (p.imageOutput ?? p.output)) /
    1_000_000;
  const toolUsd = Object.entries(t.tools ?? {}).reduce((s, [name, n]) => s + toolPriceOf(name) * n, 0);
  return ((tokenUsd + toolUsd) * KRW_PER_USD) / WOOD_KRW;
}
