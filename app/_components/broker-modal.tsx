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

/**
 * Dhan connection (v1: pasted access token, 24h life). Connect validates the
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
              ? 'Your Dhan access token expired (they last 24 hours). Generate a fresh token on Dhan and paste it here.'
              : connected
                ? `Connected as ${status?.dhanClientId}. Paste a fresh token to renew, or disconnect.`
                : 'Generate an access token in Dhan (web → My profile → DhanHQ Trading APIs) and paste it here with your client ID. It stays on the server, encrypted — the AI never sees it.'}
          </DialogDescription>
        </DialogHeader>

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
