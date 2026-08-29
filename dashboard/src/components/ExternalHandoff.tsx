import { useState } from 'preact/hooks';
import { t } from '../lib/i18n';

export function TerminalHandoff({ id, command }: { id: string; command: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(command); setCopied(true); }
    catch { setCopied(false); }
  }
  return (
    <div data-external-handoff={id} data-destination="terminal" style={{ marginTop: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--warning)', fontWeight: 600 }}>{t('handoff.terminal')}</div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', margin: '2px 0 5px' }}>{t('handoff.terminalPrereq')}</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <code style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{command}</code>
        <button type="button" class="btn btn-sm" onClick={() => { void copy(); }}>
          {copied ? t('handoff.commandCopied') : t('handoff.copyCommand')}
        </button>
      </div>
    </div>
  );
}

export function GitHubDestination({ id }: { id: string }) {
  return <span data-external-handoff={id} data-destination="github" style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('handoff.github')}</span>;
}
