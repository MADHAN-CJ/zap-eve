import { NextResponse } from 'next/server';
import { errorResponse, requireUser } from '@/lib/server/auth';
import { findThreadByPosition, listThreads } from '@/lib/server/threads';

export const dynamic = 'force-dynamic';

/**
 * GET /api/threads → the user's chat history (newest first).
 * GET /api/threads?securityId=&exchangeSegment=&productType= → the live
 * thread for that position (or {thread:null}) so the UI resumes instead of
 * forking a duplicate chat.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const securityId = url.searchParams.get('securityId');
    const exchangeSegment = url.searchParams.get('exchangeSegment');
    const productType = url.searchParams.get('productType');
    if (securityId && exchangeSegment && productType) {
      const thread = await findThreadByPosition(user.userId, { securityId, exchangeSegment, productType });
      return NextResponse.json({ thread });
    }
    return NextResponse.json({ threads: await listThreads(user.userId) });
  } catch (e) {
    return errorResponse(e);
  }
}
