import { NextResponse } from 'next/server';
import { errorResponse, requireUser } from '@/lib/server/auth';
import { listThreads, listThreadsByPosition } from '@/lib/server/threads';

export const dynamic = 'force-dynamic';

/**
 * GET /api/threads → the user's chat history (newest first).
 * GET /api/threads?securityId=&exchangeSegment=&productType= → that
 * position's threads (newest first) for the position hub.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const securityId = url.searchParams.get('securityId');
    const exchangeSegment = url.searchParams.get('exchangeSegment');
    const productType = url.searchParams.get('productType');
    if (securityId && exchangeSegment && productType) {
      const threads = await listThreadsByPosition(user.userId, { securityId, exchangeSegment, productType });
      return NextResponse.json({ threads });
    }
    return NextResponse.json({ threads: await listThreads(user.userId) });
  } catch (e) {
    return errorResponse(e);
  }
}
