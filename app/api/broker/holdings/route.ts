import { errorResponse, requireUser } from '@/lib/server/auth';
import { getActiveBrokerCreds, markTokenExpired } from '@/agent/lib/db/broker';
import { dhan, DhanError } from '@/agent/lib/dhan/client';

export const dynamic = 'force-dynamic';

/**
 * Demat holdings for the UI list (delivery equity — Dhan keeps these separate
 * from /positions, which only carries today's trading positions). Same §10
 * rule as positions: Dhan auth failure → 409 BROKER_TOKEN_EXPIRED, never 401.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const creds = await getActiveBrokerCreds(user.userId);
    if (creds.status === 'error') {
      return Response.json({ error: 'Broker credential lookup failed — try again.' }, { status: 500 });
    }
    if (creds.status === 'none') {
      const code = creds.reason === 'token_expired' ? 'BROKER_TOKEN_EXPIRED' : 'BROKER_NOT_CONNECTED';
      return Response.json({ error: 'Dhan is not connected.', code }, { status: 409 });
    }
    try {
      const holdings = await dhan.getHoldings(creds.creds);
      return Response.json({ holdings });
    } catch (e) {
      if (e instanceof DhanError && (e.status === 401 || e.status === 403)) {
        await markTokenExpired(user.userId);
        return Response.json(
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
