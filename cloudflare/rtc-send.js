// 等 RTC 队列排空一部分再继续，避免批量读取把大量分块瞬间塞进 SCTP。
function sendFileChunk(channel, chunk) {
    if (!channel || channel.readyState !== 'open') throw new Error('RTC 数据通道未连接');
    const highWater = 128 * 1024, lowWater = 64 * 1024;
    if (channel.bufferedAmount <= highWater) { channel.send(chunk); return; }
    channel.bufferedAmountLowThreshold = lowWater;
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            channel.removeEventListener('bufferedamountlow', resume);
            channel.removeEventListener('close', closed);
            channel.removeEventListener('error', closed);
        };
        const closed = () => { cleanup(); reject(new Error('RTC 数据通道已关闭')); };
        const resume = () => {
            if (channel.readyState !== 'open') { closed(); return; }
            if (channel.bufferedAmount > lowWater) return;
            cleanup();
            try { channel.send(chunk); resolve(); } catch (error) { reject(error); }
        };
        channel.addEventListener('bufferedamountlow', resume);
        channel.addEventListener('close', closed);
        channel.addEventListener('error', closed);
        resume();
    });
}

RTCPeer.prototype._sendFileChunk = function (chunk) { return sendFileChunk(this._channel, chunk); };
