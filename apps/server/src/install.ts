import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { ACCESS_KEY_HEADER } from '@blog-helper/shared';
import { INSTALL_PAGE } from './install-page';
import { accountForKey } from './keys';
import { currentRelease } from './releases';

const WRONG_KEY_DELAY_MS = 1000;

/** 설치 페이지 (/install). 안내와 다운로드는 접근 키가 있어야 보인다. */
export const install = new Hono();

install.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
});

install.get('/', (c) => c.html(INSTALL_PAGE));

install.use('/api/*', async (c, next) => {
  if (!accountForKey(c.req.header(ACCESS_KEY_HEADER))) {
    await new Promise((r) => setTimeout(r, WRONG_KEY_DELAY_MS));
    return c.json({ error: '접근 키가 맞지 않습니다. 받은 키를 다시 확인해 주세요.' }, 401);
  }
  await next();
});

install.get('/api/info', (c) => {
  const account = accountForKey(c.req.header(ACCESS_KEY_HEADER))!;
  const r = currentRelease();
  return c.json({
    name: account.name,
    release: r && { version: r.version, note: r.note, size: r.size, updatedAt: r.uploadedAt },
  });
});

install.get('/api/download', (c) => {
  const r = currentRelease();
  if (!r) return c.json({ error: '아직 올린 설치 파일이 없습니다.' }, 404);
  console.log(`[install] 다운로드: ${accountForKey(c.req.header(ACCESS_KEY_HEADER))!.name} (${r.version})`);
  return c.body(readFileSync(r.path), 200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="blsee-${r.version}.zip"`,
  });
});
