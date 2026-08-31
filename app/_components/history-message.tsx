'use client';

import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { stripKickoff } from '@/lib/kickoff';
import { extractSelectionChip } from '@/lib/chart-selection';
import { ToolResultChart } from '@/components/charts/tool-result-chart';
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { formatStoredUsageLine } from '@/lib/usage';
import type { ApiMessage } from '@/lib/client/threads-api';
import type { MessagePart } from '@/agent/lib/db/types';

/**
 * Renders one PERSISTED message (loaded from /api/threads/:id) with the same
 * visual components the live stream uses, so history and live turns are
 * indistinguishable. Persisted order matches the old frontend: tool activity
 * first (each call paired with its result — the API already stitched
 * cross-turn results), final text after, usage/cost line last.
 */

interface PairedTool {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  errorText?: string;
}

function pairToolParts(parts: MessagePart[]): PairedTool[] {
  const byId = new Map<string, PairedTool>();
  const ordered: PairedTool[] = [];
  for (const part of parts) {
    if (part.type === 'tool_call') {
      const tool: PairedTool = {
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      };
      byId.set(part.toolCallId, tool);
      ordered.push(tool);
      continue;
    }
    const call = byId.get(part.toolCallId);
    if (!call) continue; // orphan result (its call rendered in an earlier message)
    if (part.type === 'tool_result') call.output = part.output;
    else call.errorText = part.error;
  }
  return ordered;
}

export function HistoryMessage({ message }: { readonly message: ApiMessage }) {
  if (message.role === 'user') {
    const { text, chip } = extractSelectionChip(stripKickoff(message.content));
    return (
      <Message from="user">
        <MessageContent>
          {chip ? (
            <span className="flex items-center gap-1.5 text-xs opacity-80">
              ⌁ Chart selection · {chip.count} candles · {chip.from} → {chip.to}
            </span>
          ) : null}
          <MessageResponse>{text}</MessageResponse>
        </MessageContent>
      </Message>
    );
  }

  const tools = pairToolParts(message.parts);
  const usageLine = formatStoredUsageLine(message.usage, message.cost);
  if (tools.length === 0 && !message.content && !usageLine) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <Message from="assistant">
        <MessageContent>
          {tools.map((tool) => (
            <div className="flex flex-col gap-2" key={tool.toolCallId}>
              <Tool>
                <ToolHeader
                  state={tool.errorText ? 'output-error' : tool.output !== undefined ? 'output-available' : 'input-available'}
                  title={tool.toolName}
                  toolName={tool.toolName}
                  type="dynamic-tool"
                />
                <ToolContent>
                  <ToolInput input={tool.input} />
                  <ToolOutput errorText={tool.errorText} output={tool.output} />
                </ToolContent>
              </Tool>
              {tool.output !== undefined && !tool.errorText ? (
                <ToolResultChart output={tool.output} toolName={tool.toolName} />
              ) : null}
            </div>
          ))}
          {message.content ? <MessageResponse>{message.content}</MessageResponse> : null}
        </MessageContent>
      </Message>
      {usageLine ? <p className="text-muted-foreground/70 text-xs">{usageLine}</p> : null}
    </div>
  );
}
