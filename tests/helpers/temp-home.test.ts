/**
 * `removeTempHome` swallows errors. This pins WHICH ones.
 *
 * The helper exists to absorb one specific race — a detached update-check
 * child writing into `<home>/.memesh` while cleanup is removing it. An
 * unqualified `catch {}` would also absorb a genuinely broken cleanup and
 * report nothing, which is the failure mode this repository treats as a
 * defect in its own right. So the narrowness is the contract, and the
 * contract needs an assertion.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { removeTempHome } from './temp-home.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function errWithCode(code: string): NodeJS.ErrnoException {
  const err = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('removeTempHome', () => {
  it('actually removes the directory when nothing is racing it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-temp-home-'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');

    removeTempHome(dir);

    expect(fs.existsSync(dir), 'the helper did not delete the directory').toBe(false);
  });

  it.each(['ENOTEMPTY', 'EBUSY', 'EPERM'])(
    'swallows %s — that is the live-writer race, not a broken test',
    (code) => {
      vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw errWithCode(code); });

      expect(() => removeTempHome('/nonexistent')).not.toThrow();
    },
  );

  it('rethrows anything else, so a genuinely broken cleanup is still visible', () => {
    vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw errWithCode('EACCES'); });

    expect(() => removeTempHome('/nonexistent')).toThrow(/simulated EACCES/);
  });

  it('removes every directory it is given, not just the first', () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-temp-home-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-temp-home-b-'));

    removeTempHome(a, b);

    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b), 'the second directory was left behind').toBe(false);
  });
});
