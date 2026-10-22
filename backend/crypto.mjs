const enc = new TextEncoder();
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function unb64(s) { return Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); }
async function key(secret) { return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
export async function sign(secret, text) { return b64(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(text)))); }
export async function verify(secret, text, signature) {
  try { return await crypto.subtle.verify('HMAC', await key(secret), unb64(signature), enc.encode(text)); } catch { return false; }
}
export async function invitation(secret, roomId) { return sign(secret, `invite:${roomId}`); }
export async function ticket(secret, data) {
  const body = b64(enc.encode(JSON.stringify(data)));
  return `${body}.${await sign(secret, `socket:${body}`)}`;
}
export async function readTicket(secret, value, now = Date.now()) {
  try {
    if (typeof value !== 'string' || value.length > 1024) return null;
    const [body, signature, extra] = value.split('.');
    if (extra || !await verify(secret, `socket:${body}`, signature)) return null;
    const data = JSON.parse(new TextDecoder().decode(unb64(body)));
    return UUID.test(data.roomId) && UUID.test(data.peerId) && ['host', 'guest'].includes(data.role) && data.exp > now ? data : null;
  } catch { return null; }
}
