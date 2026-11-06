import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

/**
 * Regression: static hosting + SPA fallback must serve the client build.
 * Root cause of the original bug: clientDistDir resolved relative to the
 * compiled module (dist/config/env.js) instead of the package root, so
 * existsSync() was false and NO static middleware was registered at all.
 */

const INDEX_HTML = '<!DOCTYPE html><html lang="zh-CN"><body><div id="root"></div></body></html>';
const APP_JS = 'console.log("codelens");';
const FAVICON = 'icon-bytes';

let clientRoot = '';
let clientDistDir = '';

beforeAll(() => {
  clientRoot = mkdtempSync(path.join(tmpdir(), 'codelens-static-'));
  clientDistDir = path.join(clientRoot, 'dist-client');
  mkdirSync(path.join(clientDistDir, 'assets'), { recursive: true });
  writeFileSync(path.join(clientDistDir, 'index.html'), INDEX_HTML);
  writeFileSync(path.join(clientDistDir, 'assets', 'app.js'), APP_JS);
  // A non-hashed root file (what public/ assets land as): must NOT be frozen.
  writeFileSync(path.join(clientDistDir, 'favicon.ico'), FAVICON);
});

afterAll(() => {
  // 宿主环境的删除守卫（safe-delete shim）可能在并发下超时。
  // 清理是 best-effort：残留目录由环境侧回收，但不能让它把已通过的用例判红。
  try {
    rmSync(clientRoot, { recursive: true, force: true });
  } catch (err) {
    console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
  }
});

function app() {
  return createApp({ clientDistDir });
}

describe('static hosting + SPA fallback', () => {
  it('GET / serves index.html when the client dist exists', async () => {
    const res = await request(app()).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="root"');
  });

  it('GET / serves index.html even without an Accept: text/html header', async () => {
    const res = await request(app()).get('/').set('Accept', '*/*');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="root"');
  });

  it('GET /index.html serves the file directly', async () => {
    const res = await request(app()).get('/index.html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="root"');
  });

  it('GET /assets/app.js serves static assets with immutable cache headers', async () => {
    const res = await request(app()).get('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.text).toBe(APP_JS);
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('P2-12: the SPA shell (GET / and /index.html) revalidates — no-cache, not 1y', async () => {
    for (const url of ['/', '/index.html']) {
      const res = await request(app()).get(url);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toContain('no-cache');
      expect(res.headers['cache-control']).not.toContain('immutable');
    }
  });

  it('P2-12: non-hashed root files revalidate instead of being frozen for a year', async () => {
    const res = await request(app()).get('/favicon.ico');
    expect(res.status).toBe(200);
    // .ico is served as binary — supertest surfaces it as a Buffer body.
    expect(Buffer.from(res.body as Buffer).toString('utf8')).toBe(FAVICON);
    expect(res.headers['cache-control']).toContain('no-cache');
  });

  it('GET /deep/spa/route falls back to index.html (history mode)', async () => {
    const res = await request(app()).get('/deep/spa/route');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="root"');
  });

  it('unknown /api path stays a JSON 404 with static hosting enabled', async () => {
    const res = await request(app()).get('/api/v1/unknown');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('P2-12: POST to a non-API path is a JSON 404, not Express default HTML', async () => {
    const res = await request(app()).post('/some/unknown/path').send({ a: 1 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(String(res.headers['content-type'])).toContain('application/json');
  });

  it('P2-11: malformed JSON is a 400 VALIDATION_ERROR JSON shell', async () => {
    const res = await request(app())
      .post('/api/v1/agent/stream')
      .type('application/json')
      .send('{"message": "oops"');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('missing client dist dir does not crash; GET / returns 404', async () => {
    const res = await request(createApp({ clientDistDir: path.join(clientRoot, 'nonexistent') })).get('/');
    expect(res.status).toBe(404);
  });
});
