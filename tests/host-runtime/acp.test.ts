import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACP_SESSION_UPDATE_MAX_FILE_BYTES,
  ACP_SESSION_UPDATE_MAX_RECORD_BYTES,
  ACP_SESSION_UPDATE_MAX_RECORDS,
  createAcpSessionUpdateSink,
} from '../../src/host-runtime/acp.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function privateDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-acp-updates-'));
  fs.chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

function readLines(file: string): string[] {
  return fs.readFileSync(file, 'utf8').trimEnd().split('\n');
}

describe('ACP runtime session update output', () => {
  it('is disabled by default and creates no output', () => {
    const directory = privateDirectory();
    expect(createAcpSessionUpdateSink(undefined)).toBeUndefined();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('writes only opted-in ACP session updates to an owner-private JSONL file', () => {
    const directory = privateDirectory();
    const output = path.join(directory, 'session-updates.jsonl');
    const sink = createAcpSessionUpdateSink(output);
    expect(sink).toBeDefined();

    sink?.write({
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'model feedback for dogfood' },
      },
    });
    sink?.close();

    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readLines(output)[0])).toEqual({
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'model feedback for dogfood' },
      },
    });
  });

  it('rejects non-private paths and symlink output targets', () => {
    const directory = privateDirectory();
    const publicDirectory = path.join(directory, 'public');
    fs.mkdirSync(publicDirectory, { mode: 0o755 });
    expect(() => createAcpSessionUpdateSink(path.join(publicDirectory, 'updates.jsonl')))
      .toThrow(/parent.*owner-private/);

    const publicFile = path.join(directory, 'public.jsonl');
    fs.writeFileSync(publicFile, '', { mode: 0o644 });
    expect(() => createAcpSessionUpdateSink(publicFile)).toThrow(/file.*owner-private/);

    const realFile = path.join(directory, 'real.jsonl');
    const symlinkFile = path.join(directory, 'linked.jsonl');
    fs.writeFileSync(realFile, '', { mode: 0o600 });
    fs.symlinkSync(realFile, symlinkFile);
    expect(() => createAcpSessionUpdateSink(symlinkFile)).toThrow(/owner-private regular file/);
  });

  it('bounds individual records, total bytes, and record count', () => {
    const directory = privateDirectory();

    const recordFile = path.join(directory, 'record-bound.jsonl');
    const recordSink = createAcpSessionUpdateSink(recordFile);
    recordSink?.write({
      sessionId: 'record-bound',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'x'.repeat(ACP_SESSION_UPDATE_MAX_RECORD_BYTES * 2) },
      },
    });
    recordSink?.close();
    const recordLines = readLines(recordFile);
    expect(Buffer.byteLength(recordLines[0], 'utf8') + 1).toBeLessThanOrEqual(ACP_SESSION_UPDATE_MAX_RECORD_BYTES);
    expect(JSON.parse(recordLines[0])).toMatchObject({
      sessionId: 'record-bound',
      update: { truncated: true },
    });

    const countFile = path.join(directory, 'count-bound.jsonl');
    const countSink = createAcpSessionUpdateSink(countFile);
    for (let index = 0; index < ACP_SESSION_UPDATE_MAX_RECORDS + 10; index += 1) {
      countSink?.write({
        sessionId: 'count-bound',
        update: { sessionUpdate: 'agent_message_chunk', index },
      });
    }
    countSink?.close();
    expect(readLines(countFile)).toHaveLength(ACP_SESSION_UPDATE_MAX_RECORDS);

    const byteFile = path.join(directory, 'byte-bound.jsonl');
    const byteSink = createAcpSessionUpdateSink(byteFile);
    for (let index = 0; index < ACP_SESSION_UPDATE_MAX_RECORDS; index += 1) {
      byteSink?.write({
        sessionId: 'byte-bound',
        update: {
          sessionUpdate: 'agent_message_chunk',
          index,
          content: { type: 'text', text: 'x'.repeat(ACP_SESSION_UPDATE_MAX_RECORD_BYTES * 2) },
        },
      });
    }
    byteSink?.close();
    expect(fs.statSync(byteFile).size).toBeLessThanOrEqual(ACP_SESSION_UPDATE_MAX_FILE_BYTES);
    expect(readLines(byteFile).length).toBeLessThan(ACP_SESSION_UPDATE_MAX_RECORDS);
  });
});
