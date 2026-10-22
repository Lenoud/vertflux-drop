// 保留 PairDrop 的 Peer / RTCPeer / PeersManager，仅适配 Cloudflare 信令入口。
class ServerConnection {
    constructor() {
        this._socket = null; this._peers = new Set(); this._stopped = false;
        Events.on('pagehide', () => this._disconnect());
        Events.on('online', () => this._connect());
        window.dropStop = message => { this._stopped = true; this._disconnect(); window.dropError?.(message); };
        this._connect();
    }
    async _connect() {
        if (this._stopped || this._connecting || this._socket?.readyState <= 1) return;
        this._connecting = true;
        const room = window.dropRoom;
        try {
            const response = await fetch(`/api/${room.role}/${room.id}/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ peerId: room.peerId, invitation: room.invitation }) });
            const data = await response.json();
            if (!response.ok) { if (data.loginUrl) location.href = data.loginUrl; if (response.status < 500) this._stopped = true; throw new Error(data.error || '暂时无法连接房间。'); }
            this._config = data;
            window.dropReady?.(data);
            Events.fire('config', { signalingServer: false, buttons: Object.fromEntries(['donation_button', 'twitter_button', 'mastodon_button', 'bluesky_button', 'custom_button', 'privacypolicy_button'].map(name => [name, { active: 'false' }])) });
            const ws = new WebSocket(`wss://${location.host}/server`, ['vertflux-drop', `ticket.${data.ticket}`]);
            ws.onopen = () => { Events.fire('ws-connected'); this._heartbeat = setInterval(() => this.send({ type: 'ping' }), 25000); };
            ws.onmessage = event => this._onMessage(JSON.parse(event.data));
            ws.onclose = event => {
                this._clear();
                if (event.code >= 4000) { this._stopped = true; window.dropError?.(event.reason || '房间已关闭。'); }
                else if (!this._stopped) { window.dropStatus?.('连接已断开，正在重试…'); this._retry = setTimeout(() => this._connect(), 5000); }
            };
            ws.onerror = () => window.dropStatus?.('网络连接不稳定，正在重试…');
            this._socket = ws;
        } catch (error) {
            if (this._stopped) window.dropError?.(error.message);
            else { window.dropStatus?.(error.message); this._retry = setTimeout(() => this._connect(), 10000); }
        } finally { this._connecting = false; }
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
        clearInterval(this._heartbeat);
        this._socket = null;
        for (const peerId of this._peers) Events.fire('peer-left', { peerId, roomType: 'public-id', roomId: window.dropRoom.id, disconnect: true });
        this._peers.clear(); Events.fire('ws-disconnected');
    }
    _disconnect() {
        clearTimeout(this._retry);
        if (this._socket) { this._socket.onclose = null; this._socket.close(); }
        this._clear();
    }
    _isConnected() { return this._socket?.readyState === WebSocket.OPEN; }
}
