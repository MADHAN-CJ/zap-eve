import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, requireUser } from '@/lib/server/auth';
import { cancelWatch, pauseWatch, resumeWatch, watchSummary } from '@/agent/lib/watch/service';

export const dynamic = 'force-dynamic';

const idSchema = z.uuid();
const bodySchema = z.object({ action: z.enum(['pause', 'resume', 'cancel']) });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const id = idSchema.parse((await params).id);
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Expected { action: pause | resume | cancel }.' }, { status: 400 });
    }
    const run = { pause: pauseWatch, resume: resumeWatch, cancel: cancelWatch }[parsed.data.action];
    const result = await run(user.userId, id);
    if (result.status === 'error') return NextResponse.json({ error: result.message }, { status: 409 });
    return NextResponse.json({ watch: watchSummary(result.watch) });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: 'Watch not found.' }, { status: 404 });
    return errorResponse(e);
  }
}
