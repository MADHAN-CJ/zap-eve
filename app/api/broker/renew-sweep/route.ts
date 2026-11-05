import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { renewDueTokens } from '@/lib/server/token-renew';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Token-renewal tick (docs/plan-token-renewal.md), hit by the external ticker
 * on the operator's box every few minutes:
 *   curl -X POST -H "x-broker-renew-secret: $SECRET" https://…/api/broker/renew-sweep
 * Idempotent: rows are claimed atomically, so overlapping ticks are harmless.
 */
export async function POST(req: Request) {
  const secret = process.env.BROKER_RENEW_SECRET;
  if (!secret) return NextResponse.json({ error: 'Renewal sweep not configured.' }, { status: 503 });
  const given = req.headers.get('x-broker-renew-secret') ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  return NextResponse.json(await renewDueTokens());
}
