import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, Log, LogLevel } from 'miniflare';
const mf = new Miniflare({ modules: true, scriptPath: 'backend/index.mjs', compatibilityDate: '2026-07-30', log: new Log(LogLevel.ERROR),
  durableObjects: { ROOMS: { className: 'DropRoom', useSQLite: true }, DIRECTORY: { className: 'DropDirectory', useSQLite: true } },
  bindings: { DROP_SECRET: 'local-test-secret-never-used-in-production' } });
const sockets = [];
after(async () => { for (const ws of sockets) try { ws.close(); } catch {} await mf.dispose(); });
async function call(path, body, subject = 'owner') {
  return mf.dispatchFetch('https://backend.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(subject ? { 'X-Vertflux-Subject': subject, 'X-Vertflux-Username': subject } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function create(owner = crypto.randomUUID()) {
  const response = await call('/api/rooms', { title: '跨网测试', minutes: 30 }, owner);
  assert.equal(response.status, 201);
  const room = await response.json(); room.owner = owner; room.invitation = room.invite.split('#')[1]; return room;
}
async function connect(room, role = 'guest', peerId = crypto.randomUUID()) {
  const response = await call(`/api/${role}/${room.id}/connect`, { peerId, invitation: room.invitation }, role === 'host' ? room.owner : null);
  assert.equal(response.status, 200); return response.json();
}
async function socket(data) {
  const response = await mf.dispatchFetch('https://backend.test/server', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `vertflux-drop, ticket.${data.ticket}` } });
  assert.equal(response.status, 101);
  const ws = response.webSocket, messages = [], waiters = [];
  ws.addEventListener('message', event => { const message = JSON.parse(event.data); const resolve = waiters.shift(); if (resolve) resolve(message); else messages.push(message); });
  ws.accept(); sockets.push(ws);
  return { ws, async next() { if (messages.length) return messages.shift(); return Promise.race([new Promise(resolve => waiters.push(resolve)), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('信令等待超时')), 4000); timer.unref(); })]); } };
}

test('房间、所有者与邀请权限隔离', async () => {
  const room = await create();
  assert.equal((await call(`/api/host/${room.id}/connect`, { peerId: crypto.randomUUID() }, 'intruder')).status, 403);
  assert.equal((await call(`/api/guest/${room.id}/connect`, { peerId: crypto.randomUUID(), invitation: 'invalid' }, null)).status, 403);
  const other = await create();
  assert.equal((await call(`/api/guest/${other.id}/connect`, { peerId: crypto.randomUUID(), invitation: room.invitation }, null)).status, 403);
  assert.equal((await call('/api/rooms', { title: 'invalid', minutes: 9999 }, room.owner)).status, 400);
  assert.equal((await call('/api/rooms', null, room.owner)).status, 400);
});
test('同一主持人并发创建房间也不能超过三个', async () => {
  const owner = crypto.randomUUID();
  const results = await Promise.all(Array.from({ length: 8 }, () => call('/api/rooms', { title: '并发额度检查', minutes: 30 }, owner)));
  assert.equal(results.filter(r => r.status === 201).length, 3);
  assert.equal(results.filter(r => r.status === 429).length, 5);
});
test('真实 Worker 运行时中完成 PairDrop 信令，服务端不转发文件分块', async () => {
  const room = await create();
  const a = await socket(await connect(room, 'host')), b = await socket(await connect(room));
  assert.equal((await a.next()).type, 'ws-config'); const aName = await a.next();
  assert.equal((await b.next()).type, 'ws-config'); const bName = await b.next();
  a.ws.send(JSON.stringify({ type: 'join-ip-room' })); assert.equal((await a.next()).type, 'peers');
  b.ws.send(JSON.stringify({ type: 'join-ip-room' }));
  assert.equal((await a.next()).type, 'peer-joined'); assert.equal((await b.next()).peers[0].id, aName.peerId);
  b.ws.send(JSON.stringify({ type: 'signal', to: aName.peerId, roomType: 'public-id', roomId: room.id, sdp: { type: 'offer', sdp: 'test-offer' }, sender: { id: 'forged' } }));
  const forwarded = await a.next(); assert.equal(forwarded.sender.id, bName.peerId); assert.equal(forwarded.sdp.sdp, 'test-offer');
  // 文件不允许通过信令中转；随后发送 ICE，下一条消息必须是 ICE。
  b.ws.send(JSON.stringify({ type: 'ws-chunk', to: aName.peerId, chunk: 'private-file' }));
  b.ws.send(JSON.stringify({ type: 'signal', to: aName.peerId, roomType: 'public-id', roomId: room.id, ice: { candidate: 'candidate:test', sdpMid: '0', sdpMLineIndex: 0 } }));
  assert.equal((await a.next()).ice.candidate, 'candidate:test');
  a.ws.close(); b.ws.close();
});
test('并发来宾最多接纳一位，结束房间后邀请失效', async () => {
  const room = await create();
  const first = await connect(room), second = await connect(room);
  const results = await Promise.all([first, second].map(data => mf.dispatchFetch('https://backend.test/server', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `vertflux-drop, ticket.${data.ticket}` } })));
  assert.deepEqual(results.map(r => r.status).sort(), [101, 409]);
  for (const r of results) if (r.webSocket) { r.webSocket.accept(); sockets.push(r.webSocket); }
  assert.equal((await call(`/api/host/${room.id}/close`, {}, room.owner)).status, 200);
  assert.equal((await call(`/api/guest/${room.id}/connect`, { peerId: crypto.randomUUID(), invitation: room.invitation }, null)).status, 410);
});
test('同一设备重连可替换旧 WebSocket', { timeout: 6000 }, async () => {
  const room = await create(), peerId = crypto.randomUUID();
  const data = await connect(room, 'guest', peerId);
  const first = await socket(data);
  await first.next(); await first.next();
  const next = await socket(await connect(room, 'guest', peerId));
  assert.equal((await next.next()).type, 'ws-config');
  assert.equal((await next.next()).peerId, peerId);
  // 新连接已取得相同身份，另一位来宾仍不能抢占当前房间。
  assert.equal((await call(`/api/guest/${room.id}/connect`, { peerId: crypto.randomUUID(), invitation: room.invitation }, null)).status, 409);
  next.ws.close();
});
