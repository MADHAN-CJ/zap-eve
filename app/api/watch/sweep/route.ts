import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { sweepWatches } from '@/lib/server/watch-sweep';
import { fireWatch } from '@/lib/server/watch-fire';

export const dynamic = 'force-dynamic';
/** Fires can hold the request open (eve turn per fire) — allow a few minutes. */
export const maxDuration = 300;

/**
 * Sweep tick, hit by the external ticker (cron+curl on the operator's box):
 *   curl -X POST -H "x-watch-sweep-secret: $SECRET" https://…/api/watch/sweep
 * Self-gates on NSE market hours — the ticker may fire around the clock.
 */
export async function POST(req: Request) {
  const secret = process.env.WATCH_SWEEP_SECRET;
  if (!secret) return NextResponse.json({ error: 'Sweeper not configured.' }, { status: 503 });
  const given = req.headers.get('x-watch-sweep-secret') ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  const report = await sweepWatches({ fire: fireWatch });
  return NextResponse.json(report);
}
