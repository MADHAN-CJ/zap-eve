/**
 * Client-side Zap session: the JWT from email-OTP login, stored in this
 * browser's localStorage and sent as a Bearer header on every request. The
 * token is the ONLY secret the browser ever holds — Dhan credentials and the
 * Anthropic key live server-side. Clearing it logs out locally; server-side
 * threads are untouched and return on the next login with the same email.
 */

const TOKEN_STORAGE = 'zap_eve.token';
const USER_STORAGE = 'zap_eve.user';

export interface SessionUser {
  id: string;
  email: string;
}

export function getToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(TOKEN_STORAGE) ?? '';
}

export function getUser(): SessionUser | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(USER_STORAGE);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: SessionUser): void {
  localStorage.setItem(TOKEN_STORAGE, token);
  localStorage.setItem(USER_STORAGE, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_STORAGE);
  localStorage.removeItem(USER_STORAGE);
}

export function isLoggedIn(): boolean {
  return getToken().length > 0;
}

/** Headers attached to every API and eve-proxy request. */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function jsonError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export async function requestOtp(email: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/auth/request-otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: await jsonError(res, 'Could not send the code.') };
  } catch {
    return { ok: false, error: "Couldn't reach the server." };
  }
}

export async function verifyOtp(
  email: string,
  code: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
    if (!res.ok) return { ok: false, error: await jsonError(res, 'Invalid or expired code.') };
    const body = (await res.json()) as { token: string; user: SessionUser };
    setSession(body.token, body.user);
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't reach the server." };
  }
}
