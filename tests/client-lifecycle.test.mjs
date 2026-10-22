import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const upstream = await readFile(new URL('../public/scripts/network.js', import.meta.url), 'utf8');
const adapter = await readFile(new URL('../cloudflare/server-connection.js', import.meta.url), 'utf8');
const lifecycle = await readFile(new URL('../cloudflare/peer-lifecycle.js', import.meta.url), 'utf8');

function fixture(fetch = async () => new Promise(() => {})) {
  const window = new EventTarget(), timers = new Set(), sockets = [];
  window.dropRoom = { role: 'guest', id: crypto.randomUUID(), peerId: crypto.randomUUID() };
  const Events = {
    on: (name, fn) => window.addEventListener(name, fn),
    off: (name, fn) => window.removeEventListener(name, fn),
    fire: (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail })),
  };
  const schedule = (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer; };
  class WebSocket {
    static OPEN = 1; static CONNECTING = 0;
    constructor() { this.readyState = 0; sockets.push(this); }
    send() {}
    close() { this.readyState = 3; }
  }
  const context = vm.createContext({ window, Events, fetch, AbortController, AbortSignal, WebSocket,
    setTimeout: schedule, setInterval: schedule, clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
    location: { host: 'drop.test' }, console: { log() {}, error() {} },
    Localization: { getTranslation: () => '传输尚未完成' },
  });
  vm.runInContext(adapter + '\n' + upstream.slice(upstream.indexOf('class Peer {')) + '\n' + lifecycle + `
    let pairDrop = { peers: new PeersManager({}) };
    pairDrop.peers._onPeerConnected = () => {};
    this.fixture = { RTCPeer, ServerConnection, manager: pairDrop.peers };
  `, context);
  const api = context.fixture;
  function addPeer() {
    const calls = { channelClose: 0, connectionClose: 0, abort: 0, read: 0, send: 0 };
    const channel = { readyState: 'open', send: () => calls.send++, close: () => calls.channelClose++ };
    const reader = { readyState: 1, abort: () => { reader.readyState = 2; calls.abort++; } };
    const chunker = { _reader: reader, _file: { size: 100 }, _onChunkRead: () => calls.read++, _readChunk: () => calls.read++ };
    const digester = { _buffer: [new Uint8Array(100)], _callback() {} };
    const peer = Object.assign(Object.create(api.RTCPeer.prototype), {
      _peerId: crypto.randomUUID(), _busy: true, _isCaller: true,
      _conn: { close: () => calls.connectionClose++ }, _channel: channel,
      _chunker: chunker, _digester: digester, _filesQueue: [{}], _filesReceived: [{}], _filesRequested: [{}],
      _requestPending: {}, _requestAccepted: {}, _roomIds: { 'public-id': window.dropRoom.id },
      getConnectionHash: () => '0123456789012345',
    });
    api.manager.peers[peer._peerId] = peer;
    peer._onChannelOpened({ channel });
    return { peer, calls, chunker, digester, channel };
  }
  return { ...api, window, Events, timers, sockets, addPeer };
}

test('正常传输仍有离开保护；断开后取消读取、释放半成品并允许立即离开', () => {
  const f = fixture(), p = f.addPeer();
  const activeLeave = new Event('beforeunload', { cancelable: true });
  f.window.dispatchEvent(activeLeave);
  assert.equal(activeLeave.defaultPrevented, true);
  f.Events.fire('peer-disconnected', p.peer._peerId);
  const stoppedLeave = new Event('beforeunload', { cancelable: true });
  f.window.dispatchEvent(stoppedLeave);
  assert.equal(stoppedLeave.defaultPrevented, false);
  p.chunker._onChunkRead(new ArrayBuffer(10));
  p.peer._send('late callback');
  assert.deepEqual(p.calls, { channelClose: 1, connectionClose: 1, abort: 1, read: 0, send: 0 });
  assert.equal(p.peer._busy, false);
  assert.equal(p.peer._chunker, null);
  assert.equal(p.peer._digester, null);
  assert.equal(p.peer._filesRequested, null);
  assert.equal(p.peer._requestAccepted, null);
  assert.equal(p.digester._buffer.length, 0);
  assert.equal(Object.keys(f.manager.peers).length, 0);
});

test('通道重复打开不累加离开监听器，关闭后不重建已被移除的孤立连接', () => {
  const f = fixture(), p = f.addPeer(); let warnings = 0;
  p.peer._onBeforeUnload = () => warnings++;
  p.peer._onChannelOpened({ channel: p.channel });
  p.peer._onChannelOpened({ channel: p.channel });
  f.window.dispatchEvent(new Event('beforeunload'));
  assert.equal(warnings, 1);
  p.peer._onChannelClosed();
  assert.equal(p.peer._dropDisposed, true);
  f.window.dispatchEvent(new Event('beforeunload'));
  assert.equal(warnings, 1);
  // 重复断开同一设备也只关闭一次，不抛异常。
  f.Events.fire('peer-disconnected', p.peer._peerId);
  assert.equal(p.calls.connectionClose, 1);
});

test('到期关闭会清理全部 WebRTC 设备和定时器，不等待网络请求才解除离开保护', async () => {
  const f = fixture(async () => Response.json({ ticket: 'test-ticket' }));
  const p = f.addPeer(); let error;
  f.window.dropError = message => { error = message; };
  const server = new f.ServerConnection();
  await new Promise(setImmediate);
  assert.equal(f.sockets.length, 1);
  const socket = f.sockets[0]; socket.readyState = 1; socket.onopen();
  assert.equal(f.timers.size, 1);
  socket.onclose({ code: 4000, reason: '房间已到期' });
  assert.equal(error, '房间已到期');
  assert.equal(server._stopped, true);
  assert.equal(p.peer._dropDisposed, true);
  assert.equal(f.timers.size, 0);
  const leave = new Event('beforeunload', { cancelable: true }); f.window.dispatchEvent(leave);
  assert.equal(leave.defaultPrevented, false);
  f.Events.fire('online');
  assert.equal(f.sockets.length, 1);
});

test('连接请求未返回时离开会取消请求；迟到的成功响应不能重新打开房间', async () => {
  let resolve, signal;
  const f = fixture((_, options) => { signal = options.signal; return new Promise(done => { resolve = done; }); });
  const server = new f.ServerConnection();
  f.window.dropLeave();
  assert.equal(signal.aborted, true);
  assert.equal(server._stopped, true);
  resolve(Response.json({ ticket: 'late-ticket' }));
  await new Promise(setImmediate);
  assert.equal(f.sockets.length, 0);
  assert.equal(f.timers.size, 0);
});

test('页面已经显示终止提示时，迟到的初始化不能重新发起连接', () => {
  let calls = 0;
  const f = fixture(() => { calls++; return new Promise(() => {}); });
  f.window.dropTerminated = true;
  new f.ServerConnection();
  assert.equal(calls, 0);
});
