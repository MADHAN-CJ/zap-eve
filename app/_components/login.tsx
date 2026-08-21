'use client';

import { useState } from 'react';
import { Loader2Icon, ZapIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { requestOtp, verifyOtp } from '@/lib/client/settings';

/**
 * Email → 6-digit OTP → session. Two steps on one card; the server logs the
 * code to its console when RESEND_API_KEY is unset (dev), and
 * test@zaptrade.app always accepts 123456.
 */
export function Login({ onLoggedIn }: { readonly onLoggedIn: () => void }) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      setError('Enter your email.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await requestOtp(trimmed);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setStep('code');
  };

  const submitCode = async () => {
    const trimmed = code.trim();
    if (trimmed.length !== 6) {
      setError('Enter the 6-digit code.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await verifyOtp(email.trim(), trimmed);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onLoggedIn();
  };

  return (
    <main className="flex h-dvh items-center justify-center bg-background text-foreground">
      <div className="flex w-full max-w-sm flex-col gap-6 px-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <ZapIcon className="size-5" />
          </span>
          <h1 className="font-medium text-3xl tracking-tighter">Zap</h1>
          <p className="text-muted-foreground text-sm">
            Chat with an analyst about your Dhan positions. Read-only — it can never trade.
          </p>
        </div>

        {step === 'email' ? (
          <div className="flex flex-col gap-3">
            <Input
              autoFocus
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void sendCode()}
              placeholder="you@example.com"
              type="email"
              value={email}
            />
            <Button disabled={busy} onClick={() => void sendCode()}>
              {busy ? <Loader2Icon className="size-4 animate-spin" /> : null} Send login code
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-center text-muted-foreground text-sm">
              Enter the 6-digit code sent to <span className="font-medium text-foreground">{email.trim()}</span>
            </p>
            <Input
              autoFocus
              inputMode="numeric"
              maxLength={6}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && void submitCode()}
              placeholder="••••••"
              className="text-center tracking-[0.4em]"
              value={code}
            />
            <Button disabled={busy} onClick={() => void submitCode()}>
              {busy ? <Loader2Icon className="size-4 animate-spin" /> : null} Sign in
            </Button>
            <Button onClick={() => { setStep('email'); setCode(''); setError(null); }} size="sm" variant="ghost">
              Use a different email
            </Button>
          </div>
        )}

        {error ? <p className="text-center text-destructive text-sm">{error}</p> : null}
      </div>
    </main>
  );
}
