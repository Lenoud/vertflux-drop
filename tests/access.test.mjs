import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway, safeHeaders } from '../edge/index.mjs';
import { invitation, readTicket, ticket, verify } from '../backend/crypto.mjs';
const origin = 'https://drop.vertflux.com';
const id = '11111111-1111-4111-8111-111111111111';
const secret = 'test-drop-secret-only-not-a-production-credential';
const post = (path, body = {}) => new Request(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const env = { ASSETS: { fetch: () => new Response('asset') }, DROP_API: { fetch: () => new Response('backend') } };

test('匿名者可以打开邀请页面，创建者入口及接口需要 SSO', async () => {
  const app = createGateway();
  assert.equal((await app.fetch(new Request(`${origin}/join/${id}`), env)).status, 200);
  assert.equal((await app.fetch(new Request(`${origin}/dashboard`), env)).status, 302);
  assert.equal((await app.fetch(post('/api/rooms'), env)).status, 401);
});
test('身份头不能绕过认证，真实身份来自认证服务', async () => {
  const request = post('/api/rooms'); request.headers.set('X-Vertflux-Subject', 'forged');
  assert.equal((await createGateway().fetch(request, env)).status, 401);
  request.headers.set('Cookie', '__Host-vertflux_sso=example; other=private');
  const app = createGateway(async (_, options) => { assert.equal(options.headers.Cookie, '__Host-vertflux_sso=example'); return Response.json({ subject: 'real', username: 'liubiao' }); });
  const response = await app.fetch(request, { ...env, DROP_API: { fetch: req => Response.json({ subject: req.headers.get('X-Vertflux-Subject'), cookie: req.headers.get('Cookie') }) } });
  assert.deepEqual(await response.json(), { subject: 'real', cookie: null });
  assert.equal(safeHeaders(request).get('X-Vertflux-Subject'), null);
});
test('同源、请求大小、默认域名及 WebSocket 来源检查', async () => {
  const app = createGateway();
  const foreign = post(`/api/guest/${id}/connect`); foreign.headers.set('Origin', 'https://evil.example');
  assert.equal((await app.fetch(foreign, env)).status, 403);
  assert.equal((await app.fetch(post(`/api/guest/${id}/connect`, { text: 'x'.repeat(5000) }), env)).status, 413);
  assert.equal((await app.fetch(new Request('https://vertflux-drop.pages.dev/api/rooms', { method: 'POST' }), env)).status, 403);
  assert.equal((await app.fetch(new Request(`${origin}/server`, { headers: { Upgrade: 'websocket', Origin: 'https://evil.example' } }), env)).status, 403);
});
test('认证故障关闭访问，登录返回地址不得跳到第三方', async () => {
  const app = createGateway(async () => { throw new Error('offline'); });
  const request = new Request(origin + '/api/rooms', { headers: { Cookie: '__Host-vertflux_sso=example' } });
  assert.equal((await app.fetch(request, env)).status, 503);
  assert.equal((await app.fetch(new Request(origin + '/oauth2/start?rd=https://evil.example'), env)).status, 400);
});
test('邀请按房间隔离，WebSocket 凭据有签名和有效期', async () => {
  const invite = await invitation(secret, id);
  assert.equal(await verify(secret, `invite:${id}`, invite), true);
  assert.equal(await verify(secret, `invite:${crypto.randomUUID()}`, invite), false);
  const claims = { roomId: id, peerId: crypto.randomUUID(), role: 'guest', exp: Date.now() + 10000 };
  const value = await ticket(secret, claims);
  assert.deepEqual(await readTicket(secret, value), claims);
  assert.equal(await readTicket('other', value), null);
  assert.equal(await readTicket(secret, value + '.extra'), null);
  assert.equal(await readTicket(secret, value, claims.exp + 1), null);
});
