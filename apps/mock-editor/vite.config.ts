import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * 모의 편집기 서버.
 * - GET  /test-data            : 불러올 수 있는 글 목록 (test-data/document-data*.json)
 * - GET  /test-data/<파일>     : 글 데이터
 * - POST /upload               : 붙여넣은 이미지를 받아 주소를 돌려준다 (네이버 업로드 흉내)
 * - GET  /uploads/<id>         : 올린 이미지
 */
const TEST_DATA = fileURLToPath(new URL('../../test-data/', import.meta.url));
const uploads = new Map<string, { type: string; body: Buffer }>();

function mockServer(): Plugin {
  return {
    name: 'mock-editor-server',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/test-data') {
          const files = readdirSync(TEST_DATA).filter((f) => f.startsWith('document-data') && f.endsWith('.json'));
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(files));
          return;
        }
        if (req.method === 'GET' && url.pathname.startsWith('/test-data/')) {
          const name = decodeURIComponent(url.pathname.slice('/test-data/'.length));
          if (name.includes('/') || name.includes('..')) return next();
          res.setHeader('content-type', 'application/json');
          res.end(readFileSync(TEST_DATA + name));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/upload') {
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            const type = String(req.headers['content-type'] ?? 'image/png');
            const id = `${randomUUID()}.${type.split('/')[1] ?? 'png'}`;
            uploads.set(id, { type, body: Buffer.concat(chunks) });
            res.setHeader('content-type', 'application/json');
            res.setHeader('access-control-allow-origin', '*');
            res.end(JSON.stringify({ url: `http://localhost:5179/uploads/${id}` }));
          });
          return;
        }
        if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
          const file = uploads.get(url.pathname.slice('/uploads/'.length));
          if (!file) {
            res.statusCode = 404;
            res.end();
            return;
          }
          res.setHeader('content-type', file.type);
          res.setHeader('access-control-allow-origin', '*');
          res.end(file.body);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [mockServer()],
  server: { port: 5179, strictPort: true, cors: true },
});
