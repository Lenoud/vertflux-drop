const HOST = 'drop.vertflux.com', ORIGIN = `https://${HOST}`, AUTH = 'https://auth.vertflux.com';
export const authCookies = request => (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).filter(s => s.split('=')[0].startsWith('__Host-vertflux_sso')).join('; ');
export function safeHeaders(request) {
  const headers = new Headers(request.headers);
  for (const key of [...headers.keys()]) if (/^(x-vertflux-|x-drop-|x-auth-request-|x-forwarded-|x-user$|x-email$|remote-user$|cf-access-|authorization$|cookie$)/i.test(key)) headers.delete(key);
  return headers;
}
function secure(response) {
  if (response.status === 101) return response;
  const result = new Response(response.body, response);
  result.headers.set('Cache-Control', 'private, no-store');
  result.headers.set('Vary', 'Cookie');
  result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('X-Frame-Options', 'DENY');
  result.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  result.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self' wss://drop.vertflux.com; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  return result;
}
const error = (status, message) => secure(Response.json({ error: message }, { status }));
export function createGateway(fetchAuth = fetch) {
  return { async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname;
    if (url.hostname !== HOST || url.protocol !== 'https:') {
      if (!['GET', 'HEAD'].includes(request.method)) return error(403, '请使用快传的正式域名。');
      return secure(Response.redirect(ORIGIN + path, 302));
    }
    let decoded;
    try { decoded = decodeURIComponent(path); } catch { return error(400, '路径无效。'); }
    if (decoded !== path || path.includes('//') || path.includes('\\')) return error(400, '路径无效。');
    if (path.startsWith('/oauth2/')) {
      if (!['/oauth2/start', '/oauth2/callback', '/oauth2/sign_out'].includes(path) || !['GET', 'HEAD'].includes(request.method)) return error(404, '登录入口不存在。');
      try { if (url.searchParams.get('rd') && new URL(url.searchParams.get('rd'), ORIGIN).origin !== ORIGIN) return error(400, '登录返回地址无效。'); }
      catch { return error(400, '登录返回地址无效。'); }
      try { return secure(await fetchAuth(`${AUTH}/edge/drop${path}${url.search}`, { headers: { Cookie: authCookies(request), Accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(15000) })); }
      catch { return error(503, '统一认证暂时不可用。'); }
    }
    const websocket = path === '/server';
    if (websocket && (request.headers.get('Origin') !== ORIGIN || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')) return error(403, '连接来源无效。');
    const isApi = path.startsWith('/api/');
    const guestApi = /^\/api\/guest\/[a-f0-9-]{36}\/connect$/.test(path);
    const host = path === '/dashboard' || /^\/host\/[a-f0-9-]{36}$/.test(path) || isApi && !guestApi && path !== '/api/health';
    if (!['GET', 'HEAD'].includes(request.method)) {
      if (request.method !== 'POST' || request.headers.get('Origin') !== ORIGIN) return error(403, '请从快传页面发起操作。');
      if (!request.headers.get('Content-Type')?.startsWith('application/json')) return error(415, '请求格式无效。');
    }
    if (isApi && request.method === 'POST' && !(path === '/api/rooms' || /^\/api\/(host|guest)\/[a-f0-9-]{36}\/(connect|close)$/.test(path))) return error(404, '接口不存在。');
    let identity;
    if (host) {
      const cookie = authCookies(request);
      if (cookie) {
        try {
          const response = await fetchAuth(`${AUTH}/api/session?app=${HOST}`, { headers: { Cookie: cookie, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
          if (response.status === 403) return error(403, '当前账号没有创建快传房间的权限。');
          if (response.ok) { identity = await response.json(); if (!identity?.subject || !identity?.username) return error(503, '统一认证返回的身份无效。'); }
          else if (response.status !== 401) return error(503, '统一认证暂时不可用。');
        } catch { return error(503, '统一认证暂时不可用。'); }
      }
      if (!identity) {
        const loginUrl = `/oauth2/start?rd=${encodeURIComponent(ORIGIN + (isApi ? '/dashboard' : path))}`;
        return isApi ? secure(Response.json({ error: '请先登录。', loginUrl }, { status: 401 })) : secure(Response.redirect(ORIGIN + loginUrl, 302));
      }
    }
    if (path === '/api/session' && request.method === 'GET') return secure(Response.json({ username: identity.username }));
    if (isApi || websocket) {
      const headers = safeHeaders(request);
      if (identity) { headers.set('X-Vertflux-Subject', identity.subject); headers.set('X-Vertflux-Username', encodeURIComponent(identity.username)); }
      let body;
      if (request.method === 'POST') {
        const reader = request.body?.getReader(), chunks = []; let size = 0;
        if (reader) for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 4096) { await reader.cancel(); return error(413, '请求内容过长。'); } chunks.push(item.value); }
        body = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
        try { const value = JSON.parse(new TextDecoder().decode(body)); if (!value || typeof value !== 'object' || Array.isArray(value)) return error(400, '请求格式无效。'); } catch { return error(400, '请求格式无效。'); }
      }
      try { return secure(await env.DROP_API.fetch(new Request(`https://drop-api.internal${path}`, { method: request.method, headers, body }))); }
      catch { return error(503, '快传服务暂时不可用。'); }
    }
    if (!['GET', 'HEAD'].includes(request.method)) return error(404, '页面不存在。');
    const asset = new URL(request.url);
    // Pages 会把 .html URL 重定向到规范地址；内部取资源时直接使用规范路径。
    if (path === '/' || path === '/dashboard') asset.pathname = '/vertflux';
    else if (/^\/(host|join)\/[a-f0-9-]{36}$/.test(path)) asset.pathname = '/';
    else if (!/^\/(scripts|styles|lang|images|fonts|sounds)\//.test(path) && !['/manifest.json', '/service-worker.js', '/robots.txt'].includes(path)) return error(404, '页面不存在。');
    return secure(await env.ASSETS.fetch(new Request(asset, request)));
  } };
}
export default createGateway();
