import { errorResponse, requireUser } from '@/lib/server/auth';
import { getActiveBrokerCreds, markTokenExpired } from '@/agent/lib/db/broker';
import { dhan, DhanError } from '@/agent/lib/dhan/client';

export const dynamic = 'force-dynamic';

/**
 * Positions for the UI list. A Dhan-side auth failure maps to 409
 * BROKER_TOKEN_EXPIRED (and flags the row) — NEVER a 401, which would log the
 * user out of Zap (§10 rule inherited from zap-api).
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
      const positions = await dhan.getPositions(creds.creds);
      return Response.json({ positions });
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
