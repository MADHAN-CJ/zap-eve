// User drawings on the chart (plan P4): trend + horizontal lines, persisted in
// localStorage per position+interval (D5). Anchors are (time, price) pairs with
// REAL epoch seconds (same as the candle data; the IST display shift happens at
// render time), so they survive pan/zoom, reloads, and live updates.

export interface DrawingPoint {
  time: number; // epoch seconds, snapped to a candle
  price: number;
}

export type Drawing =
  | { id: string; kind: 'trend'; a: DrawingPoint; b: DrawingPoint }
  | { id: string; kind: 'horizontal'; price: number };

export type DrawingTool = 'trend' | 'horizontal';

const STORAGE_PREFIX = 'zap-eve.drawings.v1';

export function drawingsKey(
  position: { securityId: string; exchangeSegment: string },
  interval: string,
): string {
  return `${STORAGE_PREFIX}:${position.securityId}:${position.exchangeSegment}:${interval}`;
}

export function loadDrawings(key: string): Drawing[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((d): d is Drawing => {
      if (typeof d !== 'object' || d === null) return false;
      const v = d as Record<string, unknown>;
      if (typeof v.id !== 'string') return false;
      if (v.kind === 'horizontal') return Number.isFinite(v.price);
      if (v.kind === 'trend') {
        const ok = (p: unknown) =>
          typeof p === 'object' && p !== null &&
          Number.isFinite((p as DrawingPoint).time) && Number.isFinite((p as DrawingPoint).price);
        return ok(v.a) && ok(v.b);
      }
      return false;
    });
  } catch {
    return [];
  }
}

export function saveDrawings(key: string, drawings: Drawing[]): void {
  try {
    if (drawings.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(drawings));
  } catch {
    // storage unavailable — drawings stay session-only
  }
}

export function newDrawingId(): string {
  return `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
