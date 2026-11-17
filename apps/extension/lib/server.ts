import {
  ACCESS_KEY_HEADER,
  AGENT_WS_PATH,
  HEALTH_PATH,
  IMAGE_DESCRIBE_PATH,
  IMAGE_EDIT_PATH,
  type ClientMessage,
  type DocToolName,
  type HealthResponse,
  type ImageDescribeRequest,
  type ImageDescribeResponse,
  type ImageEditRequest,
  type ImageEditResponse,
  type ReviewResult,
  type ServerMessage,
  type UsageEntry,
  type UsagePurpose,
  askAnswerSchema,
  type AskAnswer,
  type AskRequest,
  type PlanTaskView,
  type TaskState,
  type AccessError,
} from '@blog-helper/shared';
import { loadSettings, type ServerChoice } from './settings';

/** 서버 주소. 상용 서버 주소는 .env 의 WXT_API_BASE_URL 이고, wxt.config.ts가 같은 값으로 host_permissions를 만든다. */
export const SERVERS: Record<ServerChoice, { label: string; url: string }> = {
  prod: { label: '상용 서버', url: import.meta.env.WXT_API_BASE_URL ?? '' },
  local: { label: '개발 서버', url: 'http://localhost:8787' },
};

export interface Connection {
  server: ServerChoice;
  url: string;
  key: string;
}

/** 지금 붙을 서버와 접근 키. 배포 빌드는 설정과 관계없이 상용 서버에 붙는다. */
export async function connection(force?: ServerChoice): Promise<Connection> {
  const s = await loadSettings();
  // 시험 빌드(wxt build --mode e2e)는 로컬 개발 서버에 붙는다.
  const server = force ?? (import.meta.env.MODE === 'e2e' ? 'local' : import.meta.env.DEV ? s.server : 'prod');
  return { server, url: SERVERS[server].url, key: s.accessKey.trim() };
}

/** 요청을 보낼 연결. 상용 서버 주소 없이 빌드했으면 여기서 멈춘다. */
async function target(force?: ServerChoice): Promise<Connection> {
  const c = await connection(force);
  if (!c.url) {
    throw new Error('상용 서버 주소가 없습니다. apps/extension/.env 에 WXT_API_BASE_URL 을 넣고 다시 빌드해 주세요.');
  }
  return c;
}

function connectError({ server, url }: Connection): Error {
  return new Error(
    server === 'local'
      ? `개발 서버(${url})에 연결하지 못했습니다. 터미널에서 npm run dev:server 로 서버를 켜 주세요.`
      : `서버(${url})에 연결하지 못했습니다. 인터넷 연결을 확인하고 잠시 뒤 다시 시도해 주세요.`,
  );
}

/** 서버가 보낸 오류. code가 있으면 접근 키나 장작 문제다. */
export class ServerError extends Error {
  constructor(
    message: string,
    readonly code?: AccessError,
  ) {
    super(message);
  }
}

