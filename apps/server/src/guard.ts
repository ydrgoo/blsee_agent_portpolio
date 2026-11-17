import { createMiddleware } from 'hono/factory';

/**
 * 로그인을 붙이기 전까지의 최소한의 보호.
 * 웹페이지(http/https 출처)에서 오는 호출은 막고, 확장 사이드패널과 출처 없는 호출(curl 등)만 받는다.
 */
export const rejectWebOrigin = createMiddleware(async (c, next) => {
  const origin = c.req.header('origin');
  if (origin && !origin.startsWith('chrome-extension://')) {
    return c.json({ error: '허용되지 않은 출처입니다.' }, 403);
  }
  await next();
});
