import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, requireUser } from '@/lib/server/auth';
import { getActiveBrokerCreds, markTokenExpired } from '@/agent/lib/db/broker';
import { dhan, DhanError } from '@/agent/lib/dhan/client';
import { isDataApiSubscriptionError } from '@/agent/lib/dhan/shared';
import { chartInstrument } from '@/agent/lib/dhan/underlying';

export const dynamic = 'force-dynamic';

// 409 codes the client handles: BROKER_NOT_CONNECTED / BROKER_TOKEN_EXPIRED
// (connect modal), DATA_API_NOT_SUBSCRIBED (chart empty-state; Dhan error 806).

const query = z.object({
  securityId: z.string().min(1),
  exchangeSegment: z.string().min(1),
  productType: z.string().min(1),
  symbol: z.string().min(1),
  interval: z.enum(['1min', '5min', '15min', '1h', '1day']),
  daysBack: z.coerce.number().int().min(1).max(365).optional(),
});

const INTRADAY_MINUTES = { '1min': 1, '5min': 5, '15min': 15, '1h': 60 } as const;
// deep enough that a 200-period EMA CONVERGES (not merely warms up) — EMA
// seeding error decays by (1−2/201)^bars, so ~1300+ bars ≈ fully converged
// (NSE ≈ 26×15m / 78×5m / 6.5×1h bars per trading day; Dhan caps intraday at 90d/call)
const DEFAULT_DAYS = { '1min': 4, '5min': 30, '15min': 60, '1h': 90, '1day': 2000 } as const;

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const parsed = query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid chart request.' }, { status: 400 });
    const { securityId, exchangeSegment, productType, symbol, interval } = parsed.data;
    const daysBack = parsed.data.daysBack ?? DEFAULT_DAYS[interval];

    const creds = await getActiveBrokerCreds(user.userId);
    if (creds.status === 'error') {
      return NextResponse.json({ error: 'Broker credential lookup failed — try again.' }, { status: 500 });
    }
    if (creds.status === 'none') {
      const code = creds.reason === 'token_expired' ? 'BROKER_TOKEN_EXPIRED' : 'BROKER_NOT_CONNECTED';
      return NextResponse.json({ error: 'Dhan is not connected.', code }, { status: 409 });
    }

    const position = { securityId, exchangeSegment, productType, symbol };
    const instrument = chartInstrument(position, 'position');
    const from = new Date(Date.now() - daysBack * 24 * 3600 * 1000);
    const to = new Date(Date.now() + 24 * 3600 * 1000);
    const isFno = exchangeSegment.toUpperCase().endsWith('_FNO');

    try {
      const candles =
        interval === '1day'
          ? await dhan.getHistoricalChart(creds.creds, {
              securityId,
              exchangeSegment,
              instrument,
              fromDate: ymd(from),
              toDate: ymd(to),
              oi: isFno,
            })
          : await dhan.getIntradayChart(creds.creds, {
              securityId,
              exchangeSegment,
              instrument,
              interval: INTRADAY_MINUTES[interval],
              fromDate: ymd(from),
              toDate: ymd(to),
              oi: isFno,
            });
      return NextResponse.json({ candles });
    } catch (e) {
      if (e instanceof DhanError && isDataApiSubscriptionError(e)) {
        return NextResponse.json(
          { error: "This Dhan account has no Data-API subscription — charts need it (quotes on dhan.co).", code: 'DATA_API_NOT_SUBSCRIBED' },
          { status: 409 },
        );
      }
      if (e instanceof DhanError && (e.status === 401 || e.status === 403)) {
        await markTokenExpired(user.userId);
        return NextResponse.json(
          { error: 'Your Dhan token expired — reconnect Dhan.', code: 'BROKER_TOKEN_EXPIRED' },
          { status: 409 },
        );
      }
      throw e;
    }
  } catch (e) {
    return errorResponse(e);
  }
}
