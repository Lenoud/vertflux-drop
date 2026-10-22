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
    bar.innerHTML = '<div><a class="vf-brand" href="/">vertflux<span>drop</span></a><div class="vf-room-meta" id="vf-room-status">正在连接房间…</div></div><div class="vf-room-buttons"><input id="vf-invite" aria-label="邀请链接" readonly hidden><button id="vf-copy" hidden>复制邀请</button><button id="vf-close" hidden>结束房间</button><a href="/">离开</a></div>';
    document.body.append(bar);
    const mode = document.createElement('div'); mode.className = 'vf-room-mode'; mode.id = 'vf-mode';
    const connection = document.createElement('div'); connection.id = 'vf-connection';
    const speed = document.createElement('div'); speed.id = 'vf-speed'; speed.setAttribute('aria-live', 'polite');
    mode.append(connection, speed); document.body.append(mode);
    let activePeer, statsTimer, expiresTimer, statsBusy = false, transfer, incomingSize = 0, outgoingSize = 0;
    const startupTimer = setTimeout(() => {
      const message = '页面加载或连接超时，请返回首页重新进入。';
      if (window.dropStop) window.dropStop(message); else window.dropError(message);
    }, 20000);
    const mib = bytes => (bytes / (1024 * 1024)).toFixed(1);
    const beginTransfer = (direction, total) => {
      transfer = { direction, total, start: performance.now(), bytes: 0, sampleBytes: 0, sampleAt: performance.now(), rate: 0 };
      speed.textContent = `正在${direction} · 等待数据…`;
    };
    const finishTransfer = () => {
      if (!transfer) return;
      const seconds = Math.max(0.001, (performance.now() - transfer.start) / 1000);
      speed.textContent = `已${transfer.direction} ${mib(transfer.total)} MiB · ${seconds.toFixed(1)} 秒 · 平均 ${mib(transfer.total / seconds)} MiB/s`;
      transfer = null;
    };
    window.addEventListener('files-transfer-request', event => { incomingSize = event.detail.request.totalSize; });
    window.addEventListener('files-selected', event => { outgoingSize = [...event.detail.files].reduce((sum, file) => sum + file.size, 0); });
    window.addEventListener('respond-to-files-transfer-request', event => { if (event.detail.accepted) beginTransfer('接收', incomingSize); });
    window.addEventListener('file-transfer-accepted', () => beginTransfer('发送', outgoingSize));
    window.addEventListener('files-received', finishTransfer);
    window.addEventListener('files-sent', finishTransfer);
    window.addEventListener('set-progress', event => {
      if (!transfer || event.detail.status !== 'transfer') return;
      transfer.bytes = transfer.total * event.detail.progress;
      const now = performance.now(), elapsed = (now - transfer.sampleAt) / 1000;
      if (elapsed < 0.5) return;
      transfer.rate = Math.max(0, (transfer.bytes - transfer.sampleBytes) / elapsed);
      transfer.sampleAt = now; transfer.sampleBytes = transfer.bytes;
      speed.textContent = `正在${transfer.direction} · ${mib(transfer.rate)} MiB/s · ${Math.round(event.detail.progress * 100)}%`;
    });
    const updateConnection = async () => {
      if (!activePeer?._conn || statsBusy) return;
      statsBusy = true;
      const peer = activePeer;
      try {
        const stats = await peer._conn.getStats();
        if (peer !== activePeer) return;
        let chosen;
        stats.forEach(item => { if (item.type === 'transport' && item.selectedCandidatePairId) chosen = stats.get(item.selectedCandidatePairId); });
        if (!chosen) stats.forEach(item => { if (item.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated) chosen = item; });
        const local = chosen && stats.get(chosen.localCandidateId), remote = chosen && stats.get(chosen.remoteCandidateId);
        if (!local || !remote) { connection.textContent = '已连接 · 正在确认传输路径'; return; }
        const relay = local.candidateType === 'relay' || remote.candidateType === 'relay';
        const latency = Number.isFinite(chosen.currentRoundTripTime) ? ` · 延迟 ${Math.round(chosen.currentRoundTripTime * 1000)} ms` : '';
        connection.textContent = `已连接 · ${relay ? '加密中继传输' : '设备直传'}${latency}`;
        connection.title = relay ? '通过 TURN 转发加密数据。' : '未使用 TURN 中继。实际路径仍可能经过路由器或 VPN；同一 Wi-Fi 不保证选中局域网路径。';
        if (transfer && performance.now() - transfer.sampleAt > 2500) speed.textContent = `正在${transfer.direction} · 等待数据…`;
      } catch { if (peer === activePeer) connection.textContent = '已连接 · 加密传输'; }
      finally { statsBusy = false; }
    };
    const overlay = document.createElement('div'); overlay.className = 'vf-room-overlay'; overlay.hidden = true;
    overlay.setAttribute('role', 'alert');
    overlay.innerHTML = '<div><h2>传输已中断</h2><p id="vf-error"></p><p class="vf-error-help">未完成的文件需要重新发送，当前不支持断点续传。</p><a href="/">返回快传首页</a></div>'; document.body.append(overlay);
    overlay.querySelector('a').addEventListener('click', event => {
      event.preventDefault();
      window.dropLeave?.();
      // 本地资源清理同步完成，不等待服务端关闭或 TURN 撤销后才跳转。
      location.assign('/');
    });
    window.dropStatus = text => { document.getElementById('vf-room-status').textContent = text; };
    window.dropError = message => {
      window.dropTerminated = true;
      clearTimeout(startupTimer); clearTimeout(expiresTimer); clearInterval(statsTimer);
      activePeer = null; transfer = null;
      connection.textContent = '连接已关闭'; speed.textContent = '';
      window.dropStatus('房间连接已中断');
      document.getElementById('vf-copy').hidden = true;
      document.getElementById('vf-close').hidden = true;
      document.getElementById('vf-invite').hidden = true;
      overlay.hidden = false; document.getElementById('vf-error').textContent = message;
    };
    window.dropReady = data => {
      if (window.dropTerminated) return;
      clearTimeout(startupTimer); clearTimeout(expiresTimer);
      document.title = `${data.title} · Vertflux Drop`;
      const expires = new Date(data.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
      window.dropStatus(`${data.title} · ${expires} 到期`);
      if (data.role === 'host') {
        const invite = document.getElementById('vf-invite'); invite.hidden = false; invite.value = location.origin + data.invite;
        invite.onclick = () => invite.select();
        const copy = document.getElementById('vf-copy'); copy.hidden = false;
        copy.onclick = async () => {
          try { await navigator.clipboard.writeText(location.origin + data.invite); copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制邀请'; }, 2000); }
          catch { invite.focus(); invite.select(); copy.textContent = '请手动复制链接'; }
        };
        const close = document.getElementById('vf-close'); close.hidden = false;
        close.onclick = async () => {
          if (!confirm('结束房间后，正在进行的传输会中断。确定结束吗？')) return;
          close.disabled = true;
          try { const response = await fetch(`/api/host/${id}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15000) }); if (!response.ok) throw new Error(); window.dropStop?.('房间已结束。'); }
          catch { if (!window.dropTerminated) { close.disabled = false; window.dropStatus('结束房间失败，请重试；也可以点击“离开”。'); } }
        };
      }
      expiresTimer = setTimeout(() => window.dropStop?.('房间已到期，请重新创建。'), Math.max(0, data.expiresAt - Date.now()));
    };
    window.addEventListener('peer-connected', event => {
      activePeer = typeof pairDrop !== 'undefined' && pairDrop.peers.peers[event.detail.peerId];
      clearInterval(statsTimer);
      void updateConnection(); statsTimer = setInterval(updateConnection, 1000);
    });
    window.addEventListener('peer-disconnected', () => {
      activePeer = null; transfer = null; clearInterval(statsTimer);
      connection.textContent = window.dropTerminated ? '连接已关闭' : '等待对方重新连接'; speed.textContent = '';
    });
    window.addEventListener('pagehide', () => { clearInterval(statsTimer); clearTimeout(startupTimer); clearTimeout(expiresTimer); });
  });
})();
