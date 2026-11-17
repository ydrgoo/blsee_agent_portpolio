import { MemorySaver } from '@langchain/langgraph';
import { createAgent, HumanMessage, toolStrategy, type BaseMessage } from 'langchain';
import { TOOL_AS_TEXT_FIX, wroteToolAsText } from './tool-text';
import { chatModel, config } from '../config';
import { usageCallback, type UsageMeter } from '../usage';
import { planSchema, type Plan } from './schemas';
import { agentThread, type ThreadOptions } from './thread';
import type { createMakeImageTool } from './image-agent';
import type { createMakeInfographicTool } from './infographic-agent';
import type { createSharedTools } from './tools';

export interface PlannerOptions extends Omit<ThreadOptions, 'callbacks'> {
  tools: (
    | ReturnType<typeof createSharedTools>[number]
    | ReturnType<typeof createMakeInfographicTool>
    | ReturnType<typeof createMakeImageTool>
  )[];
  systemPrompt: string;
  meter: UsageMeter;
}

/** 계획 에이전트. 대화가 넘긴 편집을 읽기 도구로 확인하고 작업 목록을 낸다. 회차가 바뀌어도 같은 대화를 이어간다. */
export function createPlanner({ tools, systemPrompt, meter, ...opts }: PlannerOptions) {
  const agent = createAgent({
    model: chatModel('plan'),
    tools,
    responseFormat: toolStrategy(planSchema),
    checkpointer: new MemorySaver(),
    systemPrompt,
  });
  const send = agentThread(agent, { ...opts, callbacks: [usageCallback(meter, config.plan.model, 'plan')] });
  const toolNames = tools.map((t) => t.name);
  return async (messages: BaseMessage[]): Promise<Plan> => {
    let result = await send(messages);
    // 도구를 글로 쓰거나 계획을 내지 않았으면 한 번 다시 시킨다.
    if (!result.structuredResponse || wroteToolAsText(result.messages, toolNames)) {
      result = await send([new HumanMessage(`${TOOL_AS_TEXT_FIX} 계획은 출력 형식으로 낸다.`)]);
    }
    if (!result.structuredResponse) throw new Error('계획 에이전트가 계획을 내지 않았습니다.');
    return result.structuredResponse;
  };
}
