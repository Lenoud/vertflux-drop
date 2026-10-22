// 适配临时房间的终止流程，保留上游正常传输的分块和离开页面保护。
function disposeDropPeer(peer) {
    if (!peer || peer._dropDisposed) return;
    peer._dropDisposed = true;
    peer._busy = false;
    Events.off('beforeunload', peer._dropBeforeUnload);
    Events.off('pagehide', peer._dropPageHide);

    const chunker = peer._chunker;
    if (chunker) {
        // 取消读取，并阻止已经进入事件队列的 load 回调继续发送或读取。
        chunker._onChunkRead = chunker._readChunk = () => {};
        if (chunker._reader?.readyState === 1) chunker._reader.abort();
        chunker._file = null;
    }
    if (peer._digester) {
        peer._digester._buffer = [];
        peer._digester._callback = () => {};
    }
    peer._chunker = peer._digester = null;
    peer._filesQueue = [];
    peer._filesReceived = [];
    peer._filesRequested = peer._requestPending = peer._requestAccepted = null;
    peer._roomIds = {};

    if (peer._channel) {
        peer._channel.onopen = peer._channel.onclose = peer._channel.onmessage = peer._channel.onerror = null;
        peer._channel.close();
    }
    if (peer._conn) {
        peer._conn.onicecandidate = peer._conn.onicecandidateerror = null;
        peer._conn.onconnectionstatechange = peer._conn.oniceconnectionstatechange = peer._conn.ondatachannel = null;
        peer._conn.close();
    }
    peer._channel = peer._conn = null;
}

RTCPeer.prototype._onChannelOpened = function (event) {
    const channel = event.channel || event.target;
    if (this._dropDisposed) { channel.close(); return; }
    channel.binaryType = 'arraybuffer';
    channel.onmessage = e => this._onMessage(e.data);
    channel.onclose = () => this._onChannelClosed();
    this._channel = channel;
    // 一个设备只保留一组可移除的监听器，重连不累加匿名 beforeunload。
    Events.off('beforeunload', this._dropBeforeUnload);
    Events.off('pagehide', this._dropPageHide);
    this._dropBeforeUnload = e => this._onBeforeUnload(e);
    this._dropPageHide = () => this._onPageHide();
    Events.on('beforeunload', this._dropBeforeUnload);
    Events.on('pagehide', this._dropPageHide);
    Events.fire('peer-connected', { peerId: this._peerId, connectionHash: this.getConnectionHash() });
};

const dropOriginalConnect = RTCPeer.prototype._connect;
RTCPeer.prototype._connect = function () {
    // 上游在 channel close 事件后会尝试重连；已从管理器删除的对象不能复活。
    if (!this._dropDisposed) return dropOriginalConnect.call(this);
};
const dropOriginalSend = RTCPeer.prototype._send;
RTCPeer.prototype._send = function (message) {
    if (!this._dropDisposed) return dropOriginalSend.call(this, message);
};
PeersManager.prototype._onPeerDisconnected = function (peerId) {
    const peer = this.peers[peerId];
    delete this.peers[peerId];
    disposeDropPeer(peer);
};
Events.on('drop-disconnected', () => {
    if (typeof pairDrop === 'undefined' || !pairDrop.peers) return;
    for (const peerId of Object.keys(pairDrop.peers.peers)) {
        Events.fire('peer-disconnected', peerId);
    }
});
