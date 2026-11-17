import { readFileSync } from 'node:fs';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatPerplexity } from '@langchain/perplexity';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { assertPriced } from './pricing';

const CONFIG_URL = new URL('../models.toml', import.meta.url);

const params = z.record(z.string(), z.unknown()).default({});

const chatNode = z.object({
  provider: z.enum(['google-genai', 'perplexity']),
  model: z.string().min(1),
  params,
});

const genaiNode = z.object({ model: z.string().min(1), params });

const schema = z.object({
  chat: chatNode,
  plan: chatNode,
  action: chatNode,
  write: chatNode,
  'image-instruction': chatNode,
  'image-draw': genaiNode,
  'image-judge': chatNode,
  'infographic-draw': chatNode,
  'infographic-judge': chatNode,
  review: chatNode,
  'prompt-make': chatNode,
  'prompt-normalize': chatNode,
  'prompt-extract': chatNode,
  view: genaiNode,
  search: z.object({
    model: z.string().min(1),
    search_type: z.enum(['fast', 'web']).default('fast'),
    country: z.string().length(2).default('KR'),
    params,
  }),
  loop: z
    .object({
      max_rounds: z.number().int().min(1).optional(),
      max_consecutive_errors: z.number().int().min(1).default(2),
    })
    .default({ max_consecutive_errors: 2 }),
});

export type ChatNodeConfig = z.infer<typeof chatNode>;
export type AgentNode = 'chat' | 'plan' | 'action' | 'write' | 'image-instruction' | 'image-judge' | 'infographic-draw' | 'infographic-judge' | 'review' | 'prompt-make' | 'prompt-normalize' | 'prompt-extract';

function load() {
  const raw = parse(readFileSync(CONFIG_URL, 'utf8'));
  const res = schema.safeParse(raw);
  if (!res.success) throw new Error(`models.toml 형식이 잘못됐습니다:\n${z.prettifyError(res.error)}`);
  return res.data;
}

/** 서버 시작 시 한 번 읽는다. 형식이 틀리거나 가격표에 없는 모델이 있으면 여기서 던진다. */
export const config = load();

/** 검색 호출 1회에 붙는 도구 요금 이름 (가격표의 키) */
export const SEARCH_TOOL = config.search.search_type === 'fast' ? 'perplexity/web_search_fast' : 'perplexity/web_search';

/** 이미지 검색 호출 1회 (성공한 것만) 요금 이름 */
export const IMAGE_SEARCH_TOOL = 'perplexity/image_search';

assertPriced(
  [
    config.chat.model,
    config.plan.model,
    config.action.model,
    config.write.model,
    config['image-instruction'].model,
    config['image-draw'].model,
    config['image-judge'].model,
    config['infographic-draw'].model,
    config['infographic-judge'].model,
    config.review.model,
    config['prompt-make'].model,
    config['prompt-normalize'].model,
    config['prompt-extract'].model,
    config.view.model,
    config.search.model,
  ],
  [SEARCH_TOOL, IMAGE_SEARCH_TOOL],
);

/** 노드 설정대로 LangChain 채팅 모델을 만든다. */
export function chatModel(node: AgentNode): BaseChatModel {
  const { provider, model, params: p } = config[node];
  switch (provider) {
    case 'google-genai':
      return new ChatGoogleGenerativeAI({ ...p, model });
    case 'perplexity':
      return new ChatPerplexity({ ...p, model });
  }
}
