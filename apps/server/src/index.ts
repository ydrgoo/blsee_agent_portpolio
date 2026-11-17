import { serve, upgradeWebSocket } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { WebSocketServer } from 'ws';
import {
  ACCESS_KEY_HEADER,
  AGENT_WS_PATH,
  HEALTH_PATH,
  IMAGE_DESCRIBE_PATH,
  IMAGE_EDIT_PATH,
  type HealthResponse,
} from '@blog-helper/shared';
import { admin, adminTokenProblem } from './admin';
import { agentSocket } from './agent-socket';
import { config } from './config';
import { describeImages, editImage, parseDescribeRequest, parseEditRequest } from './image';
import { rejectWebOrigin } from './guard';
import { install } from './install';
import { privacyPage } from './privacy-page';
import { accountForKey, charge, checkAccess, keyCheckOff, loadKeys } from './keys';
import { UsageMeter } from './usage';

const app = new Hono();

app.use('/api/*', rejectWebOrigin);
app.route('/admin', admin);
app.route('/install', install);
app.get('/', (c) => c.redirect('/install'));
app.get('/privacy', (c) => c.html(privacyPage()));

app.get(HEALTH_PATH, (c) =>
  c.json({
    ok: true,
    hasApiKey: Boolean(process.env.GOOGLE_API_KEY),
    account: accountForKey(c.req.header(ACCESS_KEY_HEADER)),
  } satisfies HealthResponse),
);

app.get(AGENT_WS_PATH, upgradeWebSocket(() => agentSocket()));

/** 접근 키를 확인하고, 처리에 쓴 장작을 그 키에 더한다. */
async function metered(c: Context, handle: (meter: UsageMeter) => Promise<unknown>) {
  const key = c.req.header(ACCESS_KEY_HEADER) ?? '';
  const access = checkAccess(key);
  if (!access.ok) return c.json({ error: access.message, code: access.code }, access.code === 'key' ? 401 : 402);
  const meter = new UsageMeter();
  try {
    return c.json((await handle(meter)) as object);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  } finally {
    charge(key, meter.wood);
    console.log(`[usage] ${access.account.name} · ${meter.summary()}`);
  }
}

app.post(IMAGE_EDIT_PATH, (c) =>
  metered(c, async (meter) => editImage(parseEditRequest(await c.req.json()), meter)),
);

app.post(IMAGE_DESCRIBE_PATH, (c) =>
  metered(c, async (meter) => describeImages(parseDescribeRequest(await c.req.json()), meter)),
);

const port = Number(process.env.PORT) || 8787;
serve({ fetch: app.fetch, port, websocket: { server: new WebSocketServer({ noServer: true }) } }, (info) => {
  console.log(`블씨 서버: http://localhost:${info.port}`);
  const key = (name: string) => (process.env[name] ? '있음' : '없음 (.env 확인)');
  const { chat, plan, action, write, view, search } = config;
  console.log(
    `모델: 대화 ${chat.model} · 계획 ${plan.model} · 고치기 ${action.model} · 쓰기 ${write.model} · 보기 ${view.model} · ` +
      `검색 ${search.model}(${search.search_type})`,
  );
  console.log(
    `이미지: 지시 ${config['image-instruction'].model} · 그리기 ${config['image-draw'].model} · 판정 ${config['image-judge'].model} / ` +
      `인포그래픽: 그리기 ${config['infographic-draw'].model} · 판정 ${config['infographic-judge'].model} / 점검 ${config.review.model} / 프롬프트: 만들기 ${config['prompt-make'].model} · 정리 ${config['prompt-normalize'].model} · 추출 ${config['prompt-extract'].model}`,
  );
  console.log(`API 키: Google ${key('GOOGLE_API_KEY')} · Perplexity ${key('PERPLEXITY_API_KEY')}`);
  const keys = loadKeys();
  console.log(
    keyCheckOff()
      ? '접근 키 검사 꺼짐 (ACCESS_KEY_CHECK=off): 키 없이 누구나 쓸 수 있습니다. 개발용으로만 쓰세요.'
      : keys.length
        ? `접근 키 ${keys.length}개 (npm run key -- list)`
        : '발급한 접근 키가 없습니다. 관리자 화면이나 npm run key -- add <이름> <장작> 으로 만들어 주세요.',
  );
  console.log(`관리자 화면: ${adminTokenProblem() ?? `http://localhost:${info.port}/admin`}`);
});
