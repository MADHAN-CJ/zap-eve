import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, requireUser } from '@/lib/server/auth';
import { getActiveBrokerCreds, markTokenExpired } from '@/agent/lib/db/broker';
import { dhan, DhanError } from '@/agent/lib/dhan/client';
import { isDataApiSubscriptionError } from '@/agent/lib/dhan/shared';

export const dynamic = 'force-dynamic';

// Live quote for the chart's polling loop. Same 409 codes as the candles route:
// BROKER_NOT_CONNECTED / BROKER_TOKEN_EXPIRED / DATA_API_NOT_SUBSCRIBED.

const query = z.object({
  securityId: z.string().min(1),
  exchangeSegment: z.string().min(1),
});

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const parsed = query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid quote request.' }, { status: 400 });
    const { securityId, exchangeSegment } = parsed.data;

    const creds = await getActiveBrokerCreds(user.userId);
    if (creds.status === 'error') {
      return NextResponse.json({ error: 'Broker credential lookup failed — try again.' }, { status: 500 });
    }
    if (creds.status === 'none') {
      const code = creds.reason === 'token_expired' ? 'BROKER_TOKEN_EXPIRED' : 'BROKER_NOT_CONNECTED';
      return NextResponse.json({ error: 'Dhan is not connected.', code }, { status: 409 });
    }

    try {
      const book = await dhan.getQuote(creds.creds, { [exchangeSegment]: [Number(securityId)] });
      const quote = book[exchangeSegment]?.[securityId] ?? null;
      if (!quote) return NextResponse.json({ error: 'No quote for this instrument.' }, { status: 404 });
      return NextResponse.json({ quote });
    } catch (e) {
      if (e instanceof DhanError && isDataApiSubscriptionError(e)) {
        return NextResponse.json(
          { error: 'This Dhan account has no Data-API subscription.', code: 'DATA_API_NOT_SUBSCRIBED' },
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
