import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

/**
 * Zap session auth: email OTP → 7-day JWT (HS256, AUTH_JWT_SECRET). The token
 * is the ONLY thing the browser holds; Dhan credentials never leave the
 * server. A 401 from these helpers ALWAYS means "log in to Zap again" — Dhan
 * token problems are broker-status, never a 401 (§10 rule from zap-api).
 */

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

const SESSION_DAYS = 7;

function jwtSecret(): Uint8Array {
  const value = process.env.AUTH_JWT_SECRET;
  if (!value || value.length < 16) {
    throw new Error('AUTH_JWT_SECRET must be set to a random secret of at least 16 characters.');
  }
  // Hash to a fixed-length key so any-length secrets are fine.
  return new Uint8Array(createHash('sha256').update(value).digest());
}

export interface SessionUser {
  userId: string;
  email: string;
}

export async function signSessionJwt(user: SessionUser): Promise<string> {
  return new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(jwtSecret());
}

/** The authenticated user for a request, or a 401 HttpError. */
export async function requireUser(req: Request): Promise<SessionUser> {
  const header = req.headers.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) throw new HttpError(401, 'Sign in to continue.');
  try {
    const { payload } = await jwtVerify(token, jwtSecret());
    if (!payload.sub || typeof payload.email !== 'string') throw new Error('bad claims');
    return { userId: payload.sub, email: payload.email };
  } catch {
    throw new HttpError(401, 'Your session has expired — sign in again.');
  }
}

/** Route-handler wrapper: map HttpError to a JSON response, 500 otherwise. */
export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    return Response.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status });
  }
  console.error('[api] unhandled error:', e instanceof Error ? e.message : e);
  return Response.json({ error: 'Something went wrong.' }, { status: 500 });
}
