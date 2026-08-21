/**
 * The eve proxy prepends a `[Position chat] …` context block to the FIRST
 * user message of a session so the model knows which position the chat is
 * about (see app/api/eve/v1/[...path]/route.ts). The model needs it; the
 * user typed only their own text — strip the block for display. Stored
 * messages keep the full text (faithful to what the model saw).
 */
const KICKOFF_PREFIX = /^\[Position chat\][^\n]*\n\n/;

export function stripKickoff(text: string): string {
  return text.replace(KICKOFF_PREFIX, '');
}
