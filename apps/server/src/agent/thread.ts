import { Command } from '@langchain/langgraph';
import type { BaseMessage } from 'langchain';
import { askAnswerText, type AskAnswer, type AskRequest } from '@blog-helper/shared';

/** 모델 호출과 도구 실행을 합친 그래프 단계 수 상한 (에이전트 한 번 부를 때마다) */
const RECURSION_LIMIT = 40;

interface InvokableAgent<R> {
  invoke(input: unknown, config: Record<string, unknown>): Promise<R>;
}

export interface ThreadOptions {
  ask: (req: AskRequest) => Promise<AskAnswer>;
  callbacks: unknown[];
  signal?: AbortSignal;
}

/**
 * 에이전트 하나의 대화 줄기. 같은 thread_id로 이어서 부르므로 앞 회차에 읽은 내용을 기억한다.
 * ask_user로 멈추면 사용자에게 묻고 답을 받아 이어간다.
 */
export function agentThread<R extends { __interrupt__?: { value?: unknown }[] }>(agent: InvokableAgent<R>, opts: ThreadOptions) {
  const config = {
    configurable: { thread_id: crypto.randomUUID() },
    recursionLimit: RECURSION_LIMIT,
    signal: opts.signal,
    callbacks: opts.callbacks,
  };
  return async (messages: BaseMessage[]): Promise<R> => {
    let result = await agent.invoke({ messages }, config);
    while (result.__interrupt__?.length) {
      const answer = await opts.ask(result.__interrupt__[0].value as AskRequest);
      result = await agent.invoke(new Command({ resume: askAnswerText(answer) }), config);
    }
    return result;
  };
}

export function isRecursionError(err: unknown): boolean {
  return err instanceof Error && err.name === 'GraphRecursionError';
}
