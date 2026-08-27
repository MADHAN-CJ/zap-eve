import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, requireUser } from '@/lib/server/auth';
import { deleteThread, getThread, renameThread } from '@/lib/server/threads';

export const dynamic = 'force-dynamic';

const idSchema = z.uuid();

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  try {
    const user = await requireUser(req);
    const id = idSchema.parse((await params).id);
    return NextResponse.json(await getThread(user.userId, id));
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
    return errorResponse(e);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const user = await requireUser(req);
    const id = idSchema.parse((await params).id);
    const body = (await req.json().catch(() => null)) as { title?: string } | null;
    if (typeof body?.title !== 'string') return NextResponse.json({ error: 'A title is required.' }, { status: 400 });
    return NextResponse.json(await renameThread(user.userId, id, body.title));
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
    return errorResponse(e);
  }
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    const user = await requireUser(req);
    const id = idSchema.parse((await params).id);
    await deleteThread(user.userId, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
    return errorResponse(e);
  }
}