/** key를 주면 그 키로 확인한다 (설정에 저장하기 전에 확인할 때). server를 주면 그 서버에 묻는다. */
export async function checkHealth(key?: string, server?: ServerChoice): Promise<HealthResponse> {
  const c = await target(server);
  let res: Response;
  try {
    res = await fetch(`${c.url}${HEALTH_PATH}`, { headers: { [ACCESS_KEY_HEADER]: key ?? c.key } });
  } catch {
    throw connectError(c);
  }
  if (!res.ok) throw new Error(`서버 오류 ${res.status}`);
  return res.json();
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const c = await target();
  let res: Response;
  try {
    res = await fetch(`${c.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ACCESS_KEY_HEADER]: c.key },
      body: JSON.stringify(body),
    });
  } catch {
    throw connectError(c);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ServerError(json?.error ?? `서버 오류 ${res.status}`, json?.code);
  return json as T;
}

export const editImage = (req: ImageEditRequest) => postJson<ImageEditResponse>(IMAGE_EDIT_PATH, req);
export const describeImages = (req: ImageDescribeRequest) =>
  postJson<ImageDescribeResponse>(IMAGE_DESCRIBE_PATH, req);

export interface RunAgentInput {
  /** 접근 키는 설정에서 읽어 붙인다. */
  start: Omit<Extract<ClientMessage, { type: 'start' }>, 'key'>;
  /** 서버가 부른 문서 도구를 실행하고 결과 글을 돌려준다. */
  onToolCall: (name: DocToolName, args: Record<string, unknown>) => Promise<string>;
  /** 서버에서만 도는 도구(검색 등)의 진행 표시 */
  onStep?: (ok: boolean, text: string) => void;
  /** 에이전트가 작업 목록을 세웠을 때 (검토 후 다시 세우면 round가 늘어난다) */
  onPlan?: (round: number, reason: 'review' | 'retry' | undefined, tasks: PlanTaskView[]) => void;
  /** 작업 하나의 진행 상태가 바뀌었을 때 */
  onTask?: (round: number, id: string, state: TaskState, text?: string) => void;
  /** 점검 결과가 나왔을 때 */
  onReview?: (review: ReviewResult) => void;
  /** 편집이 반영되어 점검 결과가 만료됐을 때 */
  onReviewClear?: () => void;
  /** 이 요청에서 지금까지 쓴 장작 (누적값: 전체, 용도별) */
  onCost?: (wood: number, byPurpose: Partial<Record<UsagePurpose, number>>) => void;
  /** 에이전트가 사용자에게 물을 때. 답을 돌려주면 에이전트가 이어서 일한다. */
  onAsk: (req: AskRequest) => Promise<AskAnswer>;
  signal: AbortSignal;
}

export interface AgentResult {
  reply: string;
  usage: UsageEntry[];
}

/** 요청 하나를 WebSocket으로 실행하고 에이전트의 마지막 답변과 사용량을 돌려준다. */
export async function runAgent(input: RunAgentInput): Promise<AgentResult> {
  return openAgent(input, await target());
}

function openAgent({
  start,
  onToolCall,
  onStep,
  onPlan,
  onTask,
  onReview,
  onReviewClear,
  onCost,
  onAsk,
  signal,
}: RunAgentInput, conn: Connection): Promise<AgentResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${conn.url.replace(/^http/, 'ws')}${AGENT_WS_PATH}`);
    let reply = '';
    let usage: UsageEntry[] = [];
    let settled = false;
    /** 질문 카드 줄: 앞 카드에 답해야 다음 카드를 띄운다. */
    let askChain: Promise<unknown> = Promise.resolve();

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve({ reply, usage });
      if (ws.readyState <= WebSocket.OPEN) ws.close();
    };
    const onAbort = () => finish(new DOMException('중지했습니다.', 'AbortError'));
    signal.addEventListener('abort', onAbort);

    const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));

    ws.onopen = () => send({ ...start, key: conn.key });
    ws.onerror = () => finish(connectError(conn));
    ws.onclose = () => finish(new Error('서버 연결이 도중에 끊겼습니다.'));
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as ServerMessage;
      switch (msg.type) {
        case 'tool_call':
          onToolCall(msg.name, msg.args)
            .catch((err) => `실패: ${err instanceof Error ? err.message : String(err)}`)
            .then((content) => {
              if (!settled) send({ type: 'tool_result', callId: msg.callId, content });
            });
          break;
        case 'step':
          onStep?.(msg.ok, msg.text);
          break;
        case 'plan':
          onPlan?.(msg.round, msg.reason, msg.tasks);
          break;
        case 'task':
          onTask?.(msg.round, msg.id, msg.state, msg.text);
          break;
        case 'review':
          onReview?.(msg.review);
          break;
        case 'review_clear':
          onReviewClear?.();
          break;
        case 'reply':
          reply = msg.text;
          break;
        case 'ask': {
          // 서버는 질문을 하나씩 보내지만, 혹시 겹쳐 와도 카드가 덮이지 않게 앞 질문에 답한 뒤 다음 질문을 띄운다.
          const req = {
            question: msg.question,
            requestedSchema: msg.requestedSchema ?? askAnswerSchema(),
            ...(typeof msg.dontAskKey === 'string' && msg.dontAskKey ? { dontAskKey: msg.dontAskKey } : {}),
          };
          const asked = askChain.then(() => (settled ? null : onAsk(req)));
          askChain = asked.catch(() => undefined);
          asked.then(
            (answer) => {
              if (settled || !answer) return;
              if (answer.action === 'accept') {
                send({ type: 'answer', action: 'accept', content: answer.content });
              } else if (answer.action === 'decline') {
                send({
                  type: 'answer',
                  action: 'decline',
                  ...(answer.content && Object.keys(answer.content).length ? { content: answer.content } : {}),
                });
              } else {
                send({ type: 'answer', action: answer.action });
              }
            },
            (err) => finish(err instanceof Error ? err : new Error(String(err))),
          );
          break;
        }
        case 'cost':
          onCost?.(msg.wood, msg.byPurpose ?? {});
          break;
        case 'done':
          usage = msg.usage ?? [];
          finish();
          break;
        case 'error':
          finish(new ServerError(msg.message, msg.code));
          break;
        case 'ping':
          break;
      }
    };
  });
}
