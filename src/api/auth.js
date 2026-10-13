// Who is calling?
//
//  - API keys (Authorization: Bearer tb128_...) — 128bitplay and other apps.
//    Scoped: read / write / ingest / admin.
//  - The owner, using the web UI. Requests must carry `X-128bit-Client: web`
//    (a custom header browsers won't send cross-site without a CORS
//    preflight we never approve — that's the CSRF guard), plus either:
//      * TRACKER_PASSWORD unset → loopback connections only (local-first), or
//      * a session cookie from POST /api/v1/session with the password.
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { authenticateKey, SCOPES } from '../domain/apikeys.js';
import { HttpError } from './errors.js';

const COOKIE = 'tb128_session';
const SESSION_DAYS = 30;

export function createAuth(db, { password = process.env.TRACKER_PASSWORD, secret = process.env.TRACKER_SECRET } = {}) {
  const key = secret || randomBytes(32).toString('hex'); // sessions reset on restart if no secret configured

  const sign = (payload) => createHmac('sha256', key).update(payload).digest('base64url');

  function issueCookie() {
    const exp = Date.now() + SESSION_DAYS * 86400_000;
    const payload = `owner.${exp}`;
    return `${COOKIE}=${payload}.${sign(payload)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
  }

  function validCookie(header) {
    const m = (header ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    if (!m) return false;
    const parts = m[1].split('.');
    if (parts.length !== 3) return false;
    const payload = `${parts[0]}.${parts[1]}`;
    const a = Buffer.from(sign(payload));
    const b = Buffer.from(parts[2]);
    return a.length === b.length && timingSafeEqual(a, b) && Number(parts[1]) > Date.now();
  }

  function checkPassword(given) {
    if (!password) return true;
    const a = createHmac('sha256', key).update(String(given ?? '')).digest();
    const b = createHmac('sha256', key).update(password).digest();
    return timingSafeEqual(a, b);
  }

  /** Returns a principal: { kind: 'owner' | 'key', scopes, key? } or null. */
  function identify(req) {
    const authz = req.headers.authorization ?? '';
    if (authz.startsWith('Bearer ')) {
      const k = authenticateKey(db, authz.slice(7).trim());
      if (!k) throw new HttpError(401, 'invalid or revoked API key');
      return { kind: 'key', scopes: k.scopes, key: { id: k.id, name: k.name } };
    }
    if (req.headers['x-128bit-client'] === 'web') {
      const owner = { kind: 'owner', scopes: SCOPES };
      if (password) return validCookie(req.headers.cookie) ? owner : null;
      if (isLoopback(req.socket.remoteAddress)) return owner;
    }
    return null;
  }

  return { identify, issueCookie, checkPassword, passwordRequired: !!password, clearCookie: `${COOKIE}=; Path=/; Max-Age=0` };
}

function isLoopback(addr = '') {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export function requireScope(principal, scope) {
  if (!principal) throw new HttpError(401, 'authentication required');
  if (!principal.scopes.includes(scope)) throw new HttpError(403, `missing scope: ${scope}`);
}
