import type { LLMResult } from '@langchain/core/outputs';
import type { UsageEntry, UsagePurpose } from '@blog-helper/shared';
import { woodOf, type TokenCounts } from './pricing';

interface UsageMetadata {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_token_details?: { cache_read?: number };
}

/** LangChain 모델 호출마다 사용량을 더하는 콜백. 중간에 멈추거나 실패해도 그때까지 쓴 만큼은 센다. */
export function usageCallback(meter: UsageMeter, model: string, purpose: UsagePurpose) {
  return {
    handleLLMEnd(output: LLMResult) {
      const gen = output.generations?.[0]?.[0] as { message?: { usage_metadata?: UsageMetadata } } | undefined;
      const u = gen?.message?.usage_metadata;
      const input = u?.input_tokens ?? 0;
      // LangChain의 output_tokens에는 생각 토큰이 빠져 있다. total_tokens에는 들어 있으므로 total에서 입력을 뺀다.
      const produced = Math.max(u?.output_tokens ?? 0, (u?.total_tokens ?? 0) - input);
      meter.add(model, purpose, { input, output: produced, cached: u?.input_token_details?.cache_read ?? 0 });
    },
  };
}

export type WoodByPurpose = Partial<Record<UsagePurpose, number>>;

/** 요청 하나 동안의 모델 호출 사용량. 에이전트 외에 도구 안에서 부른 모델도 여기에 더한다. */
export class UsageMeter {
  private entries = new Map<string, UsageEntry>();
  private woodTotal = 0;
  private woodByPurpose: WoodByPurpose = {};

  /** onChange: 모델을 부를 때마다 지금까지 쓴 장작 누적값 (전체, 용도별) */
  constructor(private readonly onChange?: (wood: number, byPurpose: WoodByPurpose) => void) {}

  add(model: string, purpose: UsagePurpose, t: TokenCounts): void {
    const key = `${purpose}:${model}`;
    const e = this.entries.get(key) ?? { model, purpose, calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    e.calls += 1;
    e.inputTokens += t.input;
    e.outputTokens += t.output + (t.imageOutput ?? 0);
    e.cachedTokens += t.cached ?? 0;
    this.entries.set(key, e);
    const wood = woodOf(model, t);
    this.woodTotal += wood;
    this.woodByPurpose[purpose] = (this.woodByPurpose[purpose] ?? 0) + wood;
    this.onChange?.(this.woodTotal, { ...this.woodByPurpose });
  }

  get wood(): number {
    return this.woodTotal;
  }

  list(): UsageEntry[] {
    return [...this.entries.values()];
  }

  summary(): string {
    const calls =
      this.list()
        .map(
          (e) =>
            `${e.purpose}/${e.model} ${e.calls}회 입력 ${e.inputTokens}(캐시 ${e.cachedTokens}) 출력 ${e.outputTokens}`,
        )
        .join(', ') || '없음';
    return `${calls} · 장작 ${this.woodTotal.toFixed(2)}개`;
  }
}
