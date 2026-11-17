/**
 * 예시를 따라 하다 도구를 부르지 않고 글로 쓰는 실수를 잡는다.
 * 예: "[review(notes: …)]", "review(…)" 같은 호출 모양, 예시의 "동작:" 줄을 답에 그대로 쓴 것.
 */
import { AIMessage, type BaseMessage } from 'langchain';

/** 다시 시킬 때 주는 말 */
export const TOOL_AS_TEXT_FIX =
  '방금 도구로 할 일을 글로 썼다. 그 일은 도구를 실제로 불러서 하고, 답 글이나 출력에는 그 결과만 쓴다.';

/** 마지막 모델 답 글 */
function lastText(messages: BaseMessage[]): string {
  const last = [...messages].reverse().find((m) => AIMessage.isInstance(m));
  return last?.text ?? '';
}

/** 마지막 답 글에 도구 호출 모양이나 예시의 "동작:" 줄이 있으면 true */
export function wroteToolAsText(messages: BaseMessage[], toolNames: string[]): boolean {
  const text = lastText(messages);
  if (!text) return false;
  if (/^\s*동작:/m.test(text)) return true;
  if (!toolNames.length) return false;
  const names = toolNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?:^|[\\s\\[(])(?:${names})\\(`, 'm').test(text);
}
