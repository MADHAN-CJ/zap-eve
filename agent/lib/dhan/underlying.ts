import type { PositionIdentity } from '../db/session-context';

/**
 * Underlying resolution for F&O positions. Only NIFTY=13 and BANKNIFTY=25
 * (IDX_I) are verified ids — other indices are deliberately unmapped, and
 * stock-derivative resolution needs the Dhan instrument master (not ingested
 * in v1): both return a clear error instead of a guessed id.
 */

const INDEX_MAP: Record<string, { scrip: number; seg: 'IDX_I' }> = {
  NIFTY: { scrip: 13, seg: 'IDX_I' },
  BANKNIFTY: { scrip: 25, seg: 'IDX_I' },
};

const KNOWN_INDEX_NAMES = new Set([
  'NIFTY',
  'BANKNIFTY',
  'FINNIFTY',
  'MIDCPNIFTY',
  'NIFTYNXT50',
  'SENSEX',
  'BANKEX',
]);

export interface DerivativeInfo {
  isDerivative: boolean;
  isOption: boolean;
  /** First token of the trading symbol, e.g. NIFTY, RELIANCE, BAJAJ-AUTO. */
  underlyingName: string | null;
  isIndexUnderlying: boolean;
}

/** Parse a Dhan F&O trading symbol (live format observed: `NIFTY-Aug2026-24700-CE`). */
export function parseDerivative(position: PositionIdentity): DerivativeInfo {
  const seg = position.exchangeSegment.toUpperCase();
  const isDerivative = seg.endsWith('_FNO');
  if (!isDerivative) {
    return { isDerivative: false, isOption: false, underlyingName: null, isIndexUnderlying: false };
  }
  const sym = position.symbol.toUpperCase();
  const isOption = /(?:^|[-\s])(CE|PE|CALL|PUT)(?:$|[-\s])/.test(sym);
  const first = sym.split(/[-\s]/)[0] ?? null;
  return {
    isDerivative: true,
    isOption,
    underlyingName: first,
    isIndexUnderlying: first !== null && KNOWN_INDEX_NAMES.has(first),
  };
}

export interface Underlying {
  scrip: number;
  seg: string;
  name: string;
}

/** The Dhan option-chain underlying for a position, or a typed error message. */
export function resolveUnderlying(
  position: PositionIdentity,
): { ok: true; underlying: Underlying } | { ok: false; error: string } {
  const info = parseDerivative(position);
  if (!info.isDerivative) {
    return {
      ok: false,
      error: `This position (${position.symbol}) is not a derivative — there is no option chain or expiry list for it.`,
    };
  }
  if (!info.underlyingName) {
    return { ok: false, error: `Could not parse the underlying from trading symbol "${position.symbol}".` };
  }
  const mapped = INDEX_MAP[info.underlyingName];
  if (mapped) return { ok: true, underlying: { scrip: mapped.scrip, seg: mapped.seg, name: info.underlyingName } };
  if (info.isIndexUnderlying) {
    return {
      ok: false,
      error: `Underlying index ${info.underlyingName} is not mapped yet (only NIFTY and BANKNIFTY are verified). Say so plainly rather than guessing.`,
    };
  }
  return {
    ok: false,
    error: `Stock-derivative underlying resolution (${info.underlyingName}) is not supported yet in this version — only NIFTY/BANKNIFTY option chains are available.`,
  };
}

/**
 * Dhan chart APIs need an `instrument` enum. Derived from the position (the
 * equity master has no F&O rows, so this mirrors zap-api's derivation).
 */
export function chartInstrument(position: PositionIdentity, target: 'position' | 'underlying'): string {
  if (target === 'underlying') {
    const info = parseDerivative(position);
    return info.isIndexUnderlying ? 'INDEX' : 'EQUITY';
  }
  const seg = position.exchangeSegment.toUpperCase();
  if (seg.endsWith('_EQ')) return 'EQUITY';
  if (seg === 'IDX_I') return 'INDEX';
  const info = parseDerivative(position);
  if (info.isOption) return info.isIndexUnderlying ? 'OPTIDX' : 'OPTSTK';
  return info.isIndexUnderlying ? 'FUTIDX' : 'FUTSTK';
}
