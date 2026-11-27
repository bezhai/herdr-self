// Tests of services.ts and of the services of the client's config (see package.json); run with node --test.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { serviceMethods, serviceUrl, serviceName, readCap } from './services.ts';
import type { Service } from './services.ts';
import { readConfig } from './client.ts';

const secret = 'svc-token-secret';
// A request that the fake service received.
type Seen = { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string };
// A fake service on an ephemeral loopback port, rooted at /api/v1; handler answers each request. The service is as the config parser gives it.
async function fixture(
  t: TestContext,
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  extra: Partial<Service> = {},
) {
  const seen: Seen[] = [],
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (s) => {
        body += s;
      });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        handler(req, res);
      });
    });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as { port: number },
    service: Service = {
      url: `http://127.0.0.1:${port}/api/v1`,
      token: secret,
      methods: ['GET', 'HEAD', 'POST'],
      headers: ['x-lang'],
      ...extra,
    };
  return { service, seen, call: serviceMethods({ notes: service }).callService };
}
const rejects = (p: unknown, code: string) =>
  assert.rejects(Promise.resolve(p), (e: Error & { code?: string }) => {
    assert.equal(e.code, code);
    assert.ok(!e.message.includes(secret));
    return true;
  });
const ok = (res: http.ServerResponse, type = 'application/json', body: string | Buffer = '{}') => {
  res.writeHead(200, { 'content-type': type });
  res.end(body);
};

