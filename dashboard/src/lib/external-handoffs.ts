export type ExternalDestination = 'terminal' | 'github';

/** Complete set of deliberate Dashboard exits. Contract tests keep the
 * rendered surfaces and this inventory in sync. */
export const DASHBOARD_EXTERNAL_HANDOFFS = [
  { id: 'doctor-fix-command', destination: 'terminal', surface: 'DoctorBanner' },
  { id: 'doctor-help', destination: 'github', surface: 'DoctorBanner' },
  { id: 'feedback-submit', destination: 'github', surface: 'FeedbackWidget' },
  { id: 'settings-update', destination: 'terminal', surface: 'SettingsTab' },
  { id: 'graph-evidence-backfill', destination: 'terminal', surface: 'EvidencePanel' },
  { id: 'demo-cli-fallback', destination: 'terminal', surface: 'OnboardingBanner' },
  { id: 'project-hook-setup', destination: 'terminal', surface: 'ProjectTab' },
  { id: 'load-recovery', destination: 'terminal', surface: 'failure' },
  { id: 'server-error-recovery', destination: 'terminal', surface: 'api' },
] as const;

export function openExternalWindow(url: string): boolean {
  const opened = window.open(url, '_blank');
  if (!opened) return false;
  try { opened.opener = null; } catch { /* cross-origin browser policy */ }
  return true;
}

export function terminalCommands(text: string): string[] {
  return [...text.matchAll(/`(memesh(?:\s+[^`]+)?)`/g)].map(match => match[1]);
}
