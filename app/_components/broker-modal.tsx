'use client';

import { useState } from 'react';
import { Loader2Icon, UnplugIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { connectBroker, disconnectBroker, type BrokerStatus } from '@/lib/client/broker';

const IST = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const ist = (iso?: string | null) => (iso ? `${IST.format(new Date(iso))} IST` : null);

/**
 * Dhan connection: a pasted access token that the server then RENEWS by itself
 * every 12 h through Dhan's RenewToken (docs/plan-token-renewal.md), so the
 * user pastes once. Connect validates the
 * token with a real Dhan round-trip server-side before it's stored — a typo
 * never becomes a "connected" state. The token is encrypted at rest and never
 * returns to the browser.
 */
export function BrokerModal({
  open,
  dismissable,
  status,
  onOpenChange,
  onChanged,
}: {
  readonly open: boolean;
  /** False on the connect gate — connecting is the only way forward. */
  readonly dismissable: boolean;
  readonly status: BrokerStatus | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onChanged: (status: BrokerStatus) => void;
}) {
  const [clientId, setClientId] = useState(status?.dhanClientId ?? '');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connected = status?.status === 'active';
  const expired = status?.status === 'token_expired';

  const connect = async () => {
    setError(null);
    const id = clientId.trim();
    const tok = token.trim();
    if (!id || !tok) {
      setError('Enter your Dhan client ID and a fresh access token.');
      return;
    }
    setBusy(true);
    const res = await connectBroker(id, tok);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setToken('');
    onChanged(res.status);
    onOpenChange(false);
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await disconnectBroker();
      onChanged(next);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not disconnect.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onOpenChange={(next) => (dismissable || next ? onOpenChange(next) : undefined)} open={open}>
      <DialogContent onInteractOutside={(e) => (dismissable ? undefined : e.preventDefault())} showCloseButton={dismissable}>
        <DialogHeader>
          <DialogTitle>{expired ? 'Reconnect Dhan' : connected ? 'Dhan connection' : 'Connect Dhan'}</DialogTitle>
          <DialogDescription>
            {expired
              ? status?.lastRenewError
                ? `Automatic renewal stopped: ${status.lastRenewError} Generate a fresh token on Dhan and paste it here — renewal resumes by itself.`
                : 'Your Dhan access token expired. Generate a fresh token on Dhan and paste it here — from then on it renews itself.'
              : connected
                ? `Connected as ${status?.dhanClientId}. The token renews itself daily; paste a fresh one only if Dhan asks you to, or disconnect.`
                : 'Generate an access token in Dhan (web → My profile → DhanHQ Trading APIs) and paste it here with your client ID. It stays on the server, encrypted, and renews itself every day — the AI never sees it.'}
          </DialogDescription>
        </DialogHeader>

        {connected ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
            <dt className="text-muted-foreground">Renews automatically</dt>
            <dd>{ist(status?.renewAfter) ?? 'on the next check'}</dd>
            <dt className="text-muted-foreground">Current token expires</dt>
            <dd>{ist(status?.tokenExpiresAt) ?? '—'}</dd>
            <dt className="text-muted-foreground">Last renewed</dt>
            <dd>{ist(status?.lastRenewedAt) ?? 'not yet (pasted token)'}</dd>
            {status?.renewFailures ? (
              <>
                <dt className="text-muted-foreground">Last attempt</dt>
                <dd className="text-destructive">{status.lastRenewError ?? 'failed'} (retrying)</dd>
              </>
            ) : null}
          </dl>
        ) : null}

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="font-medium text-sm" htmlFor="dhan-client-id">
              Dhan client ID
            </label>
            <Input
              autoFocus={!connected}
              disabled={connected}
              id="dhan-client-id"
              onChange={(e) => setClientId(e.target.value)}
              placeholder="e.g. 1112384913"
              value={clientId}
            />
          </div>
          <div className="space-y-1.5">
            <label className="font-medium text-sm" htmlFor="dhan-access-token">
              Access token
            </label>
            <Input
              id="dhan-access-token"
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void connect()}
              placeholder="eyJ…"
              type="password"
              value={token}
            />
          </div>

          {error ? <p className="text-destructive text-sm">{error}</p> : null}

          <div className="flex items-center gap-2">
            {connected || expired ? (
              <Button
                className="mr-auto text-destructive hover:text-destructive"
                disabled={busy}
                onClick={() => void disconnect()}
                type="button"
                variant="ghost"
              >
                <UnplugIcon className="size-4" /> Disconnect
              </Button>
            ) : null}
            <div className="ml-auto flex gap-2">
              {dismissable ? (
                <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
                  Cancel
                </Button>
              ) : null}
              <Button disabled={busy} onClick={() => void connect()} type="button">
                {busy ? (
                  <>
                    <Loader2Icon className="size-4 animate-spin" /> Validating…
                  </>
                ) : expired || connected ? (
                  'Save token'
                ) : (
                  'Connect'
                )}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