test('the services of the config are read: name, url with its path as the root, token, and the methods and headers an agent may use, with defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-services-')),
    file = path.join(dir, 'client.json'),
    machine = { url: 'ws://127.0.0.1:9/api/client', token: 't' };
  const read = (services: unknown) => {
    fs.writeFileSync(file, JSON.stringify({ ...machine, services }), { mode: 0o600 });
    return readConfig(file);
  };
  try {
    fs.writeFileSync(file, JSON.stringify(machine), { mode: 0o600 });
    assert.equal(readConfig(file).services, undefined);
    assert.deepEqual(
      read({
        notes: { url: 'http://127.0.0.1:8081/api/v1/', token: 'a' },
        wiki: { url: 'https://localhost:9', token: 'b', methods: ['get', 'POST'], headers: ['x-lang', 'x-trace'] },
      }).services,
      {
        notes: { url: 'http://127.0.0.1:8081/api/v1', token: 'a', methods: ['GET', 'HEAD'], headers: [] },
        wiki: { url: 'https://localhost:9', token: 'b', methods: ['GET', 'POST'], headers: ['x-lang', 'x-trace'] },
      },
    );
    assert.deepEqual(read({}).services, {});
    assert.ok(
      serviceName.test('a') &&
        serviceName.test('open-x1') &&
        !serviceName.test('A') &&
        !serviceName.test('1a') &&
        !serviceName.test('a'.repeat(33)) &&
        !serviceName.test('a_b') &&
        !serviceName.test(''),
    );
    const at = (name: string) => `配置文件 ${file} 的 services.${name}`,
      good = { url: 'http://127.0.0.1:8081/v1', token: 'a' };
    for (const [services, error] of [
      [[], `配置文件 ${file} 的 services 必须是 {"<名字>": {"url": …, "token": …}}`],
      ['x', `配置文件 ${file} 的 services 必须是 {"<名字>": {"url": …, "token": …}}`],
      [{ Bad: good }, `配置文件 ${file} 的服务名「Bad」不合法，应匹配 [a-z][a-z0-9-]{0,31}`],
      [{ notes: 'x' }, `${at('notes')} 必须是 {"url": …, "token": …}`],
      [
        { notes: { ...good, url: 'http://example.com/v1' } },
        `${at('notes')}.url 必须是本机上服务的地址，http(s)，主机为 127.0.0.1、[::1] 或 localhost，不带查询参数和 #，例如 http://127.0.0.1:8081/v1`,
      ],
      [
        { notes: { ...good, url: 'ftp://127.0.0.1/v1' } },
        `${at('notes')}.url 必须是本机上服务的地址，http(s)，主机为 127.0.0.1、[::1] 或 localhost，不带查询参数和 #，例如 http://127.0.0.1:8081/v1`,
      ],
      [
        { notes: { ...good, url: 'http://127.0.0.1:8081/v1?x=1' } },
        `${at('notes')}.url 必须是本机上服务的地址，http(s)，主机为 127.0.0.1、[::1] 或 localhost，不带查询参数和 #，例如 http://127.0.0.1:8081/v1`,
      ],
      [
        { notes: { ...good, url: 'http://u:p@127.0.0.1:8081/v1' } },
        `${at('notes')}.url 必须是本机上服务的地址，http(s)，主机为 127.0.0.1、[::1] 或 localhost，不带查询参数和 #，例如 http://127.0.0.1:8081/v1`,
      ],
      [{ notes: { url: good.url } }, `${at('notes')} 缺少 token`],
      [{ notes: { ...good, token: '' } }, `${at('notes')} 缺少 token`],
      [
        { notes: { ...good, methods: 'GET' } },
        `${at('notes')}.methods 必须是 GET、HEAD、POST、PUT、PATCH、DELETE 中的若干个`,
      ],
      [
        { notes: { ...good, methods: ['TRACE'] } },
        `${at('notes')}.methods 必须是 GET、HEAD、POST、PUT、PATCH、DELETE 中的若干个`,
      ],
      [
        { notes: { ...good, headers: 'x-lang' } },
        `${at('notes')}.headers 必须是小写请求头名字的数组，不能含 authorization、host、content-type 等由客户端自己设置的头`,
      ],
      [
        { notes: { ...good, headers: ['X-Lang'] } },
        `${at('notes')}.headers 必须是小写请求头名字的数组，不能含 authorization、host、content-type 等由客户端自己设置的头`,
      ],
      [
        { notes: { ...good, headers: ['authorization'] } },
        `${at('notes')}.headers 必须是小写请求头名字的数组，不能含 authorization、host、content-type 等由客户端自己设置的头`,
      ],
      [
        { notes: { ...good, headers: ['content-type'] } },
        `${at('notes')}.headers 必须是小写请求头名字的数组，不能含 authorization、host、content-type 等由客户端自己设置的头`,
      ],
    ] satisfies [unknown, string][])
      assert.throws(() => read(services), { message: error });
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('serviceUrl puts a path under the root of the service with the query pairs URL-encoded, and rejects every other form', () => {
  const s: Service = { url: 'http://127.0.0.1:8081/api/v1', token: 'x', methods: ['GET'], headers: [] },
    bare: Service = { ...s, url: 'http://127.0.0.1:8081' };
  assert.equal(serviceUrl(s, '/', []).href, 'http://127.0.0.1:8081/api/v1');
  assert.equal(serviceUrl(s, '/', [['q', 'a b']]).href, 'http://127.0.0.1:8081/api/v1?q=a+b');
  assert.equal(serviceUrl(bare, '/', []).href, 'http://127.0.0.1:8081/');
  assert.equal(serviceUrl(bare, '/', [['q', 'x']]).href, 'http://127.0.0.1:8081/?q=x');
  assert.equal(
    serviceUrl(s, '/items/search', [
      ['q', '中文 a&b'],
      ['n', '5'],
    ]).href,
    'http://127.0.0.1:8081/api/v1/items/search?q=%E4%B8%AD%E6%96%87+a%26b&n=5',
  );
  assert.equal(serviceUrl(s, '/a/feed%2D1/b', undefined).pathname, '/api/v1/a/feed%2D1/b');
  assert.equal(serviceUrl(s, '/a.b/c..d', []).pathname, '/api/v1/a.b/c..d');
  assert.equal(serviceUrl(bare, '/x', []).href, 'http://127.0.0.1:8081/x');
  const bad = [
    '',
    'items',
    '//evil.example/x',
    '/\\x',
    '/a\\b',
    'http://evil.example/x',
    '/http://evil.example/x',
    '/a/b://c',
    '/..',
    '/a/..',
    '/a/../b',
    '/./a',
    '/a/.',
    '/a/%2e%2e/b',
    '/a/%2E/b',
    '/a/.%2e/b',
    '/a/%252e%252e/b',
    '/a/%2e%2e',
    '/a/..%2fb',
    '/a/%5cb',
    '/a/b%2F..%2Fc',
    '/a%00b',
    '/a\nb',
    '/a?x=1',
    '/a#b',
    '/%zz',
    null,
    3,
  ];
  for (const p of bad)
    assert.throws(
      () => serviceUrl(s, p as string, []),
      (e: Error & { code?: string }) => e.code === 'invalid_params',
      String(p),
    );
  for (const q of ['x', [['k']], [['k', 3]], [['k', 'v', 'w']], Array(101).fill(['k', 'v'])])
    assert.throws(() => serviceUrl(s, '/a', q), { code: 'invalid_params' });
});

test('callService sends the token of the service and its own headers, and answers the status, the content type and a text body as text', async (t) => {
  const f = await fixture(t, (_req, res) => ok(res, 'application/json; charset=utf-8', '{"ok":"你好"}'));
  const r = await f.call({
    service: 'notes',
    method: 'get',
    path: '/items',
    query: [['a', '1']],
    headers: { 'x-lang': 'zh' },
  });
  assert.deepEqual(r, {
    status: 200,
    contentType: 'application/json; charset=utf-8',
    encoding: 'text',
    body: '{"ok":"你好"}',
  });
  const s = f.seen[0];
  assert.deepEqual([s.method, s.url], ['GET', '/api/v1/items?a=1']);
  assert.equal(s.headers.authorization, 'Bearer ' + secret);
  assert.equal(s.headers['x-lang'], 'zh');
});

test('callService sends a POST body as JSON, {} when there is none, no body for other methods, and does not follow a redirect', async (t) => {
  const f = await fixture(
    t,
    (req, res) => {
      if (req.url === '/api/v1/redirect') {
        res.writeHead(302, { location: 'http://127.0.0.1:1/x', 'content-type': 'text/plain' });
        return res.end('moved');
      }
      ok(res);
    },
    { methods: ['GET', 'POST', 'PUT', 'DELETE'] },
  );
  await f.call({ service: 'notes', method: 'POST', path: '/s', body: '{"q":"x"}' });
  await f.call({ service: 'notes', method: 'POST', path: '/s' });
  await f.call({ service: 'notes', method: 'GET', path: '/s' });
  await f.call({ service: 'notes', method: 'DELETE', path: '/s' });
  assert.deepEqual(
    f.seen.map((s) => [s.method, s.body, s.headers['content-type']]),
    [
      ['POST', '{"q":"x"}', 'application/json'],
      ['POST', '{}', 'application/json'],
      ['GET', '', undefined],
      ['DELETE', '', undefined],
    ],
  );
  const r = await f.call({ service: 'notes', method: 'GET', path: '/redirect' });
  assert.equal(r.status, 302);
  assert.equal(r.body, 'moved');
});

test('callService refuses a method or a header that the service does not allow, and an unknown service, before any request', async (t) => {
  const f = await fixture(t, (_req, res) => ok(res));
  await assert.rejects(
    Promise.resolve(f.call({ service: 'notes', method: 'DELETE', path: '/a' })),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, 'method_not_allowed');
      assert.equal(e.message, '服务「notes」不允许 DELETE 请求，允许：GET、HEAD、POST');
      return true;
    },
  );
  await assert.rejects(
    Promise.resolve(f.call({ service: 'notes', method: 'GET', path: '/a', headers: { 'x-other': '1' } })),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, 'header_not_allowed');
      assert.equal(e.message, '服务「notes」不允许传请求头 x-other，允许：x-lang');
      return true;
    },
  );
  await assert.rejects(
    Promise.resolve(f.call({ service: 'notes', method: 'GET', path: '/a', headers: { authorization: 'Bearer x' } })),
    { code: 'header_not_allowed' },
  );
  await rejects(f.call({ service: 'other', method: 'GET', path: '/a' }), 'service_unknown');
  assert.equal(f.seen.length, 0);
});

