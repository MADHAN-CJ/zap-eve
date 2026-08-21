import { timingSafeEqual } from "node:crypto";
import { eveChannel } from "eve/channels/eve";
import { type AuthFn, localDev, vercelOidc } from "eve/channels/auth";

/**
 * Production posture (plan Phase 5): browsers NEVER talk to eve directly —
 * every session call goes through the app's proxy (/api/eve/v1/*), which owns
 * credentials, thread ownership, and continuation tokens. The proxy
 * authenticates to eve with a shared secret (EVE_PROXY_SECRET, set in the
 * deployment env); direct browser requests carry no secret and are rejected.
 * `vercelOidc()` additionally admits the eve TUI / Vercel tooling, and
 * `localDev()` keeps localhost open for `eve dev` and bench scripts.
 */
function proxySecret(): AuthFn<Request> {
  return (request) => {
    const secret = process.env.EVE_PROXY_SECRET;
    const presented = request.headers.get("x-eve-proxy-secret");
    if (!secret || !presented) return null; // skip — next entry decides
    const a = Buffer.from(presented);
    const b = Buffer.from(secret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return {
      attributes: {},
      authenticator: "proxy-secret",
      principalId: "zap-eve-proxy",
      principalType: "service",
    };
  };
}

export default eveChannel({
  auth: [proxySecret(), vercelOidc(), localDev()],
});
