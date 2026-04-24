import { useState } from 'preact/hooks';
import { api } from '../lib/api';
import { t } from '../lib/i18n';

interface StaleEntity {
  id: number;
  name: string;
  type: string;
  confidence: number;
  days_unused: number;
}

interface Props {
  staleEntities: StaleEntity[];
  duplicateCandidates: Array<{ name1: string; name2: string; type: string }>;
  onRefresh: () => void;
}

export function CleanupSuggestions({ staleEntities, duplicateCandidates, onRefresh }: Props) {
  const [archiving, setArchiving] = useState<Set<number>>(() => new Set());

  async function handleArchive(entity: StaleEntity) {
    setArchiving((prev) => new Set(prev).add(entity.id));
    try {
      await api('POST', '/v1/forget', { name: entity.name });
      onRefresh();
    } catch {
      // Remove from archiving set on failure so button re-enables
      setArchiving((prev) => {
        const next = new Set(prev);
        next.delete(entity.id);
        return next;
      });
    }
  }

  const isEmpty = staleEntities.length === 0 && duplicateCandidates.length === 0;

  return (
    <div class="card">
      {isEmpty && (
        <div class="empty" style={{ padding: '24px 12px' }}>
          <span class="empty-icon">{"✓"}</span>
          {t('cleanup.allClean')}
        </div>
      )}

      {staleEntities.length > 0 && (
        <div>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--text-3)',
            textTransform: 'uppercase',
            letterSpacing: '.06em',
            marginBottom: 10,
          }}>
            {t('cleanup.staleLabel')}
          </div>
          {staleEntities.map((entity) => (
            <div
              key={entity.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 0',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: 'var(--text-1)' }}>
                  {entity.name}
                </div>
                <div style={{
                  fontSize: 11,
                  fontFamily: 'var(--mono)',
                  color: 'var(--text-3)',
                  marginTop: 2,
                }}>
                  {t('cleanup.entityMeta', {
                    type: entity.type,
                    confidence: Math.round(entity.confidence * 100),
                    days: entity.days_unused,
                  })}
                </div>
              </div>
              <button
                class="btn btn-sm btn-danger"
                disabled={archiving.has(entity.id)}
                onClick={() => handleArchive(entity)}
                style={{ flexShrink: 0, marginLeft: 12 }}
              >
                {archiving.has(entity.id) ? '…' : t('browse.archive')}
              </button>
            </div>
          ))}
        </div>
      )}

      {duplicateCandidates.length > 0 && (
        <div style={{ marginTop: staleEntities.length > 0 ? 16 : 0 }}>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--text-3)',
            textTransform: 'uppercase',
            letterSpacing: '.06em',
            marginBottom: 10,
          }}>
            {t('cleanup.duplicateLabel')}
          </div>
          {duplicateCandidates.map((dup, i) => (
            <div
              key={`${dup.name1}-${dup.name2}-${i}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 0',
                borderBottom: '1px solid var(--border-subtle)',
                fontSize: 13,
                color: 'var(--text-1)',
              }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {dup.name1}
              </span>
              <span style={{ color: 'var(--text-3)', flexShrink: 0 }}>↔</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {dup.name2}
              </span>
              <span class="badge badge-type" style={{ flexShrink: 0 }}>{dup.type}</span>
            </div>
          ))}
          <div style={{
            fontSize: 11,
            color: 'var(--text-3)',
            marginTop: 10,
            fontStyle: 'italic',
          }}>
            {t('cleanup.consolidateHint')}
          </div>
        </div>
      )}
    </div>
  );
}
