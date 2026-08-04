import { useRef, useEffect } from 'preact/hooks';
import { t } from '../lib/i18n';
import { resolveTokens } from '../lib/tokens';

export interface TimelineEntry {
  date: string;
  created: number;
  recalled: number;
}

interface MemoryTimelineProps {
  data: TimelineEntry[];
}

const PAD_TOP = 8;
const PAD_RIGHT = 8;
const PAD_BOTTOM = 20;
const PAD_LEFT = 8;
const CANVAS_HEIGHT = 120;

// Accent at 30% — a glow alpha (no 8% token fits), sanctioned by DESIGN.md and
// shared by the bars and the DOM legend swatch so they stay identical.
const BAR_FILL = 'rgba(0, 214, 180, 0.3)';
const LINE_WIDTH = 1.5;
// The line, label colour and font are palette tokens; canvas cannot read
// var(), so they are resolved from the live stylesheet inside drawTimeline.

function drawTimeline(
  canvas: HTMLCanvasElement,
  data: TimelineEntry[],
): void {
  // Clear inline width so CSS 'width:100%' can resolve correctly for measurement.
  // Without this, a previous 0px write (from when the panel was display:none) would
  // permanently suppress the layout width even after the tab becomes visible.
  canvas.style.width = '';

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssW = rect.width;
  const cssH = CANVAS_HEIGHT;

  const chartW = cssW - PAD_LEFT - PAD_RIGHT;
  const chartH = cssH - PAD_TOP - PAD_BOTTOM;

  if (data.length === 0 || chartW <= 0 || chartH <= 0) return;

  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.scale(dpr, dpr);

  // Resolve the tokens this draw needs (empty when no stylesheet, e.g. a test —
  // a visible signal, never a literal fallback). See lib/tokens.ts.
  const tk = resolveTokens(canvas, ['--accent', '--text-3', '--font']);
  const lineStroke = tk['--accent'];
  const labelColor = tk['--text-3'];
  const labelFont = `9px ${tk['--font']}`;

  const maxCreated = Math.max(1, ...data.map((d) => d.created));
  const maxRecalled = Math.max(1, ...data.map((d) => d.recalled));
  const maxVal = Math.max(maxCreated, maxRecalled);

  const barCount = data.length;
  const gap = 1;
  const barW = Math.max(1, (chartW - gap * (barCount - 1)) / barCount);

  // -- Draw bars (created) --
  ctx.fillStyle = BAR_FILL;
  for (let i = 0; i < barCount; i++) {
    const entry = data[i];
    const barH = (entry.created / maxVal) * chartH;
    const x = PAD_LEFT + i * (barW + gap);
    const y = PAD_TOP + chartH - barH;
    ctx.fillRect(x, y, barW, barH);
  }

  // -- Draw line (recalled) --
  ctx.beginPath();
  ctx.strokeStyle = lineStroke;
  ctx.lineWidth = LINE_WIDTH;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (let i = 0; i < barCount; i++) {
    const entry = data[i];
    const x = PAD_LEFT + i * (barW + gap) + barW / 2;
    const y = PAD_TOP + chartH - (entry.recalled / maxVal) * chartH;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();

  // -- X-axis labels every 7 days --
  ctx.fillStyle = labelColor;
  ctx.font = labelFont;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  for (let i = 0; i < barCount; i += 7) {
    const entry = data[i];
    // Format as MM-DD
    const parts = entry.date.split('-');
    const label = parts.length >= 3 ? `${parts[1]}-${parts[2]}` : entry.date;
    const x = PAD_LEFT + i * (barW + gap) + barW / 2;
    const y = PAD_TOP + chartH + 4;
    ctx.fillText(label, x, y);
  }
}

export function MemoryTimeline({ data }: MemoryTimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    drawTimeline(canvas, data);

    // ResizeObserver fires on window resize AND on display:none→block (tab switch),
    // unlike window.resize which misses the tab reveal case.
    const observer = new ResizeObserver(() => drawTimeline(canvas, data));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [data]);

  const totalCreated = data.reduce((sum, d) => sum + d.created, 0);
  const totalRecalled = data.reduce((sum, d) => sum + d.recalled, 0);

  return (
    <div class="card">
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 14,
      }}>
        <div class="card-title" style={{ marginBottom: 0 }}>
          {t('timeline.title')}
        </div>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          fontSize: 11,
          color: 'var(--text-2)',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              borderRadius: 'var(--radius-hairline)',
              background: BAR_FILL,
            }} />
            {t('timeline.created')}
            <span style={{
              fontFamily: 'var(--mono)',
              color: 'var(--text-3)',
              marginLeft: 2,
            }}>
              {totalCreated}
            </span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              display: 'inline-block',
              width: 10,
              height: 2,
              borderRadius: 'var(--radius-hairline)',
              background: 'var(--accent)',
            }} />
            {t('timeline.recalled')}
            <span style={{
              fontFamily: 'var(--mono)',
              color: 'var(--text-3)',
              marginLeft: 2,
            }}>
              {totalRecalled}
            </span>
          </span>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: `${CANVAS_HEIGHT}px`,
          display: 'block',
        }}
      />
    </div>
  );
}
