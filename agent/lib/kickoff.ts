/**
 * The eve proxy prepends a `[Position chat] …` context block to the FIRST
 * user message of a session so the model knows which position the chat is
 * about. The model needs it; the user typed only their own text — strip it
 * for display and for thread titles. Stored messages keep the full text.
 */
const KICKOFF_PREFIX = /^\[Position chat\][^\n]*\n\n/;

export function stripKickoff(text: string): string {
  return text.replace(KICKOFF_PREFIX, '');
}
