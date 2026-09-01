import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { Drawing } from '@/lib/chart-drawings';

// Series primitive that renders the user's trend/horizontal lines on the candle
// pane. The chart calls paneViews() every frame, so lines re-anchor during
// pan/zoom with no React round-trip; hitTest() feeds the chart's click events
// (param.hoveredObjectId) for select-to-delete.

const IST_OFFSET_S = 5.5 * 3600;
const HIT_DISTANCE = 6;

interface DrawingsState {
  drawings: Drawing[];
  selectedId: string | null;
  draft: Drawing | null;
}

interface SegmentPx {
  id: string;
  kind: Drawing['kind'];
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  selected: boolean;
  draft: boolean;
}

function distanceToSegment(px: number, py: number, s: SegmentPx): number {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / lengthSq));
  return Math.hypot(px - (s.x1 + t * dx), py - (s.y1 + t * dy));
}

class DrawingsRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly segments: SegmentPx[]) {}

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const s of this.segments) {
        ctx.save();
        ctx.strokeStyle = s.kind === 'horizontal' ? '#d97706' : '#0c6b3d';
        ctx.lineWidth = s.selected ? 3 : 2;
        if (s.draft) ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
        if (s.selected) {
          ctx.setLineDash([]);
          ctx.fillStyle = '#ffffff';
          const handles = s.kind === 'trend' ? [[s.x1, s.y1], [s.x2, s.y2]] : [[(s.x1 + s.x2) / 2, s.y1]];
          for (const [hx, hy] of handles) {
            ctx.beginPath();
            ctx.arc(hx, hy, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    });
  }
}

class DrawingsPaneView implements IPrimitivePaneView {
  constructor(private readonly owner: DrawingsPrimitive) {}

  zOrder(): 'normal' {
    return 'normal';
  }

  renderer(): IPrimitivePaneRenderer {
    return new DrawingsRenderer(this.owner.segments());
  }
}

export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private state: DrawingsState = { drawings: [], selectedId: null, draft: null };
  private readonly views = [new DrawingsPaneView(this)];

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time>): void {
    this.chart = chart;
    this.series = series;
    this.requestUpdate = requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  setState(next: Partial<DrawingsState>): void {
    this.state = { ...this.state, ...next };
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    for (const segment of this.segments()) {
      if (!segment.draft && distanceToSegment(x, y, segment) <= HIT_DISTANCE) {
        return { externalId: segment.id, zOrder: 'normal', cursorStyle: 'pointer' };
      }
    }
    return null;
  }

  /** Current drawings projected to pane pixels under the live pan/zoom. */
  segments(): SegmentPx[] {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series) return [];
    const timeScale = chart.timeScale();
    const width = timeScale.width();
    const out: SegmentPx[] = [];
    const all: Array<{ d: Drawing; draft: boolean }> = [
      ...this.state.drawings.map((d) => ({ d, draft: false })),
      ...(this.state.draft ? [{ d: this.state.draft, draft: true }] : []),
    ];
    for (const { d, draft } of all) {
      const selected = !draft && d.id === this.state.selectedId;
      if (d.kind === 'horizontal') {
        const y = series.priceToCoordinate(d.price);
        if (y === null) continue;
        out.push({ id: d.id, kind: d.kind, x1: 0, y1: y, x2: width, y2: y, selected, draft });
      } else {
        // via logical index, not timeToCoordinate — the latter returns null once
        // an anchor pans out of view, which would hide the whole line
        const toX = (time: number) => {
          const index = timeScale.timeToIndex((time + IST_OFFSET_S) as Time, true);
          return index === null ? null : timeScale.logicalToCoordinate(index as never);
        };
        const x1 = toX(d.a.time);
        const x2 = toX(d.b.time);
        const y1 = series.priceToCoordinate(d.a.price);
        const y2 = series.priceToCoordinate(d.b.price);
        if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
        out.push({ id: d.id, kind: d.kind, x1, y1, x2, y2, selected, draft });
      }
    }
    return out;
  }
}