test('callService answers an error status as an answer, and a binary body, or a text that is not UTF-8, as base64', async (t) => {
  const bytes = Buffer.from([0, 255, 1, 2, 200]);
  const f = await fixture(t, (req, res) => {
    if (req.url === '/api/v1/forbidden') {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end('{"error":"no"}');
    }
    if (req.url === '/api/v1/bad-text') return ok(res, 'text/plain', Buffer.from([0xff, 0xfe]));
    ok(res, 'image/png', bytes);
  });
  assert.deepEqual(await f.call({ service: 'notes', method: 'POST', path: '/forbidden' }), {
    status: 403,
    contentType: 'application/json',
    encoding: 'text',
    body: '{"error":"no"}',
  });
  assert.deepEqual(await f.call({ service: 'notes', method: 'GET', path: '/file' }), {
    status: 200,
    contentType: 'image/png',
    encoding: 'base64',
    body: bytes.toString('base64'),
  });
  assert.equal((await f.call({ service: 'notes', method: 'GET', path: '/bad-text' })).encoding, 'base64');
});

test('callService refuses an answer over 20 MB, by its declared length or by what arrives', async (t) => {
  assert.equal(readCap, 20 * 1024 * 1024);
  const f = await fixture(t, (req, res) => {
    if (req.url === '/api/v1/declared') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(readCap + 1) });
      return res.end(Buffer.alloc(readCap + 1));
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    for (let i = 0; i < 21; i++) res.write(Buffer.alloc(1024 * 1024, 97));
    res.end();
  });
  for (const path of ['/declared', '/streamed'])
    await assert.rejects(
      Promise.resolve(f.call({ service: 'notes', method: 'GET', path })),
      (e: Error & { code?: string }) => {
        assert.equal(e.code, 'response_too_large');
        assert.match(e.message, /20 MB/);
        return true;
      },
    );
});

