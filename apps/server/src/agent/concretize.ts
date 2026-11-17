import { HumanMessage, SystemMessage, type BaseMessage } from 'langchain';
import { z } from 'zod';
import { chatModel, config } from '../config';
import { keyCheckOff } from '../keys';
import { usageCallback, type UsageMeter } from '../usage';
import { withMetadata, type UserRequests } from './messages';
import { EXAMPLE_NOTE } from './prompt';

const briefSchema = z.object({
  instructions: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      '구체화된 지시 목록. 원래 지시 하나하나에 대화에서 찾은 조건을 더한다. 사용자가 직접 적은 지시는 그대로 유지해 어느 항목엔가 들어간다',
    ),
  context: z.string().min(1).describe('구체화된 맥락: 글 주제, 넣을 자리, 대화에서 합의한 방향'),
  user_requests: z
    .array(z.number().int())
    .default([])
    .describe('이 그림에 대한 사용자 지시를 직접 적은 사용자 메시지의 [Metadata] id. 앞 턴의 요청을 다시 하는 경우 그 앞 턴 id도 넣는다. 없으면 비운다'),
});

const sceneSchema = z.object({
  scene: z.string().min(1).describe('구체화된 장면 지시: 장면, 분위기, 인물·소품, 참고 대상'),
});

const BRIEF_PROMPT = `너의 일은 작업 지시 구체화다.

입력:
- 앞의 메시지는 지금까지의 대화다. 사용자 메시지 끝의 [Metadata] id는 그 메시지의 번호다.
- 맨 끝 메시지의 [지시]는 대화 담당이 적은 그림 지시이고, [맥락]은 글 주제·넣을 자리다.

구체화하는 법:
- 주어진 지시에, 대화에 있는 합의·제약·스타일·고칠 점을 빠짐없이 옮긴다.
- 대화에 사용자가 직접 적은 지시가 있으면, 그대로 유지하여 지시사항에 포함한다. 수치, 이름, 문구, 개수, 넣을 것, 넣지 말 것은 사용자가 쓴 그대로 옮긴다.
- 사용자 지시가 길고 자세하면 지시사항도 그만큼 자세하게 쓴다. 조건 하나에 항목 하나를 둔다.
- 주어진 지시가 사용자 지시보다 짧게 줄어 있으면, 사용자 지시에 맞춰 빠진 조건을 채운다.
- 장면, 사실, 수치, 문구는 대화와 지시에 있는 것을 쓴다.
- 이 그림에 대한 사용자 지시를 직접 적은 메시지의 id를 사용자 요청으로 고른다. "다시 해"처럼 앞 요청을 이어 가는 메시지면 원래 요청을 적은 앞 메시지 id도 함께 고른다.

${EXAMPLE_NOTE}

## 예시 상황: 자세한 사용자 지시가 짧게 줄어 넘어옴
입력:
(사용자) 첨부한 캐릭터를 귀여운 낙서 콜라주 시트로 그려 줘. 흰 종이에 검은 펜 선, 포인트 색은 노랑 한 곳만. 앞·옆·뒤 모습과 표정 3가지를 넣고, 맨 아래에 이름 "몽실이"를 손글씨로 써 줘. 배경 무늬는 넣지 마.
[Metadata] id: 1
[지시] 1. 첨부한 캐릭터를 낙서풍 시트로 그린다

동작:
- 없음

응답:
지시:
1. 첨부한 캐릭터를 귀여운 낙서 콜라주 스타일의 시트로 그린다
2. 흰 종이에 검은 펜 선으로 그린다
3. 포인트 색은 노랑 한 곳에만 쓴다
4. 앞 모습, 옆 모습, 뒤 모습을 넣는다
5. 표정 3가지를 넣는다
6. 맨 아래에 이름 "몽실이"를 손글씨로 쓴다
7. 배경 무늬는 넣지 않는다
사용자 요청: 1

## 예시 상황: 앞서 정한 방향에 고칠 점만 더함
입력:
(사용자) 제주 바다 사진 느낌으로, 해 질 녘, 사람 없이 그려 줘.
[Metadata] id: 3
(답) 그림을 넣었어요.
(사용자) 다시 해 줘. 하늘을 더 붉게.
[Metadata] id: 4
[지시] 1. 하늘을 더 붉게 다시 그린다

동작:
- 없음

응답:
지시:
1. 제주 바다 풍경을 사진처럼 그린다
2. 시간은 해 질 녘으로 한다
3. 사람은 넣지 않는다
4. 하늘을 지난번보다 더 붉게 한다
사용자 요청: 3, 4`;

