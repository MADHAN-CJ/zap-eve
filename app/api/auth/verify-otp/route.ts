import { errorResponse, signSessionJwt } from '@/lib/server/auth';
import { verifyOtp } from '@/lib/server/otp';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { email?: string; code?: string } | null;
    if (!body?.email || !body?.code) {
      return Response.json({ error: 'Email and code are required.' }, { status: 400 });
    }
    const user = await verifyOtp(body.email, body.code);
    const token = await signSessionJwt(user);
    return Response.json({ token, user: { id: user.userId, email: user.email } });
  } catch (e) {
    return errorResponse(e);
  }
}
