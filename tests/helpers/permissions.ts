import fs from 'fs';
import { expect } from 'vitest';

export function expectPrivateDir(dirPath: string): void {
  const stats = fs.statSync(dirPath);
  expect(stats.isDirectory()).toBe(true);

  if (process.platform === 'win32') {
    // Windows ACLs do not round-trip through POSIX mode bits in Node's stat output.
    // The production code still attempts hardening, but exact 0o700 is not portable here.
    expect(stats.mode & 0o777).toBeGreaterThan(0);
    return;
  }

  expect(stats.mode & 0o777).toBe(0o700);
}

export function expectPrivateFile(filePath: string): void {
  const stats = fs.statSync(filePath);
  expect(stats.isFile()).toBe(true);

  if (process.platform === 'win32') {
    // Windows ACLs do not round-trip through POSIX mode bits in Node's stat output.
    // The production code still attempts hardening, but exact 0o600 is not portable here.
    expect(stats.mode & 0o777).toBeGreaterThan(0);
    return;
  }

  expect(stats.mode & 0o777).toBe(0o600);
}