const SCENE_PROMPT = `너의 일은 인포그래픽용 배경·일러스트 장면 지시 구체화다.
주어진 장면에, 대화에 있는 합의·제약·스타일·참고 대상을 빠짐없이 옮긴다.
대화에 사용자가 직접 적은 지시가 있으면, 그대로 유지하여 장면 지시에 포함한다.
장면과 사실은 대화와 지시에 있는 것을 쓴다.
그림은 글자 없이 그린다. 제목·문구·로고 글자는 HTML이 맡는다.`;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function transcript(messages: BaseMessage[]): string {
  return messages
    .map((m) => {
      const text = textOf(m.content);
      if (!text) return '';
      const role = typeof m.getType === 'function' ? m.getType() : 'message';
      return `${role}: ${text}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

/** 구체화 결과. requests는 고른 사용자 메시지의 원문이다 (그림 담당이 상태로 들고 쓴다). */
export interface Brief {
  instructions: string[];
  context: string;
  requests: string[];
}

/**
 * 대화에 있는 조건을 지시·맥락에 옮기고, 사용자 지시를 적은 메시지를 고른다. 실패하면 원래 지시를 그대로 돌려준다.
 * 입력은 대화 메시지 그대로(사용자 메시지에 [Metadata]) + 끝에 지시 메시지다.
 */
export async function concretizeBrief(
  o: {
    messages: BaseMessage[];
    requests?: UserRequests;
    instructions: string[];
    context: string;
    meter: UsageMeter;
    signal?: AbortSignal;
  },
): Promise<Brief> {
  const fallback = { instructions: o.instructions, context: o.context, requests: [] };
  try {
    const model = chatModel('image-instruction').withStructuredOutput(briefSchema);
    const out = (await model.invoke(
      [
        new SystemMessage(BRIEF_PROMPT),
        ...withMetadata(o.messages, o.requests),
        new HumanMessage(
          [`[지시]\n${o.instructions.map((s, i) => `${i + 1}. ${s}`).join('\n')}`, `[맥락]\n${o.context}`].join('\n\n'),
        ),
      ],
      { signal: o.signal, callbacks: [usageCallback(o.meter, config['image-instruction'].model, 'image_agent')] },
    )) as z.infer<typeof briefSchema>;
    if (!out?.instructions?.length || !out.context?.trim()) return fallback;
    const ids = [...new Set(out.user_requests ?? [])].sort((a, b) => a - b);
    const requests = ids.flatMap((id) => {
      const text = o.requests?.textOf.get(id)?.trim();
      return text ? [text] : [];
    });
    if (keyCheckOff()) {
      console.log(`[concretize] 지시 ${out.instructions.length}개 · 사용자 요청 ${ids.join(', ') || '없음'}\n${out.instructions.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
    }
    return { instructions: out.instructions, context: out.context.trim(), requests };
  } catch (err) {
    if (o.signal?.aborted) throw err;
    return fallback;
  }
}

/** 인포 request_pixel의 장면 지시를 구체화한다. 실패하면 원래 장면을 돌려준다. */
export async function concretizeScene(o: {
  messages: BaseMessage[];
  scene: string;
  meter: UsageMeter;
  signal?: AbortSignal;
}): Promise<string> {
  try {
    const model = chatModel('image-instruction').withStructuredOutput(sceneSchema);
    const out = (await model.invoke(
      [
        { role: 'system', content: SCENE_PROMPT },
        {
          role: 'user',
          content: [`[대화]\n${transcript(o.messages) || '(없음)'}`, `[장면]\n${o.scene}`].join('\n\n'),
        },
      ],
      { signal: o.signal, callbacks: [usageCallback(o.meter, config['image-instruction'].model, 'image_agent')] },
    )) as z.infer<typeof sceneSchema>;
    return out?.scene?.trim() || o.scene;
  } catch (err) {
    if (o.signal?.aborted) throw err;
    return o.scene;
  }
}
