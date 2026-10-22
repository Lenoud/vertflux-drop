import { invitation, readTicket, ticket, UUID, verify } from './crypto.mjs';

const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (status, error) => json({ error }, status);
const active = room => room && !room.closed && room.expiresAt > Date.now();
const visible = room => ({ id: room.id, title: room.title, createdAt: room.createdAt, expiresAt: room.expiresAt, closed: !!room.closed });
const roomStub = (env, id) => env.ROOMS.get(env.ROOMS.idFromName(id));
const internal = (path, body) => new Request(`https://drop.internal${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname;
    if (path === '/api/health') return json({ ok: true, app: 'vertflux-drop' });
    const subject = request.headers.get('X-Vertflux-Subject');
    const username = request.headers.get('X-Vertflux-Username');
    if (path === '/api/rooms') {
      if (!subject) return fail(401, '请先登录。');
      const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName(subject));
      if (request.method === 'GET') return directory.fetch('https://directory.internal/list');
      if (request.method !== 'POST') return fail(405, '请求方法无效。');
      let body;
      try { body = await request.json(); } catch { return fail(400, '请求格式无效。'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, '请求格式无效。');
      if (typeof body.title !== 'string' || body.title.trim().length < 1 || body.title.length > 60 || ![30, 60].includes(body.minutes)) return fail(400, '请输入 1—60 字的房间名称，并选择 30 或 60 分钟。');
      return directory.fetch(internal('/create', { subject, username, title: body.title.trim(), minutes: body.minutes }));
    }
    const socket = path === '/server';
    const match = path.match(/^\/api\/(host|guest)\/([a-f0-9-]{36})\/(connect|close)$/);
    if (socket) {
      const protocols = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(s => s.trim());
      const value = protocols.find(s => s.startsWith('ticket.'))?.slice(7);
      const claims = await readTicket(env.DROP_SECRET, value);
      if (!claims) return fail(401, '连接凭据已失效，请重新打开房间。');
      return roomStub(env, claims.roomId).fetch(new Request('https://room.internal/socket', { headers: { Upgrade: 'websocket', 'X-Drop-Ticket': value } }));
    }
    if (!match || !UUID.test(match[2])) return fail(404, '接口不存在。');
    if (request.method !== 'POST') return fail(405, '请求方法无效。');
    const [, role, id, action] = match;
    if (role === 'host' && !subject) return fail(401, '请先登录。');
    let body;
    try { body = await request.json(); } catch { return fail(400, '请求格式无效。'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, '请求格式无效。');
    if (role === 'guest' && (action !== 'connect' || !await verify(env.DROP_SECRET, `invite:${id}`, body.invitation))) return fail(403, '邀请链接无效。');
    const response = await roomStub(env, id).fetch(internal(`/${action}`, { ...body, role, subject }));
    if (role === 'host' && action === 'close' && response.ok) {
      await env.DIRECTORY.get(env.DIRECTORY.idFromName(subject)).fetch(internal('/closed', { id }));
    }
    return response;
  },
};

export class DropDirectory {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    if (new URL(request.url).pathname === '/list') {
      const rooms = (await this.state.storage.get('rooms') || []).map(r => ({ ...r, closed: r.closed || r.expiresAt <= Date.now() }));
      return json({ rooms });
    }
    const body = await request.json();
    if (new URL(request.url).pathname === '/closed') {
      await this.state.storage.transaction(async tx => {
        const rooms = await tx.get('rooms') || [];
        for (const room of rooms) if (room.id === body.id) room.closed = true;
        await tx.put('rooms', rooms);
      });
      return json({ ok: true });
    }
    const createdAt = Date.now();
    const room = { id: crypto.randomUUID(), title: body.title, subject: body.subject, username: body.username, createdAt, expiresAt: createdAt + body.minutes * 60000 };
    const reserved = await this.state.storage.transaction(async tx => {
      const rooms = await tx.get('rooms') || [];
      // 同时最多三间，每日最多二十间，限制凭据签发和存储增长。
      const day = new Date(createdAt).toISOString().slice(0, 10);
      const usage = await tx.get('usage') || { day, count: 0 };
      if (usage.day !== day) { usage.day = day; usage.count = 0; }
      if (usage.count >= 20 || rooms.filter(active).length >= 3) return false;
      usage.count++;
      await tx.put({ usage, rooms: [visible(room), ...rooms].slice(0, 30) });
      return true;
    });
    if (!reserved) return fail(429, '最多同时保留三间未到期房间，每日最多创建二十间。');
    const response = await roomStub(this.env, room.id).fetch(internal('/create', room));
    if (!response.ok) return fail(503, '房间创建失败，请稍后重试。');
    return json({ ...visible(room), invite: `/join/${room.id}#${await invitation(this.env.DROP_SECRET, room.id)}` }, 201);
  }
}

