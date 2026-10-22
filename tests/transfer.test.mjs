import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../cloudflare/file-chunker.js', import.meta.url), 'utf8');
const rtcSource = await readFile(new URL('../cloudflare/rtc-send.js', import.meta.url), 'utf8');
const sendFileChunk = vm.runInNewContext(rtcSource + '\nsendFileChunk;', { RTCPeer: class {} });
function fixture() {
  let reads = 0;
  class FileReader {
    handlers = {};
    addEventListener(name, handler) { this.handlers[name] = handler; }
    async readAsArrayBuffer(blob) {
      reads++;
      this.handlers.load({ target: { result: await blob.arrayBuffer() } });
    }
  }
  return { Chunker: vm.runInNewContext(source + '\nFileChunker;', { FileReader }), reads: () => reads };
}

test('批量分块在确认前暂停，逐字节保持文件完整并限制发送窗口', async () => {
  const { Chunker, reads } = fixture();
  const input = Buffer.alloc(9 * 1024 * 1024 + 103);
  for (let i = 0; i < input.length; i++) input[i] = i % 251;
  const received = []; const partitions = [];
  let total = 0, unconfirmed = 0, maximum = 0, chunker;
  await new Promise((resolve, reject) => {
    chunker = new Chunker(new Blob([input]), chunk => {
      assert.ok(chunk.byteLength > 0 && chunk.byteLength <= 64000);
      received.push(Buffer.from(chunk)); total += chunk.byteLength; unconfirmed += chunk.byteLength;
      maximum = Math.max(maximum, unconfirmed);
      if (total === input.length) resolve();
    }, offset => {
      partitions.push(offset);
      const pausedReads = reads();
      setTimeout(() => {
        try {
          assert.equal(reads(), pausedReads, '收到确认前不能继续读文件');
          assert.equal(total, offset);
          unconfirmed = 0; chunker.nextPartition();
        } catch (error) { reject(error); }
      }, 5);
    }, reject);
    chunker.nextPartition();
  });
  assert.deepEqual(Buffer.concat(received), input);
  assert.deepEqual(partitions, [4 * 1024 * 1024, 8 * 1024 * 1024]);
  assert.ok(maximum <= 4 * 1024 * 1024);
  assert.equal(reads(), 10);
  assert.ok(chunker.isFileEnd());
});

test('发送队列出错后停止读取，不会无限继续排队', async () => {
  const { Chunker, reads } = fixture();
  const failure = new Error('模拟 RTC 队列错误');
  let sends = 0, chunker;
  const caught = await new Promise(resolve => {
    chunker = new Chunker(new Blob([new Uint8Array(8 * 1024 * 1024)]), () => { sends++; throw failure; }, () => assert.fail('出错后不能发送分区完成消息'), resolve);
    chunker.nextPartition();
  });
  assert.equal(caught, failure);
  chunker.nextPartition();
  assert.equal(reads(), 1);
  assert.equal(sends, 1);
});

class Channel extends EventTarget {
  readyState = 'open'; bufferedAmount = 0; sent = [];
  send(chunk) { this.sent.push(chunk); this.bufferedAmount += chunk.byteLength; }
  drain(bytes) { this.bufferedAmount = bytes; this.dispatchEvent(new Event('bufferedamountlow')); }
}

test('RTC 背压在队列降低后继续发送，关闭时拒绝等待中的分块', async () => {
  const channel = new Channel(), chunk = new Uint8Array(64000);
  channel.bufferedAmount = 256 * 1024;
  const pending = sendFileChunk(channel, chunk);
  assert.equal(channel.sent.length, 0);
  channel.drain(70 * 1024);
  assert.equal(channel.sent.length, 0);
  channel.drain(64 * 1024);
  await pending;
  assert.equal(channel.sent.length, 1);
  assert.ok(channel.bufferedAmount <= 128 * 1024 + 64000);
  channel.bufferedAmount = 256 * 1024;
  const closed = sendFileChunk(channel, chunk);
  channel.readyState = 'closed'; channel.dispatchEvent(new Event('close'));
  await assert.rejects(closed, /已关闭/);
  channel.drain(0);
  assert.equal(channel.sent.length, 1, '关闭后不能再发送等待的分块');
});

test('文件读取等待异步 RTC 背压，所有分块按顺序发送且没有并发发送', async () => {
  const { Chunker } = fixture(), input = Buffer.alloc(2 * 1024 * 1024 + 7, 37);
  let active = 0, maximum = 0, total = 0;
  const received = [];
  await new Promise((resolve, reject) => {
    const chunker = new Chunker(new Blob([input]), async chunk => {
      maximum = Math.max(maximum, ++active);
      await new Promise(done => setImmediate(done));
      received.push(Buffer.from(chunk)); total += chunk.byteLength; active--;
      if (total === input.length) resolve();
    }, () => assert.fail('小于分区大小，不应等待确认'), reject);
    chunker.nextPartition();
  });
  assert.equal(maximum, 1);
  assert.deepEqual(Buffer.concat(received), input);
});
