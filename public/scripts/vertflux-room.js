(() => {
  const match = location.pathname.match(/^\/(host|join)\/([a-f0-9-]{36})$/);
  if (!match) { location.replace('/'); return; }
  const role = match[1] === 'host' ? 'host' : 'guest', id = match[2];
  const key = `drop:${id}:${role}`;
  const peerId = sessionStorage.getItem(`${key}:peer`) || crypto.randomUUID();
  sessionStorage.setItem(`${key}:peer`, peerId);
  const secret = location.hash.slice(1);
  if (role === 'guest' && /^[A-Za-z0-9_-]{43}$/.test(secret)) sessionStorage.setItem(`${key}:invite`, secret);
  history.replaceState({}, '', location.pathname);
  if (!localStorage.getItem('language_code')) localStorage.setItem('language_code', 'zh-CN');
  window.dropRoom = { id, role, peerId, invitation: sessionStorage.getItem(`${key}:invite`), key };
  document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('vf-transfer');
    const bar = document.createElement('div'); bar.className = 'vf-room-bar';
    bar.innerHTML = '<div><a class="vf-brand" href="/">vertflux<span>drop</span></a><div class="vf-room-meta" id="vf-room-status">正在连接房间…</div></div><div class="vf-room-buttons"><button id="vf-copy" hidden>复制邀请</button><button id="vf-close" hidden>结束房间</button><a href="/">离开</a></div>';
    document.body.append(bar);
    const mode = document.createElement('div'); mode.className = 'vf-room-mode'; mode.id = 'vf-mode'; document.body.append(mode);
    const overlay = document.createElement('div'); overlay.className = 'vf-room-overlay'; overlay.hidden = true;
    overlay.innerHTML = '<div><h2>传输已暂停</h2><p id="vf-error"></p><a href="/">返回快传首页</a></div>'; document.body.append(overlay);
    window.dropStatus = text => { document.getElementById('vf-room-status').textContent = text; };
    window.dropError = message => { overlay.hidden = false; document.getElementById('vf-error').textContent = message; };
    window.dropReady = data => {
      document.title = `${data.title} · Vertflux Drop`;
      const expires = new Date(data.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
      window.dropStatus(`${data.title} · ${expires} 到期`);
      if (data.role === 'host') {
        const copy = document.getElementById('vf-copy'); copy.hidden = false;
        copy.onclick = async () => {
          try { await navigator.clipboard.writeText(location.origin + data.invite); copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制邀请'; }, 2000); }
          catch { window.dropError('浏览器未允许写入剪贴板，请允许剪贴板权限后重试。'); }
        };
        const close = document.getElementById('vf-close'); close.hidden = false;
        close.onclick = async () => {
          if (!confirm('结束房间后，正在进行的传输会中断。确定结束吗？')) return;
          close.disabled = true;
          try { const response = await fetch(`/api/host/${id}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); if (!response.ok) throw new Error(); window.dropError('房间已结束。'); }
          catch { close.disabled = false; window.dropError('结束房间失败，请刷新后重试。'); }
        };
      }
      setTimeout(() => window.dropStop?.('房间已到期，请重新创建。'), Math.max(0, data.expiresAt - Date.now()));
    };
    window.addEventListener('peer-connected', async event => {
      const peer = typeof pairDrop !== 'undefined' && pairDrop.peers.peers[event.detail.peerId];
      if (!peer?._conn) return;
      try {
        const stats = await peer._conn.getStats(); let chosen;
        stats.forEach(item => { if (item.type === 'transport' && item.selectedCandidatePairId) chosen = stats.get(item.selectedCandidatePairId); });
        if (!chosen) stats.forEach(item => { if (item.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated) chosen = item; });
        const local = chosen && stats.get(chosen.localCandidateId), remote = chosen && stats.get(chosen.remoteCandidateId);
        document.getElementById('vf-mode').textContent = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? '已连接 · 加密中继传输' : '已连接 · 设备直传';
      } catch { document.getElementById('vf-mode').textContent = '已连接 · 加密传输'; }
    });
    window.addEventListener('peer-disconnected', () => { document.getElementById('vf-mode').textContent = '等待对方重新连接'; });
  });
})();
