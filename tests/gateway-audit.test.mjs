import assert from 'node:assert/strict'
import test from 'node:test'
import { auditGateway, callbackError, invalidPath, blockedProbe } from '../edge/audit.mjs'

test('登录回调缺少参数或 CSRF Cookie 时在换码前拒绝', () => {
  const origin = 'https://example.test/oauth2/callback'
  assert.equal(callbackError(new Request(origin)), 400)
  assert.equal(callbackError(new Request(origin + '?code=fixture&state=fixture')), 403)
  assert.equal(callbackError(new Request(origin + '?code=fixture&state=fixture', { headers: { Cookie: '__Host-vertflux_sso=existing' } })), 403)
  assert.equal(callbackError(new Request(origin + '?code=fixture&state=fixture', { headers: { Cookie: '__Host-vertflux_sso_csrf_abc123=fixture' } })), 0)
})

test('异常分隔符和常见配置扫描路径可明确拒绝', () => {
  for (const path of ['/\\api/link/list', '/%5capi', '/%255capi', '/api/\u0000rooms']) assert.equal(invalidPath(path), true)
  for (const path of ['/.env', '/.env.production', '/.git/config', '/credentials.json', '/firebase-key.json']) assert.equal(blockedProbe(path), true)
  for (const path of ['/.well-known/acme-challenge/fixture', '/assets/app.js', '/api/rooms']) assert.equal(blockedProbe(path), false)
})

test('认证日志不包含路径 Token、查询参数、Cookie、正文及异常对象', async (t) => {
  const logs = []
  const original = { info: console.info, error: console.error }
  t.after(() => Object.assign(console, original))
  console.info = value => logs.push(value)
  console.error = value => logs.push(value)
  const request = new Request('https://example.test/private-path-credential?key=query-credential', {
    method: 'POST', headers: { Cookie: 'session=cookie-credential', Authorization: 'Bearer bearer-credential' }, body: 'body-credential',
  })
  const handler = auditGateway('test-app', async () => { throw new Error('exception-credential') })
  const response = await handler(request, {})
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
  assert.ok(response.headers.get('X-Request-ID'))
  assert.equal(logs.length, 1)
  for (const value of ['private-path-credential', 'query-credential', 'cookie-credential', 'bearer-credential', 'body-credential', 'exception-credential']) assert.ok(!logs[0].includes(value))
  const entry = JSON.parse(logs[0])
  assert.equal(entry.path_template, '/*')
  assert.equal(entry.reason, 'unhandled_gateway_error')
  assert.equal(entry.request_id, response.headers.get('X-Request-ID'))
  assert.equal(typeof entry.duration_ms, 'number')
})
