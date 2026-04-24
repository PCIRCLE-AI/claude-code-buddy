import { execFileSync } from 'child_process';

type ExecFileSyncLike = typeof execFileSync;

interface RunGlobalUpdateOptions {
  execFileSyncImpl?: ExecFileSyncLike;
}

interface InstalledPackageTree {
  dependencies?: Record<string, { version?: string }>;
}

function parseInstalledGlobalVersion(raw: string): string | null {
  const parsed = JSON.parse(raw) as InstalledPackageTree;
  return parsed.dependencies?.['@pcircle/memesh']?.version ?? null;
}

export function getInstalledGlobalVersion(
  options: RunGlobalUpdateOptions = {},
): string | null {
  const { execFileSyncImpl = execFileSync } = options;

  try {
    const raw = execFileSyncImpl(
      'npm',
      ['ls', '-g', '@pcircle/memesh', '--json', '--depth=0'],
      { encoding: 'utf8' },
    );
    return parseInstalledGlobalVersion(raw);
  } catch {
    return null;
  }
}

export function runGlobalUpdate(
  latestVersion: string,
  options: RunGlobalUpdateOptions = {},
): { installedVersion: string } {
  const { execFileSyncImpl = execFileSync } = options;

  execFileSyncImpl(
    'npm',
    ['install', '-g', `@pcircle/memesh@${latestVersion}`],
    { stdio: 'inherit' },
  );

  const installedVersion = getInstalledGlobalVersion({ execFileSyncImpl });
  if (installedVersion !== latestVersion) {
    if (installedVersion) {
      throw new Error(`expected ${latestVersion}, but npm reports ${installedVersion} is installed`);
    }
    throw new Error('npm did not report a global @pcircle/memesh installation after update');
  }

  return { installedVersion };
}
