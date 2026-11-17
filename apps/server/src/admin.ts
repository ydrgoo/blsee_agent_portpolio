import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { ADMIN_PAGE } from './admin-page';
import { accountOf, addKey, loadKeys, parseWood, removeKey, updateKey, type AccessKey } from './keys';
import { addRelease, listReleases, removeRelease, setCurrent } from './releases';

/** 관리자 토큰이 너무 짧으면 관리자 화면을 켜지 않는다. */
const MIN_TOKEN_LENGTH = 16;
/** 토큰이 틀렸을 때 늦게 답해 마구 넣어 보기를 느리게 한다. */
const WRONG_TOKEN_DELAY_MS = 1000;

export function adminTokenProblem(): string | null {
  const token = process.env.ADMIN_TOKEN ?? '';
  if (!token) return 'ADMIN_TOKEN이 없어 관리자 화면이 꺼져 있습니다.';
  if (token.length < MIN_TOKEN_LENGTH) return `ADMIN_TOKEN이 ${MIN_TOKEN_LENGTH}자보다 짧아 관리자 화면이 꺼져 있습니다.`;
  return null;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

function tokenMatches(got: string): boolean {
  return timingSafeEqual(digest(got), digest(process.env.ADMIN_TOKEN ?? ''));
}

function view(k: AccessKey) {
  return { ...accountOf(k), key: k.key, disabled: !!k.disabled, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt ?? null };
}

/** 관리자 화면 (/admin)과 그 API (/admin/api/*). 관리자 토큰을 Authorization: Bearer 로 받는다. */
export const admin = new Hono();

admin.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
});

admin.get('/', (c) => c.html(ADMIN_PAGE));

admin.use('/api/*', async (c, next) => {
  const problem = adminTokenProblem();
  if (problem) return c.json({ error: problem }, 503);
  const got = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!tokenMatches(got)) {
    await new Promise((r) => setTimeout(r, WRONG_TOKEN_DELAY_MS));
    return c.json({ error: '관리자 토큰이 맞지 않습니다.' }, 401);
  }
  await next();
});

admin.onError((e, c) => c.json({ error: e.message }, 400));

const body = async (c: { req: { json: () => Promise<unknown> } }) =>
  ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

admin.get('/api/keys', (c) => c.json({ keys: loadKeys().map(view) }));

admin.post('/api/keys', async (c) => {
  const b = await body(c);
  const k = addKey(String(b.name ?? ''), parseWood(b.wood));
  console.log(`[admin] 키 발급: ${k.name} (${k.granted})`);
  return c.json(view(k));
});

admin.post('/api/keys/:name/topup', async (c) => {
  const wood = parseWood((await body(c)).wood);
  const k = updateKey(c.req.param('name'), (x) => (x.granted += wood));
  console.log(`[admin] 충전: ${k.name} +${wood}`);
  return c.json(view(k));
});

admin.post('/api/keys/:name/set', async (c) => {
  const wood = parseWood((await body(c)).wood);
  const k = updateKey(c.req.param('name'), (x) => (x.granted = wood));
  console.log(`[admin] 준 장작 변경: ${k.name} = ${wood}`);
  return c.json(view(k));
});

admin.post('/api/keys/:name/disable', (c) => c.json(view(updateKey(c.req.param('name'), (x) => (x.disabled = true)))));

admin.post('/api/keys/:name/enable', (c) => c.json(view(updateKey(c.req.param('name'), (x) => delete x.disabled))));

admin.delete('/api/keys/:name', (c) => {
  const k = removeKey(c.req.param('name'));
  console.log(`[admin] 키 삭제: ${k.name}`);
  return c.json({ ok: true });
});

admin.get('/api/releases', (c) => c.json(listReleases()));

admin.post('/api/releases', async (c) => {
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) throw new Error('zip 파일을 골라 주세요.');
  const r = addRelease(Buffer.from(await file.arrayBuffer()), String(form.version ?? ''), String(form.note ?? ''));
  console.log(`[admin] 설치 파일 올림: ${r.version} (${r.size} bytes)`);
  return c.json(r);
});

admin.post('/api/releases/:id/current', (c) => {
  const r = setCurrent(c.req.param('id'));
  console.log(`[admin] 설치 페이지 버전 변경: ${r.version}`);
  return c.json(r);
});

admin.delete('/api/releases/:id', (c) => {
  const r = removeRelease(c.req.param('id'));
  console.log(`[admin] 설치 파일 삭제: ${r.version}`);
  return c.json({ ok: true });
});
