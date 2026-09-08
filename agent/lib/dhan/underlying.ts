import type { PositionIdentity } from '../db/session-context';
import { FNO_INDICES, FNO_STOCKS } from './fno-underlyings';

/**
 * Underlying resolution for F&O work. Ids come from the generated
 * fno-underlyings.ts (scripts/gen-fno-underlyings.ts, Dhan scrip master):
 * all 8 option-chain indices on IDX_I plus every NSE F&O stock underlying on
 * NSE_EQ. Unknown names still return a clear error instead of a guessed id.
 */

/** Trading-symbol spellings that differ from the index row's ticker. */
const INDEX_ALIASES: Record<string, string> = {
  SENSEX50: 'SNSX50', // BSE option symbols say SENSEX50; the index row is SNSX50
  'NIFTY 50': 'NIFTY',
  NIFTY50: 'NIFTY',
  'NIFTY BANK': 'BANKNIFTY',
  'NIFTY NEXT 50': 'NIFTYNXT50',
};

const canonicalIndexName = (name: string) => INDEX_ALIASES[name] ?? name;

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
  // First token, but hyphenated tickers (BAJAJ-AUTO, M&M-FIN style) span two
  // tokens — prefer the longest leading join that names a known underlying.
  const tokens = sym.split(/[-\s]/);
  const twoToken = tokens.length > 1 ? `${tokens[0]}-${tokens[1]}` : null;
  const first =
    twoToken && (FNO_STOCKS[twoToken] !== undefined || FNO_INDICES[canonicalIndexName(twoToken)] !== undefined)
      ? twoToken
      : (tokens[0] ?? null);
  return {
    isDerivative: true,
    isOption,
    underlyingName: first,
    isIndexUnderlying: first !== null && FNO_INDICES[canonicalIndexName(first)] !== undefined,
  };
}

export interface Underlying {
  scrip: number;
  seg: string;
  name: string;
}

/** Look up any F&O underlying by name/ticker (index or NSE stock). */
export function resolveUnderlyingBySymbol(
  raw: string,
): { ok: true; underlying: Underlying } | { ok: false; error: string } {
  const name = raw.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!name) return { ok: false, error: 'Empty underlying symbol.' };
  const idx = canonicalIndexName(name);
  if (FNO_INDICES[idx] !== undefined) {
    return { ok: true, underlying: { scrip: FNO_INDICES[idx], seg: 'IDX_I', name: idx } };
  }
  if (FNO_STOCKS[name] !== undefined) {
    return { ok: true, underlying: { scrip: FNO_STOCKS[name], seg: 'NSE_EQ', name } };
  }
  return {
    ok: false,
    error: `"${raw}" is not a known F&O underlying (checked ${Object.keys(FNO_INDICES).length} indices and ${Object.keys(FNO_STOCKS).length} NSE F&O stocks). Use the exchange ticker, e.g. NIFTY, BANKNIFTY, RELIANCE, BAJAJ-AUTO.`,
  };
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
  const res = resolveUnderlyingBySymbol(info.underlyingName);
  if (res.ok) return res;
  return {
    ok: false,
    error: `Underlying "${info.underlyingName}" (from trading symbol "${position.symbol}") is not in the F&O underlying master. Say so plainly rather than guessing.`,
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
