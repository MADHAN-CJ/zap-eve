import { errorResponse, requireUser } from '@/lib/server/auth';
import {
  brokerStatusFor,
  connectBroker,
  disconnectBroker,
} from '@/agent/lib/db/broker';
import { dhan, DhanError } from '@/agent/lib/dhan/client';

export const dynamic = 'force-dynamic';

/**
 * Dhan connection management. Connect validates the pasted access token with a
 * real (cheapest) Dhan read BEFORE storing it, so a typo is caught here — not
 * on the user's first chat. Credentials are encrypted at rest and never leave
 * the server.
 */

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    return Response.json(await brokerStatusFor(user.userId));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => null)) as
      | { dhanClientId?: string; accessToken?: string }
      | null;
    const dhanClientId = body?.dhanClientId?.trim();
    const accessToken = body?.accessToken?.trim();
    if (!dhanClientId || !accessToken) {
      return Response.json({ error: 'Dhan client ID and access token are required.' }, { status: 400 });
    }

    // Live validation round-trip before storing anything.
    try {
      await dhan.getFundLimit({ dhanClientId, accessToken });
    } catch (e) {
      if (e instanceof DhanError && (e.status === 401 || e.status === 403)) {
        return Response.json(
          { error: 'Dhan rejected this token — check the client ID and generate a fresh access token.' },
          { status: 400 },
        );
      }
      throw e;
    }

    await connectBroker(user.userId, dhanClientId, { type: 'access_token', accessToken });
    return Response.json(await brokerStatusFor(user.userId));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await requireUser(req);
    await disconnectBroker(user.userId);
    return Response.json(await brokerStatusFor(user.userId));
  } catch (e) {
    return errorResponse(e);
  }
}
