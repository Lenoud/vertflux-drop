// 每个应用保留同一份边界逻辑；日志只接受固定字段，不记录 URL、Cookie 和正文。
const CALLBACK_COOKIE = /^__Host-vertflux_sso_csrf(?:_[A-Za-z0-9_-]+)?=.+$/

export function callbackError(request) {
  const url = new URL(request.url)
  if (url.pathname !== '/oauth2/callback') return 0
  if (!url.searchParams.get('code') || !url.searchParams.get('state')) return 400
  const cookies = (request.headers.get('Cookie') || '').split(';').map(part => part.trim())
  return cookies.some(part => CALLBACK_COOKIE.test(part)) ? 0 : 403
}

export function invalidPath(path) {
  // 单次解码后仍有分隔符编码时直接拒绝，避免业务框架再次解码。
  return /[\\\x00-\x1f\x7f]|%(?:25|2f|5c|00)/i.test(path)
}

export function blockedProbe(path) {
  return /(?:^|\/)\.(?:env(?:\.|\/|$)|git(?:\/|$)|svn(?:\/|$)|hg(?:\/|$))|^\/(?:phpinfo\.php|credentials\.json|firebase-key\.json)(?:\/|$)/i.test(path)
}

function pathTemplate(path) {
  if (['/', '/dashboard', '/api/session', '/api/chat', '/api/health', '/signed-out', '/cron'].includes(path)) return path
  if (/^\/oauth2\/(start|callback|sign_out)$/.test(path)) return path
  if (/^\/(host|join)\//.test(path)) return `/${path.split('/')[1]}/:room`
  if (path.startsWith('/api/')) return '/api/*'
  if (/^\/(assets|_next|scripts|styles|images|fonts|sounds|lang)\//.test(path)) return '/static/*'
  // 未知路径可能包含订阅 Token 或短链接，不保留其原文。
  return '/*'
}

export function auditGateway(app, handler) {
  return async (request, env, context) => {
    const started = Date.now()
    const audit = {
      app,
      path_template: pathTemplate(new URL(request.url).pathname),
      method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method) ? request.method : 'OTHER',
      request_id: crypto.randomUUID(),
      auth_result: 'public',
      reason: '',
    }
    let response
    try {
      response = await handler(request, env, audit, context)
    } catch {
      // 异常对象可能携带上游 URL、请求头及正文，禁止直接输出。
      audit.reason = 'unhandled_gateway_error'
      response = Response.json({ error: '服务暂时不可用，请稍后重试。' }, {
        status: 503,
        headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' },
      })
    }
    audit.status = response.status
    audit.duration_ms = Date.now() - started
    if (!audit.reason) audit.reason = response.status >= 500 ? 'service_error' : response.status >= 400 ? 'request_rejected' : 'completed'
    // 静态资源和正常公开请求不逐条记录；拒绝和错误不采样。
    if (response.status >= 400 || (audit.auth_result !== 'public' && audit.path_template !== '/static/*')) {
      const output = JSON.stringify(audit)
      if (response.status >= 500) console.error(output)
      else console.info(output)
    }
    // 101 响应包含 WebSocket，不能用普通 Response 重建。
    if (response.status === 101) return response
    const result = new Response(response.body, response)
    result.headers.set('X-Request-ID', audit.request_id)
    return result
  }
}
