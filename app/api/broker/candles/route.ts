import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, requireUser } from '@/lib/server/auth';
import { getActiveBrokerCreds, markTokenExpired } from '@/agent/lib/db/broker';
import { DhanError } from '@/agent/lib/dhan/client';
import { isDataApiSubscriptionError } from '@/agent/lib/dhan/shared';
import { DEFAULT_DAYS, fetchDhanCandles } from '@/lib/server/candles';

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

    try {
      const candles = await fetchDhanCandles(
        creds.creds,
        { securityId, exchangeSegment, productType, symbol },
        interval,
        daysBack,
      );
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