export class DropRoom {
  constructor(state, env) {
    this.state = state; this.env = env;
    // 自动心跳不唤醒对象，空闲房间可以休眠。
    if (state.setWebSocketAutoResponse && globalThis.WebSocketRequestResponsePair) state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/create') {
      await this.state.storage.put('room', await request.json());
      const room = await this.state.storage.get('room');
      await this.state.storage.setAlarm(room.expiresAt);
      return json({ ok: true });
    }
    const room = await this.state.storage.get('room');
    if (!active(room)) return fail(410, '房间已结束或过期，请让发送者重新创建。');
    if (path === '/socket') return this.socket(request, room);
    const body = await request.json();
    if (body.role === 'host' && body.subject !== room.subject) return fail(403, '你没有这个房间的管理权限。');
    if (path === '/close') {
      if (body.role !== 'host') return fail(403, '只有创建者可以结束房间。');
      await this.close(room);
      return json({ ok: true });
    }
    if (path !== '/connect' || !UUID.test(body.peerId)) return fail(400, '连接信息无效。');
    return this.state.blockConcurrencyWhile(async () => {
      const members = await this.state.storage.get('members') || {};
      const memberKey = `${body.role}:${body.peerId}`;
      const others = this.state.getWebSockets().filter(ws => ws.readyState === 1 && ws.deserializeAttachment()?.role === body.role && ws.deserializeAttachment()?.peerId !== body.peerId);
      if (others.length) return fail(409, body.role === 'guest' ? '房间已有一位接收者，请等待对方离开。' : '创建者已在另一个页面打开房间。');
      let member = members[memberKey];
      if (!member) {
        if (Object.keys(members).length >= 12) return fail(429, '本房间的连接次数已达到上限，请重新创建。');
        let iceServers = [{ urls: 'stun:stun.cloudflare.com:3478' }];
        if (this.env.TURN_KEY_ID && this.env.TURN_KEY_TOKEN) {
          try {
            const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${this.env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
              method: 'POST', headers: { Authorization: `Bearer ${this.env.TURN_KEY_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'Vertflux-Drop/0.1.0' },
              body: JSON.stringify({ ttl: Math.max(60, Math.ceil((room.expiresAt - Date.now()) / 1000) + 60) }), signal: AbortSignal.timeout(10000),
            });
            if (!response.ok) return fail(503, '跨网中继暂时不可用，请稍后重试。');
            const result = await response.json();
            if (!Array.isArray(result.iceServers) || !result.iceServers.length) return fail(503, '跨网中继配置无效。');
            iceServers = result.iceServers;
          } catch { return fail(503, '跨网中继暂时不可用，请稍后重试。'); }
        }
        member = { iceServers, createdAt: Date.now() };
        members[memberKey] = member;
        await this.state.storage.put('members', members);
      }
      const claims = { roomId: room.id, peerId: body.peerId, role: body.role, exp: Math.min(room.expiresAt, Date.now() + 60000) };
      return json({ ...visible(room), role: body.role, ticket: await ticket(this.env.DROP_SECRET, claims), rtcConfig: { iceServers: member.iceServers }, relay: !!this.env.TURN_KEY_ID,
        ...(body.role === 'host' ? { invite: `/join/${room.id}#${await invitation(this.env.DROP_SECRET, room.id)}` } : {}) });
    });
  }
  async socket(request, room) {
    const claims = await readTicket(this.env.DROP_SECRET, request.headers.get('X-Drop-Ticket'));
    if (!claims || claims.roomId !== room.id) return fail(401, '连接凭据无效。');
    const members = await this.state.storage.get('members') || {};
    if (!members[`${claims.role}:${claims.peerId}`]) return fail(401, '连接凭据无效。');
    // 验证与接纳连接之间不等待网络操作，避免两个来宾并发占座。
    for (const ws of this.state.getWebSockets().filter(ws => ws.readyState === 1)) {
      const old = ws.deserializeAttachment();
      if (old.role !== claims.role) continue;
      if (old.peerId !== claims.peerId) return fail(409, '这个角色已在另一个页面连接。');
      ws.close(4001, '页面已重新连接');
    }
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    this.state.acceptWebSocket(server);
    const name = claims.role === 'host' ? '发送者' : '接收者';
    const info = { peerId: claims.peerId, role: claims.role, joined: false, window: Date.now(), count: 0,
      peer: { id: claims.peerId, rtcSupported: true, name: { displayName: name, deviceName: '浏览器', type: 'desktop', os: '', browser: '' } } };
    server.serializeAttachment(info);
    const config = members[`${claims.role}:${claims.peerId}`].iceServers;
    server.send(JSON.stringify({ type: 'ws-config', wsConfig: { wsFallback: false, rtcConfig: { iceServers: config } } }));
    server.send(JSON.stringify({ type: 'display-name', displayName: name, deviceName: '浏览器', peerId: claims.peerId, peerIdHash: '' }));
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'vertflux-drop' } });
  }
  async webSocketMessage(ws, raw) {
    const room = await this.state.storage.get('room');
    if (!active(room)) { ws.close(4000, '房间已结束或过期'); return; }
    if (typeof raw !== 'string' || raw.length > 32768) { ws.close(1009, '信令内容过长'); return; }
    let message;
    try { message = JSON.parse(raw); } catch { ws.close(1008, '信令格式无效'); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { ws.close(1008, '信令格式无效'); return; }
    const sender = ws.deserializeAttachment();
    if (Date.now() - sender.window > 60000) { sender.window = Date.now(); sender.count = 0; }
    if (++sender.count > 240) { ws.close(1008, '请求过于频繁'); return; }
    ws.serializeAttachment(sender);
    if (message.type === 'disconnect') { ws.close(1000); return; }
    if (message.type === 'pong') return;
    if (message.type === 'join-ip-room') {
      if (sender.joined) return;
      const peers = [];
      for (const other of this.state.getWebSockets().filter(ws => ws.readyState === 1)) {
        if (other === ws) continue;
        const data = other.deserializeAttachment();
        if (!data.joined || data.role === sender.role) continue;
        peers.push(data.peer);
        other.send(JSON.stringify({ type: 'peer-joined', peer: sender.peer, roomType: 'public-id', roomId: room.id }));
      }
      sender.joined = true;
      ws.serializeAttachment(sender);
      ws.send(JSON.stringify({ type: 'peers', peers, roomType: 'public-id', roomId: room.id }));
      return;
    }
    // 后端只转发 SDP / ICE；文件、文字与分块必须走 WebRTC DataChannel。
    if (message.type !== 'signal' || !sender.joined || message.roomId !== room.id || message.roomType !== 'public-id') return;
    if (!message.sdp && !message.ice) return;
    for (const other of this.state.getWebSockets().filter(ws => ws.readyState === 1)) {
      const recipient = other.deserializeAttachment();
      if (recipient.role === sender.role || !recipient.joined || recipient.peerId !== message.to) continue;
      const safe = { type: 'signal', roomType: 'public-id', roomId: room.id, sender: { id: sender.peerId, rtcSupported: true } };
      if (message.sdp && ['offer', 'answer'].includes(message.sdp.type) && typeof message.sdp.sdp === 'string') safe.sdp = { type: message.sdp.type, sdp: message.sdp.sdp };
      if (message.ice && typeof message.ice.candidate === 'string') safe.ice = { candidate: message.ice.candidate, sdpMid: message.ice.sdpMid, sdpMLineIndex: message.ice.sdpMLineIndex, usernameFragment: message.ice.usernameFragment };
      if (safe.sdp || safe.ice) other.send(JSON.stringify(safe));
    }
  }
  async webSocketClose(ws) { this.left(ws); }
  async webSocketError(ws) { this.left(ws); }
  left(ws) {
    const sender = ws.deserializeAttachment();
    if (!sender?.joined) return;
    if (this.state.getWebSockets().some(other => other !== ws && other.readyState === 1 && other.deserializeAttachment()?.peerId === sender.peerId)) return;
    for (const other of this.state.getWebSockets()) {
      if (other === ws) continue;
      try { other.send(JSON.stringify({ type: 'peer-left', peerId: sender.peerId, roomType: 'public-id', disconnect: true })); } catch {}
    }
  }
  async close(room) {
    room.closed = true;
    await this.state.storage.put('room', room);
    for (const ws of this.state.getWebSockets()) { try { ws.close(4000, '房间已结束或过期'); } catch {} }
    const members = await this.state.storage.get('members') || {};
    let pending = false;
    if (this.env.TURN_KEY_ID && this.env.TURN_KEY_TOKEN) {
      for (const member of Object.values(members)) {
        for (const server of member.iceServers) {
          if (!server.username || member.revoked) continue;
          try {
            const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${this.env.TURN_KEY_ID}/credentials/${encodeURIComponent(server.username)}/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${this.env.TURN_KEY_TOKEN}`, 'User-Agent': 'Vertflux-Drop/0.1.0' }, signal: AbortSignal.timeout(10000) });
            if ([204, 404].includes(response.status)) member.revoked = true; else pending = true;
          } catch { pending = true; }
        }
      }
    }
    if (pending && Date.now() < room.expiresAt + 120000) {
      await this.state.storage.put('members', members);
      await this.state.storage.setAlarm(Date.now() + 30000);
    } else {
      await this.state.storage.delete('members');
      await this.state.storage.setAlarm(Date.now() + 86400000);
    }
  }
  async alarm() {
    const room = await this.state.storage.get('room');
    if (!room) return;
    if (room.closed && !await this.state.storage.get('members')) { await this.state.storage.deleteAll(); return; }
    await this.close(room);
  }
}
