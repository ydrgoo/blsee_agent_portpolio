import { tool } from 'langchain';
import { z } from 'zod';
import type { AskAnswer, AskRequest } from '@blog-helper/shared';
import { keyCheckOff } from '../keys';
import type { UsageMeter } from '../usage';
import { concretizeBrief } from './concretize';
import type { UserRequests } from './messages';
import { runImageCycle, type ImageSeedInfo } from './image-cycle';
import { parentMessagesFromRuntime } from './parent-messages';
import {
  MADE,
  REFS_MAX,
  RESULT_NOTE,
  failText,
  nameField,
  type CallDocTool,
  type NotifyStep,
} from './tools';

export type { ImageSeedInfo as ImageRequestInfo };

const INSTRUCTIONS_MAX = 8;
const LABEL_CHARS = 30;

interface MakeImageArgs {
  instructions: string[];
  context: string;
  original?: string;
  refs?: { uri: string; role: string }[];
  name?: string;
}

const clip = (s: string) => (s.length > LABEL_CHARS ? `${s.slice(0, LABEL_CHARS)}…` : s);

/** 계획 전용: 이미지 사이클에 이미지 하나를 맡기는 make_image 도구 */
export function createMakeImageTool(o: {
  call: CallDocTool;
  meter: UsageMeter;
  locale: string;
  notify: NotifyStep;
  info: ImageSeedInfo;
  /** 사용자 메시지 번호와 원문 (구체화가 고른다) */
  requests?: UserRequests;
  ask: (req: AskRequest) => Promise<AskAnswer>;
  signal?: AbortSignal;
}) {
  const makeImage = async (args: MakeImageArgs, runtime: unknown) => {
    o.notify(true, `이미지 생성: ${clip(args.name || args.instructions[0])}`);
    const parentMessages = parentMessagesFromRuntime(runtime);
    const brief = await concretizeBrief({
      messages: parentMessages,
      requests: o.requests,
      instructions: args.instructions,
      context: args.context,
      meter: o.meter,
      signal: o.signal,
    });
    const detailed = { ...args, instructions: brief.instructions, context: brief.context, requests: brief.requests };
    if (keyCheckOff()) {
      console.log(`[image-agent] make_image 시작\nname=${args.name ?? '(없음)'}\noriginal=${args.original ?? '(없음)'}\nparents=${parentMessages.length}`);
    }
    try {
      const { uri, message } = await runImageCycle(
        {
          call: o.call,
          meter: o.meter,
          locale: o.locale,
          notify: o.notify,
          ask: o.ask,
          signal: o.signal,
        },
        { args: detailed, info: o.info },
        args.name || args.instructions[0],
      );
      if (!uri) return `실패: 이미지를 만들지 못했다.${message ? ` 이미지 생성: ${message}` : ''}`;
      return [`${uri} ${MADE}`, message && `이미지 생성 메모: ${message}`].filter(Boolean).join('\n');
    } catch (err) {
      if (o.signal?.aborted) throw err;
      return failText(err);
    }
  };

  return tool(makeImage, {
    name: 'make_image',
    description:
      '사진·일러스트 이미지 하나를 생성한다. 글에 있는 이미지 고치기, 이미지 속 대상으로 새 그림, 웹에서 찾은 이미지 쓰기를 이것으로 한다. ' +
      '고칠 이미지는 original에, 생김새를 따를 이미지는 refs에 URI로 넘긴다. 한 번에 이미지 하나. ' +
      `표·카드·도형·그래프처럼 글자와 배치가 정확해야 하는 그림은 make_infographic. ${RESULT_NOTE}`,
    schema: z.object({
      instructions: z
        .array(z.string().min(1))
        .min(1)
        .max(INSTRUCTIONS_MAX)
        .describe('이 이미지 한 장에 대한 지시 목록: 무엇을 만들지, 바꿀 점, 지킬 점을 상세히. 다시 그릴 때는 고칠 점'),
      context: z.string().min(1).describe('글 주제·넣을 자리·대화에서 합의한 방향'),
      original: z
        .string()
        .regex(/^blsee:\/\/\S+$/)
        .optional()
        .describe('고칠 이미지 URI (글 속 이미지, 보관 이미지, 이전 결과). 고치거나 다시 그릴 대상이 있을 때만'),
      refs: z
        .array(
          z.object({
            uri: z.string().regex(/^blsee:\/\/\S+$/).describe('이미지 URI'),
            role: z.string().min(1).describe('역할 (예: "캐릭터 생김새", "장소 생김새", "화풍 참고")'),
          }),
        )
        .max(REFS_MAX + 1)
        .optional()
        .describe('original 밖에 생김새·화풍을 참고할 이미지와 역할'),
      name: nameField,
    }),
  });
}
