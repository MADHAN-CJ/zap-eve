import { errorResponse } from '@/lib/server/auth';
import { requestOtp } from '@/lib/server/otp';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { email?: string } | null;
    if (!body?.email) return Response.json({ error: 'Email is required.' }, { status: 400 });
    await requestOtp(body.email);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
