import type { WatchCondition } from './types';

/**
 * The [Watch triggered] message a fired watch posts into its thread. The
 * prefix is shared with the UI, which renders such user-role messages as a
 * compact ⚡ chip instead of a user bubble.
 */
export const WATCH_TRIGGER_PREFIX = '[Watch triggered]';

export const isWatchTriggerMessage = (text: string): boolean => text.startsWith(WATCH_TRIGGER_PREFIX);

export const describeCondition = (c: WatchCondition): string =>
  `${c.metric} ${c.comparator.replace(/_/g, ' ')} ${c.target}`;

export interface TriggerMessageInput {
  symbol: string;
  interval: string;
  instruction: string;
  reason: 'levels' | 'ai_check';
  conditions: WatchCondition[];
  firedConditions: number[];
  values: Partial<Record<string, number | null>>;
}

export function buildTriggerMessage(input: TriggerMessageInput): string {
  const lines: string[] = [
    `${WATCH_TRIGGER_PREFIX} Automated market watch on ${input.symbol} (${input.interval} candles).`,
    `Original request from the user: "${input.instruction}"`,
  ];
  if (input.reason === 'levels') {
    const tripped = input.firedConditions.map((i) => input.conditions[i]).filter(Boolean).map(describeCondition);
    lines.push(`Tripped condition${tripped.length === 1 ? '' : 's'}: ${tripped.join('; ') || '(unknown)'}.`);
    const vals = Object.entries(input.values)
      .filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => `${k}=${(v as number).toFixed(2)}`);
    if (vals.length) lines.push(`Values at the sweep: ${vals.join(', ')}.`);
  } else {
    lines.push('This is a scheduled AI check — no numeric level was armed for this request.');
  }
  lines.push(
    'Re-fetch the live data now and judge the ORIGINAL request honestly (false breaks exist). ' +
      'Answer the user in plain language, then fill the structured verdict — it alone decides whether an email alert is sent.',
  );
  return lines.join('\n');
}
