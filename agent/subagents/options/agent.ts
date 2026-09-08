import { defineAgent } from 'eve';
import { anthropic } from '@ai-sdk/anthropic';

/**
 * The options specialist subagent (docs/plan-options-subagent.md). The parent
 * delegates options questions here as the tool `options` {message}. Runs in
 * its own child session: tools resolve creds/position via the ROOT session
 * (ctx.session.parent.rootSessionId — agent/lib/dhan/context.ts), and its
 * follow-up questions (built-in ask_question) are proxied by eve to the root
 * stream so the user answers in the main chat. The parent must NOT set
 * outputSchema when delegating — task mode cannot reach a human.
 */
export default defineAgent({
  description:
    'Options specialist: option chains (any F&O underlying — all NSE/BSE indices and NSE stock options), expiries, IV, greeks, OI analytics (PCR, buildup, max pain), per-strike premium history, expired-contract behaviour, options strategy assessment, and options watches. Delegate any options-related question here with full context (the position, the user’s exact ask, relevant chart context). Do NOT set outputSchema — this specialist may need to ask the user a follow-up question.',
  model: anthropic('claude-sonnet-5'),
  // Direct LanguageModels carry no gateway catalog metadata, so eve's
  // compaction needs the context window stated explicitly (Sonnet 5: 1M).
  modelContextWindowTokens: 1_000_000,
});