test('callService rejects params that are not as a request before any request, and reports an unreachable service or a timeout without the token', async (t) => {
  const f = await fixture(t, () => {});
  const call = f.call as unknown as (p: object) => Promise<unknown>;
  for (const p of [
    {},
    { service: 'notes' },
    { service: 'notes', method: 3, path: '/a' },
    { service: 'notes', method: 'TRACE', path: '/a' },
    { service: 'notes', method: 'GET', path: '/../x' },
    { service: 'notes', method: 'GET', path: '//x' },
    { service: 'notes', method: 'GET', path: '/a', body: 3 },
    { service: 'notes', method: 'GET', path: '/a', headers: [] },
    { service: 'notes', method: 'GET', path: '/a', headers: { 'x-lang': 3 } },
    { service: 'notes', method: 'GET', path: '/a', headers: { 'x-lang': 'a\nb' } },
    { service: 'notes', method: 'GET', path: '/a', timeoutMs: 0 },
  ])
    await rejects(call(p), 'invalid_params');
  assert.equal(f.seen.length, 0);
  await rejects(f.call({ service: 'notes', method: 'GET', path: '/slow', timeoutMs: 30 }), 'service_unreachable');
  const dead = serviceMethods({ notes: { ...f.service, url: 'http://127.0.0.1:1/api/v1' } });
  await rejects(dead.callService({ service: 'notes', method: 'GET', path: '/a' }), 'service_unreachable');
});
