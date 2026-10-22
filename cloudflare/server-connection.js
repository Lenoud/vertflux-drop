// 保留 PairDrop 的 Peer / RTCPeer / PeersManager，仅适配 Cloudflare 信令入口。
class ServerConnection {
    constructor() {
        this._socket = null; this._peers = new Set(); this._stopped = !!window.dropTerminated;
        Events.on('pagehide', () => this.stop());
        Events.on('online', () => this._connect());
        window.dropStop = message => this.stop(message);
        window.dropLeave = () => this.stop();
        this._connect();
    }
    stop(message) {
        this._stopped = true;
        window.dropTerminated = true;
        this._requestAbort?.abort();
        this._disconnect();
        if (message) window.dropError?.(message);
    }
    async _connect() {
        if (this._stopped || this._connecting || this._socket?.readyState <= 1) return;
        this._connecting = true;
        const room = window.dropRoom;
        const controller = new AbortController(); this._requestAbort = controller;
        try {
            const response = await fetch(`/api/${room.role}/${room.id}/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ peerId: room.peerId, invitation: room.invitation }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
            const data = await response.json();
            if (this._stopped) return;
            if (!response.ok) {
                if (data.loginUrl) { this.stop(); location.href = data.loginUrl; return; }
                if (response.status < 500) { this.stop(data.error || '暂时无法连接房间。'); return; }
                throw new Error(data.error || '暂时无法连接房间。');
            }
            this._config = data;
            window.dropReady?.(data);
            Events.fire('config', { signalingServer: false, buttons: Object.fromEntries(['donation_button', 'twitter_button', 'mastodon_button', 'bluesky_button', 'custom_button', 'privacypolicy_button'].map(name => [name, { active: 'false' }])) });
            const ws = new WebSocket(`wss://${location.host}/server`, ['vertflux-drop', `ticket.${data.ticket}`]);
            ws.onopen = () => {
                clearTimeout(this._openTimeout);
                if (this._stopped || this._socket !== ws) { ws.close(); return; }
                Events.fire('ws-connected'); this._heartbeat = setInterval(() => this.send({ type: 'ping' }), 25000);
            };
            ws.onmessage = event => this._onMessage(JSON.parse(event.data));
            ws.onclose = event => {
                if (this._socket !== ws) return;
                this._clear();
                if (event.code >= 4000) this.stop(event.reason || '房间已关闭。');
                else if (!this._stopped) { window.dropStatus?.('连接已断开，正在重试…'); this._retry = setTimeout(() => this._connect(), 5000); }
            };
            ws.onerror = () => window.dropStatus?.('网络连接不稳定，正在重试…');
            this._socket = ws;
            this._openTimeout = setTimeout(() => { if (ws.readyState === WebSocket.CONNECTING) ws.close(); }, 15000);
        } catch (error) {
            if (this._stopped) return;
            window.dropStatus?.(error.name === 'TimeoutError' ? '连接超时，正在重试…' : error.message);
            this._retry = setTimeout(() => this._connect(), 10000);
        } finally { this._connecting = false; if (this._requestAbort === controller) this._requestAbort = null; }
    }
    _onMessage(message) {
        switch (message.type) {
            case 'ws-config': this._wsConfig = message.wsConfig; Events.fire('ws-config', message.wsConfig); break;
            case 'display-name':
                sessionStorage.setItem('peer_id', message.peerId);
                Events.fire('display-name', message);
                this.send({ type: 'join-ip-room' });
                break;
            case 'peers': message.peers.forEach(peer => this._peers.add(peer.id)); Events.fire('peers', message); break;
            case 'peer-joined': this._peers.add(message.peer.id); Events.fire('peer-joined', message); break;
            case 'peer-left': this._peers.delete(message.peerId); message.roomId = window.dropRoom.id; Events.fire('peer-left', message); break;
            case 'signal': if (this._peers.has(message.sender.id)) Events.fire('signal', message); break;
        }
    }
    send(message) { if (this._socket?.readyState === WebSocket.OPEN) this._socket.send(JSON.stringify(message)); }
    _clear() {
        clearInterval(this._heartbeat); clearTimeout(this._openTimeout);
        this._socket = null;
        for (const peerId of this._peers) Events.fire('peer-left', { peerId, roomType: 'public-id', roomId: window.dropRoom.id, disconnect: true });
        this._peers.clear(); Events.fire('drop-disconnected'); Events.fire('ws-disconnected');
    }
    _disconnect() {
        clearTimeout(this._retry);
        if (this._socket) { this._socket.onopen = this._socket.onclose = this._socket.onmessage = this._socket.onerror = null; this._socket.close(); }
        this._clear();
    }
    _isConnected() { return this._socket?.readyState === WebSocket.OPEN; }
}
