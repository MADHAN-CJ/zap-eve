import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, requireUser } from '@/lib/server/auth';
import { listWatches, listWatchesForThread, watchSummary } from '@/agent/lib/watch/service';

export const dynamic = 'force-dynamic';

const threadIdSchema = z.uuid();

/** All of the caller's watches, newest first; `?threadId=` narrows to one chat. */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const threadId = new URL(req.url).searchParams.get('threadId');
    if (threadId !== null && !threadIdSchema.safeParse(threadId).success) {
      return NextResponse.json({ error: 'Invalid threadId.' }, { status: 400 });
    }
    const rows = threadId
      ? await listWatchesForThread(user.userId, threadId)
      : await listWatches(user.userId);
    return NextResponse.json({ watches: rows.map(watchSummary) });
  } catch (e) {
    return errorResponse(e);
  }
}
