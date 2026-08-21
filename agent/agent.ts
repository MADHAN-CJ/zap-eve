import { defineAgent } from 'eve';
import { anthropic } from '@ai-sdk/anthropic';

export default defineAgent({
  // Direct provider (uses ANTHROPIC_API_KEY; no AI Gateway credential needed).
  // 11 eager read-only tools — small enough that toolsearch/deferLoading
  // would cost more than it saves.
  model: anthropic('claude-sonnet-5'),
  // Direct LanguageModels carry no gateway catalog metadata, so eve's
  // compaction needs the context window stated explicitly (Sonnet 5: 1M).
  modelContextWindowTokens: 1_000_000,
});
