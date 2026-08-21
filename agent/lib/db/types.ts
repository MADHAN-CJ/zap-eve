/**
 * Wire shapes shared by the persistence layer, the thread REST API, and the UI.
 * `MessagePart` deliberately mirrors the old frontend's persisted tool-activity
 * shape (plan §3) so the UI's block model folds history and live streams the
 * same way.
 */

export type Role = 'user' | 'assistant';

export type MessagePart =
  | { type: 'tool_call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; toolName: string; output: unknown }
  | { type: 'tool_error'; toolCallId: string; toolName: string; error: string };

/** Token accounting for one assistant turn (summed across its model steps). */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Money cost for one assistant turn, computed server-side (never on the client). */
export interface Cost {
  currency: string;
  model: string;
  total: number;
  breakdown: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}
