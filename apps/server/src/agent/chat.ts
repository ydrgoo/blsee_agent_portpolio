import { MemorySaver } from '@langchain/langgraph';
import { createAgent, HumanMessage, type BaseMessage } from 'langchain';
import { chatModel, config } from '../config';
import { usageCallback, type UsageMeter } from '../usage';
import { agentThread, type ThreadOptions } from './thread';
import type { createReviewTool } from './review';
import { createRequestEditTool } from './tools';
import { TOOL_AS_TEXT_FIX, wroteToolAsText } from './tool-text';
import type { PlannerOptions } from './plan';

export interface ChatOptions extends Omit<ThreadOptions, 'callbacks'> {
  /** 계획 담당과 같은 도구 (읽기·검색·그림 만들기) */
  tools: (PlannerOptions['tools'][number] | ReturnType<typeof createReviewTool>)[];
  systemPrompt: string;
  meter: UsageMeter;
}

/** edit: 계획에 넘길 편집 요청 / reply: 사용자에게 보일 답 */
export type ChatTurnResult = { edit: string; reviews?: string[] } | { reply: string };

/**
 * 대화 에이전트. 요청을 먼저 받아 직접 답하거나 request_edit로 계획에 넘기고,
 * 편집이 끝나면 같은 대화를 이어서 결과를 검토하고 답한다.
 */
export function createChat({ tools, systemPrompt, meter, ...opts }: ChatOptions) {
  let edit: string | undefined;
  let reviews: string[] | undefined;
  const requestEdit = createRequestEditTool((request, ids) => {
    edit = request;
    reviews = ids;
  });
  const allTools = [...tools, requestEdit];
  const toolNames = allTools.map((t) => t.name);
  const agent = createAgent({
    model: chatModel('chat'),
    tools: allTools,
    checkpointer: new MemorySaver(),
    systemPrompt,
  });
  const send = agentThread(agent, { ...opts, callbacks: [usageCallback(meter, config.chat.model, 'chat')] });
  return async (messages: BaseMessage[]): Promise<ChatTurnResult> => {
    edit = undefined;
    reviews = undefined;
    let result = await send(messages);
    // 예시를 따라 도구를 부르지 않고 글로 쓰면, 도구 호출로 다시 하게 한 번 시킨다.
    const text = () => result.messages.at(-1)?.text ?? '';
    if (edit === undefined && wroteToolAsText(result.messages, toolNames)) {
      result = await send([new HumanMessage(TOOL_AS_TEXT_FIX)]);
    }
    if (edit !== undefined) return { edit, ...(reviews ? { reviews } : {}) };
    return { reply: text() };
  };
}
