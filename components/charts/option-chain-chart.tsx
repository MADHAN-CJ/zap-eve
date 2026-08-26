'use client';

import { useEffect, useRef, useState } from 'react';
import { CHART, compact, inr } from './chart-theme';

export interface ChainSide {
  ltp?: number;
  iv?: number;
  oi?: number;
  oiPrev?: number;
  volume?: number;
  delta?: number;
}

export interface ChainStrike {
  strike: number;
  ce?: ChainSide;
  pe?: ChainSide;
}

const PAD = { top: 12, right: 12, bottom: 24, left: 44 };
const PANEL_H = 150;
const GAP = 28;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** Bar with 4px-rounded top corners, anchored to the baseline. */
function topRoundedBar(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

function ticks(max: number, n = 3): number[] {
  if (max <= 0) return [0];
  const raw = max / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

export function OptionChainChart({
  strikes,
  underlyingLastPrice,
  expiry,
}: {
  readonly strikes: ChainStrike[];
  readonly underlyingLastPrice: number;
  readonly expiry?: string;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const rows = strikes.filter((s) => Number.isFinite(s.strike)).sort((a, b) => a.strike - b.strike);
  if (rows.length < 2) return null;

  const plotW = width - PAD.left - PAD.right;
  const slot = plotW / rows.length;
  const barW = Math.max(2, Math.min(14, (slot - 6) / 2)); // two bars + 2px gap + margins
  const xCenter = (i: number) => PAD.left + slot * i + slot / 2;

  // Spot marker: interpolate between neighbouring strikes.
  let spotX: number | null = null;
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i].strike;
    const b = rows[i + 1].strike;
    if (underlyingLastPrice >= a && underlyingLastPrice <= b) {
      spotX = xCenter(i) + ((underlyingLastPrice - a) / (b - a)) * slot;
      break;
    }
  }

  // Panel A: open interest.
  const oiMax = Math.max(...rows.flatMap((r) => [r.ce?.oi ?? 0, r.pe?.oi ?? 0]), 1);
  const oiTicks = ticks(oiMax);
  const oiTop = oiTicks[oiTicks.length - 1] || oiMax;
  const oiY = (v: number) => PAD.top + PANEL_H - (v / oiTop) * PANEL_H;

  // Panel B: implied volatility.
  const ivVals = rows.flatMap((r) => [r.ce?.iv, r.pe?.iv]).filter((v): v is number => Number.isFinite(v));
  const ivMax = Math.max(...ivVals, 1);
  const ivTicks = ticks(ivMax);
  const ivTop = ivTicks[ivTicks.length - 1] || ivMax;
  const panelBTop = PAD.top + PANEL_H + GAP + 14;
  const ivY = (v: number) => panelBTop + PANEL_H - (v / ivTop) * PANEL_H;
  const linePath = (side: 'ce' | 'pe') =>
    rows
      .map((r, i) => {
        const v = r[side]?.iv;
        return Number.isFinite(v) ? `${i === 0 || !Number.isFinite(rows[i - 1][side]?.iv) ? 'M' : 'L'}${xCenter(i)},${ivY(v as number)}` : '';
      })
      .join(' ');

  const height = panelBTop + PANEL_H + PAD.bottom;
  const labelEvery = Math.max(1, Math.ceil(rows.length / Math.floor(plotW / 56)));
  const hovered = hoverIdx !== null ? rows[hoverIdx] : null;

  return (
    <figure className="rounded-lg border bg-card p-3">
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="font-medium text-sm">Option chain{expiry ? ` · expiry ${expiry}` : ''}</span>
        <span className="flex items-center gap-3 text-muted-foreground text-xs">
          <span className="flex items-center gap-1.5"><i className="inline-block size-2.5 rounded-sm" style={{ background: CHART.ce }} /> CE (calls)</span>
          <span className="flex items-center gap-1.5"><i className="inline-block size-2.5 rounded-sm" style={{ background: CHART.pe }} /> PE (puts)</span>
          <span>spot {inr(underlyingLastPrice)}</span>
        </span>
      </figcaption>

      <div className="relative" ref={ref}>
        <svg className="block" height={height} role="img" width={width} aria-label={`Open interest and implied volatility by strike, spot ${underlyingLastPrice}`}>
          {/* Panel A: OI */}
          <text fill={CHART.text} fontSize={11} x={PAD.left} y={PAD.top - 2}>Open interest</text>
          {oiTicks.map((t) => (
            <g key={`oi-${t}`}>
              <line stroke={CHART.grid} x1={PAD.left} x2={width - PAD.right} y1={oiY(t)} y2={oiY(t)} />
              <text fill={CHART.text} fontSize={10} textAnchor="end" x={PAD.left - 6} y={oiY(t) + 3}>{compact(t)}</text>
            </g>
          ))}
          {rows.map((r, i) => {
            const cx = xCenter(i);
            const base = oiY(0);
            const ce = r.ce?.oi ?? 0;
            const pe = r.pe?.oi ?? 0;
            return (
              <g key={r.strike}>
                <path d={topRoundedBar(cx - barW - 1, oiY(ce), barW, base - oiY(ce))} fill={CHART.ce} />
                <path d={topRoundedBar(cx + 1, oiY(pe), barW, base - oiY(pe))} fill={CHART.pe} />
              </g>
            );
          })}

          {/* Panel B: IV */}
          <text fill={CHART.text} fontSize={11} x={PAD.left} y={panelBTop - 2}>Implied volatility (%)</text>
          {ivTicks.map((t) => (
            <g key={`iv-${t}`}>
              <line stroke={CHART.grid} x1={PAD.left} x2={width - PAD.right} y1={ivY(t)} y2={ivY(t)} />
              <text fill={CHART.text} fontSize={10} textAnchor="end" x={PAD.left - 6} y={ivY(t) + 3}>{t}</text>
            </g>
          ))}
          <path d={linePath('ce')} fill="none" stroke={CHART.ce} strokeWidth={2} strokeLinejoin="round" />
          <path d={linePath('pe')} fill="none" stroke={CHART.pe} strokeWidth={2} strokeLinejoin="round" />
          {rows.map((r, i) =>
            (['ce', 'pe'] as const).map((side) => {
              const v = r[side]?.iv;
              return Number.isFinite(v) ? (
                <circle
                  cx={xCenter(i)}
                  cy={ivY(v as number)}
                  fill={side === 'ce' ? CHART.ce : CHART.pe}
                  key={`${side}-${r.strike}`}
                  r={hoverIdx === i ? 5 : 3.5}
                  stroke={CHART.surface}
                  strokeWidth={2}
                />
              ) : null;
            }),
          )}
          {(['ce', 'pe'] as const).map((side) => {
            const lastIdx = [...rows.keys()].reverse().find((i) => Number.isFinite(rows[i][side]?.iv));
            if (lastIdx === undefined) return null;
            return (
              <text fill={side === 'ce' ? CHART.ce : CHART.pe} fontSize={10} fontWeight={600} key={`lbl-${side}`} x={xCenter(lastIdx) + 8} y={ivY(rows[lastIdx][side]?.iv as number) + 3}>
                {side.toUpperCase()}
              </text>
            );
          })}

          {/* Strike axis (shared) */}
          {rows.map((r, i) =>
            i % labelEvery === 0 ? (
              <text fill={CHART.text} fontSize={10} key={`x-${r.strike}`} textAnchor="middle" x={xCenter(i)} y={height - 8}>
                {r.strike}
              </text>
            ) : null,
          )}

          {/* Spot marker across both panels */}
          {spotX !== null ? (
            <g>
              <line stroke={CHART.ink} strokeDasharray="3 3" strokeWidth={1} x1={spotX} x2={spotX} y1={PAD.top} y2={panelBTop + PANEL_H} />
              <text fill={CHART.ink} fontSize={10} textAnchor="middle" x={spotX} y={PAD.top + PANEL_H + 12}>spot</text>
            </g>
          ) : null}

          {/* Hover targets: one per strike column */}
          {rows.map((r, i) => (
            <rect
              fill="transparent"
              height={height}
              key={`hit-${r.strike}`}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
              width={slot}
              x={PAD.left + slot * i}
              y={0}
            />
          ))}
          {hoverIdx !== null ? (
            <line pointerEvents="none" stroke={CHART.text} strokeDasharray="2 2" x1={xCenter(hoverIdx)} x2={xCenter(hoverIdx)} y1={PAD.top} y2={panelBTop + PANEL_H} />
          ) : null}
        </svg>

        {hovered ? (
          <div
            className="pointer-events-none absolute top-2 z-10 rounded-md border bg-popover px-2.5 py-2 text-xs shadow-sm"
            style={{ left: Math.min(Math.max(0, xCenter(hoverIdx!) + 12), width - 170) }}
          >
            <div className="mb-1 font-medium">Strike {hovered.strike}</div>
            <SideRow color={CHART.ce} label="CE" side={hovered.ce} />
            <SideRow color={CHART.pe} label="PE" side={hovered.pe} />
          </div>
        ) : null}
      </div>
    </figure>
  );
}

function SideRow({ color, label, side }: { readonly color: string; readonly label: string; readonly side?: ChainSide }) {
  if (!side) return null;
  const oiChange = side.oi !== undefined && side.oiPrev !== undefined ? side.oi - side.oiPrev : undefined;
  return (
    <div className="flex items-center gap-2 tabular-nums">
      <i className="inline-block size-2 rounded-sm" style={{ background: color }} />
      <span className="w-5 font-medium">{label}</span>
      <span>OI {compact(side.oi ?? 0)}{oiChange !== undefined ? ` (${oiChange >= 0 ? '+' : ''}${compact(oiChange)})` : ''}</span>
      {side.iv !== undefined ? <span>IV {side.iv.toFixed(1)}%</span> : null}
      {side.ltp !== undefined ? <span>{inr(side.ltp)}</span> : null}
    </div>
  );
}
