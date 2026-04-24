import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

export type InstallChannel = 'npm-global' | 'npm-local' | 'source-checkout' | 'unknown';

type ExistsSyncLike = typeof fs.existsSync;
type ExecFileSyncLike = typeof execFileSync;

interface DetectInstallChannelOptions {
  packageRoot: string;
  globalNpmRoot?: string | null;
  existsSyncImpl?: ExistsSyncLike;
}

interface GetCurrentInstallChannelOptions {
  packageRoot: string;
  existsSyncImpl?: ExistsSyncLike;
  execFileSyncImpl?: ExecFileSyncLike;
}

export interface InstallChannelSupport {
  channel: InstallChannel;
  label: string;
  canSelfUpdate: boolean;
  recommendedCommand: string | null;
  guidance: string;
}

function isSubpath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function getRootBeforeNodeModules(packageRoot: string): string | null {
  const marker = `${path.sep}node_modules${path.sep}`;
  const index = packageRoot.indexOf(marker);
  if (index === -1) return null;
  return packageRoot.slice(0, index);
}

export function getGlobalNpmRoot(
  options: { execFileSyncImpl?: ExecFileSyncLike } = {},
): string | null {
  const { execFileSyncImpl = execFileSync } = options;

  try {
    return execFileSyncImpl('npm', ['root', '-g'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

export function detectInstallChannel(options: DetectInstallChannelOptions): InstallChannel {
  const {
    packageRoot,
    globalNpmRoot,
    existsSyncImpl = fs.existsSync,
  } = options;

  const normalizedPackageRoot = path.resolve(packageRoot);

  if (existsSyncImpl(path.join(normalizedPackageRoot, '.git'))) {
    return 'source-checkout';
  }

  if (globalNpmRoot && isSubpath(path.resolve(globalNpmRoot), normalizedPackageRoot)) {
    return 'npm-global';
  }

  const rootBeforeNodeModules = getRootBeforeNodeModules(normalizedPackageRoot);
  if (rootBeforeNodeModules && existsSyncImpl(path.join(rootBeforeNodeModules, 'package.json'))) {
    return 'npm-local';
  }

  return 'unknown';
}

export function getCurrentInstallChannel(
  options: GetCurrentInstallChannelOptions,
): InstallChannel {
  const {
    packageRoot,
    existsSyncImpl,
    execFileSyncImpl,
  } = options;

  return detectInstallChannel({
    packageRoot,
    globalNpmRoot: getGlobalNpmRoot({ execFileSyncImpl }),
    existsSyncImpl,
  });
}

export function getInstallChannelSupport(channel: InstallChannel): InstallChannelSupport {
  switch (channel) {
    case 'npm-global':
      return {
        channel,
        label: 'npm global',
        canSelfUpdate: true,
        recommendedCommand: 'memesh update',
        guidance: 'This installation can be updated directly from MeMesh.',
      };
    case 'npm-local':
      return {
        channel,
        label: 'project-local package install',
        canSelfUpdate: false,
        recommendedCommand: null,
        guidance: 'Update this installation from the project package manager that installed MeMesh.',
      };
    case 'source-checkout':
      return {
        channel,
        label: 'source checkout',
        canSelfUpdate: false,
        recommendedCommand: null,
        guidance: 'Update this source checkout from its repository and rebuild it.',
      };
    default:
      return {
        channel: 'unknown',
        label: 'unknown',
        canSelfUpdate: false,
        recommendedCommand: null,
        guidance: 'Update this installation from the tool or workflow that installed MeMesh.',
      };
  }
}
