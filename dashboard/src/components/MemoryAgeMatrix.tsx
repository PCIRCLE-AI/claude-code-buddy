import { t } from '../lib/i18n';

type AgeBucket = 'week' | 'month' | 'quarter' | 'older';
interface AgeMatrixEntry { type: string; bucket: AgeBucket; count: number }

interface MemoryAgeMatrixProps {
  data: AgeMatrixEntry[];
}

const BUCKETS: AgeBucket[] = ['week', 'month', 'quarter', 'older'];
const BUCKET_LABELS: Record<AgeBucket, string> = {
  week: '本週',
  month: '本月',
  quarter: '本季',
  older: '更早',
};

// Types displayed in order (most diagnostic ones first)
const TYPE_ORDER = [
  'lesson_learned', 'lesson', 'mistake',
  'decision', 'architecture_decision',
  'pattern', 'technical_pattern', 'best_practice',
  'bug_fix',
  'workflow_checkpoint', 'process',
  'architecture', 'feature',
];

const TYPE_LABEL: Record<string, string> = {
  lesson_learned: '教訓', lesson: '教訓', mistake: '錯誤',
  decision: '決策', architecture_decision: '架構決策',
  pattern: '模式', technical_pattern: '技術模式', best_practice: '最佳實踐',
  bug_fix: '問題修復',
  workflow_checkpoint: '流程里程碑', process: '流程',
  architecture: '架構', feature: '功能',
};

// Intensity color: 0 = no data, higher = more vivid cyan
function cellStyle(count: number, max: number): string {
  if (count === 0 || max === 0) return 'rgba(255,255,255,0.03)';
  const intensity = Math.min(count / max, 1);
  const alpha = 0.12 + intensity * 0.55;
  return `rgba(0, 214, 180, ${alpha.toFixed(2)})`;
}

export function MemoryAgeMatrix({ data }: MemoryAgeMatrixProps) {
  if (!data || data.length === 0) return null;

  // Build lookup map: type → bucket → count
  const lookup: Map<string, Map<AgeBucket, number>> = new Map();
  for (const row of data) {
    if (!lookup.has(row.type)) lookup.set(row.type, new Map());
    lookup.get(row.type)!.set(row.bucket, row.count);
  }

  // Only include types that appear in data, sorted by TYPE_ORDER
  const types = TYPE_ORDER.filter(t => lookup.has(t));
  const maxCount = Math.max(1, ...data.map(r => r.count));

  return (
    <div class="card">
      <div class="card-title" style={{ marginBottom: 16 }}>記憶年齡分佈</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 12,
          tableLayout: 'fixed',
        }}>
          <colgroup>
            <col style={{ width: '28%' }} />
            {BUCKETS.map(b => <col key={b} style={{ width: '18%' }} />)}
          </colgroup>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-2)', fontWeight: 400 }}>
                類型
              </th>
              {BUCKETS.map(b => (
                <th key={b} style={{
                  textAlign: 'center',
                  padding: '4px 6px',
                  color: 'var(--text-2)',
                  fontWeight: 400,
                }}>
                  {BUCKET_LABELS[b]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {types.map(type => {
              const row = lookup.get(type)!;
              const total = Array.from(row.values()).reduce((s, v) => s + v, 0);
              return (
                <tr key={type}>
                  <td style={{
                    padding: '5px 8px',
                    color: 'var(--text-1)',
                    fontSize: 11,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    {TYPE_LABEL[type] || type}
                    <span style={{ color: 'var(--text-3)', marginLeft: 4 }}>({total})</span>
                  </td>
                  {BUCKETS.map(b => {
                    const count = row.get(b) ?? 0;
                    return (
                      <td key={b} style={{
                        textAlign: 'center',
                        padding: '5px 6px',
                        background: cellStyle(count, maxCount),
                        borderRadius: 4,
                        color: count > 0 ? 'var(--accent)' : 'var(--text-3)',
                        fontFamily: 'var(--mono)',
                        fontWeight: count > 0 ? 600 : 400,
                        fontSize: 11,
                        transition: 'background 0.2s',
                      }}>
                        {count > 0 ? count : '·'}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{
        marginTop: 10,
        fontSize: 11,
        color: 'var(--text-3)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        <span>低</span>
        {[0.15, 0.35, 0.55, 0.7].map(a => (
          <span key={a} style={{
            display: 'inline-block',
            width: 14,
            height: 10,
            borderRadius: 2,
            background: `rgba(0,214,180,${a})`,
          }} />
        ))}
        <span>高</span>
        <span style={{ marginLeft: 8 }}>— 顏色深度 = 記憶密度</span>
      </div>
    </div>
  );
}
