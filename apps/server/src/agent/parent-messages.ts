import type { BaseMessage } from 'langchain';

/** 도구 runtime.state.messages (없으면 빈 목록). */
export function parentMessagesFromRuntime(runtime: unknown): BaseMessage[] {
  if (!runtime || typeof runtime !== 'object') return [];
  const state = (runtime as { state?: { messages?: unknown } }).state;
  const msgs = state?.messages;
  return Array.isArray(msgs) ? (msgs as BaseMessage[]) : [];
}
