const $ = id => document.getElementById(id);
async function api(path, body) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) { if (value.loginUrl) location.href = value.loginUrl; throw new Error(value.error || '操作失败，请稍后重试。'); }
  return value;
}
async function refresh() {
  try {
    const result = await api('/api/rooms'); $('rooms').replaceChildren();
    if (!result.rooms.length) { const p = document.createElement('p'); p.className = 'vf-small'; p.textContent = '还没有房间，创建一个开始传输。'; $('rooms').append(p); }
    for (const room of result.rooms) {
      const row = document.createElement('div'); row.className = 'vf-room-item';
      const details = document.createElement('div'), name = document.createElement('strong'), date = document.createElement('small');
      name.textContent = room.title; date.textContent = new Date(room.createdAt).toLocaleString('zh-CN', { hour12: false });
      details.append(name, date); row.append(details);
      if (!room.closed && room.expiresAt > Date.now()) { const link = document.createElement('a'); link.href = `/host/${room.id}`; link.textContent = '进入房间 ↗'; row.append(link); }
      else { const span = document.createElement('span'); span.className = 'vf-expired'; span.textContent = '已结束'; row.append(span); }
      $('rooms').append(row);
    }
  } catch (error) { $('error').textContent = error.message; }
}
if (location.pathname === '/dashboard') {
  $('dashboard').hidden = false; $('start').hidden = true;
  api('/api/session').then(s => { $('account').textContent = s.username; }).catch(e => { $('error').textContent = e.message; });
  refresh();
}
$('refresh').addEventListener('click', refresh);
$('create-room').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true; $('error').textContent = '';
  try { const room = await api('/api/rooms', { title: $('room-title').value, minutes: Number($('minutes').value) }); location.href = `/host/${room.id}`; }
  catch (error) { $('error').textContent = error.message; button.disabled = false; }
});
