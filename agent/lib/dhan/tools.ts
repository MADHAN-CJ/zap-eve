import { defineTool } from 'eve/tools';
import { dhan } from './client';
import { allSpecs } from './specs';
import { toolContext, noteDhanAuthFailure, type DhanToolContext, type EveToolCtx } from './context';
import { isDataApiSubscriptionError, isDhanAuthError, toErr, type ToolSpec } from './shared';

/**
 * Builds one eve tool per read-only spec. No approval gating anywhere — every
 * tool is a read and this product has no write path. Execute never throws:
 * errors come back as { error } envelopes; a Dhan auth failure additionally
 * marks the user's connection token_expired (drives the UI reconnect banner).
 */
const byName = new Map(allSpecs.map((s) => [s.name, s]));

export function dhanToolFor(name: string) {
  const spec = byName.get(name);
  if (!spec) throw new Error(`Unknown Dhan tool spec: ${name}`);
  return buildTool(spec);
}

function buildTool(spec: ToolSpec) {
  return defineTool({
    description: spec.description,
    inputSchema: spec.inputSchema,
    execute: async (input: unknown, toolCtx?: EveToolCtx) => {
      const parsed = spec.inputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        return {
          error: `Invalid params for ${spec.name}: ${parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ')}`,
        };
      }
      const resolved = await toolContext(toolCtx);
      if (resolved.status === 'unavailable') return { error: resolved.message };
      try {
        return await spec.run(parsed.data as Record<string, unknown>, resolved.ctx);
      } catch (e) {
        // A 401/403 only means a dead token if a cheap trading read ALSO
        // fails — Data-API 401s (e.g. error 806) happen on live tokens.
        if (isDhanAuthError(e) && !isDataApiSubscriptionError(e)) {
          if (await tokenStillAlive(resolved.ctx)) {
            return {
              error: `Dhan rejected this specific call, but the access token is still valid (verified with a funds probe) — the failure is endpoint-specific, not a login problem. Dhan said: ${e instanceof Error ? e.message : String(e)}`,
            };
          }
          await noteDhanAuthFailure(resolved.ctx);
        }
        return toErr(e);
      }
    },
  });
}

async function tokenStillAlive(ctx: DhanToolContext): Promise<boolean> {
  try {
    await dhan.getFundLimit(ctx.creds);
    return true;
  } catch {
    return false;
  }
}
