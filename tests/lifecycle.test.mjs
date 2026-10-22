import test from 'node:test';
import assert from 'node:assert/strict';
import { DropRoom } from '../backend/index.mjs';

function fixture() {
  const values = new Map(); let scheduled;
  const storage = { get: async k => values.get(k), put: async (k, v) => values.set(k, v), delete: async k => values.delete(k),
    deleteAll: async () => values.clear(), setAlarm: async time => { scheduled = time; } };
  const state = { storage, getWebSockets: () => [], blockConcurrencyWhile: fn => fn() };
  const room = { id: crypto.randomUUID(), subject: 'owner', title: '生命周期', expiresAt: Date.now() + 1800000 };
  values.set('room', room);
  return { values, room, scheduled: () => scheduled, instance: new DropRoom(state, { DROP_SECRET: 'test-only', TURN_KEY_ID: 'test-key', TURN_KEY_TOKEN: 'test-token' }) };
}
const connect = peerId => new Request('https://room.internal/connect', { method: 'POST', body: JSON.stringify({ role: 'guest', peerId }) });
test('临时中继凭据按设备复用，上游失败不留下半成品成员', async t => {
  const f = fixture(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    calls++; const ttl = JSON.parse(options.body).ttl;
    assert.ok(ttl >= 1800 && ttl <= 1860);
    return Response.json({ iceServers: [{ urls: 'turn:test.invalid', username: 'test-user', credential: 'test-credential' }] });
  });
  const id = crypto.randomUUID();
  assert.equal((await f.instance.fetch(connect(id))).status, 200);
  assert.equal((await f.instance.fetch(connect(id))).status, 200);
  assert.equal(calls, 1);
  globalThis.fetch.mock.mockImplementation(async () => new Response(null, { status: 503 }));
  assert.equal((await f.instance.fetch(connect(crypto.randomUUID()))).status, 503);
  assert.equal(Object.keys(f.values.get('members')).length, 1);
});
test('到期房间拒绝进入；中继撤销失败后由 alarm 重试并清理', async t => {
  const f = fixture();
  f.room.expiresAt = Date.now() - 1;
  f.values.set('members', { guest: { iceServers: [{ urls: 'turn:test.invalid', username: 'expired-test-user' }] } });
  assert.equal((await f.instance.fetch(connect(crypto.randomUUID()))).status, 410);
  t.mock.method(globalThis, 'fetch', async url => { assert.ok(url.endsWith('/expired-test-user/revoke')); return new Response(null, { status: 503 }); });
  await f.instance.alarm();
  assert.equal(f.values.get('room').closed, true);
  assert.ok(f.values.has('members'));
  assert.ok(f.scheduled() > Date.now());
  globalThis.fetch.mock.mockImplementation(async () => new Response(null, { status: 204 }));
  await f.instance.alarm();
  assert.equal(f.values.has('members'), false);
  await f.instance.alarm();
  assert.equal(f.values.size, 0);
});
