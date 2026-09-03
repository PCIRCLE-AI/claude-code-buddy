import { describe, expect, it } from 'vitest';
import { recipientEverSeen } from '../../scripts/hooks/_generated/agent-message-inbox.js';

// D8 review gap: `recipientEverSeen` is mirrored into the SessionStart hook's
// generated copy (scripts/generate-hook-core.mjs) so the hook and the MCP/CLI
// briefing surface can't disagree, but nothing in src/ or tests/ exercised
// that mirrored copy directly — a change to its catch block could regress
// silently. This calls the generated file, not src/core/agent-message-inbox.ts.
describe('generated hook copy: recipientEverSeen', () => {
  it('returns undefined, not a thrown error, when the query cannot be answered', () => {
    const throwingDb = {
      prepare() {
        throw new Error('no such table: agent_principals');
      },
    };
    expect(recipientEverSeen(throwingDb as never, 'proj', 'someone')).toBeUndefined();
  });

  it('returns true when the delivery table has seen the recipient', () => {
    const db = {
      prepare() {
        return { get: () => ({ seen: 1 }) };
      },
    };
    expect(recipientEverSeen(db as never, 'proj', 'someone')).toBe(true);
  });
});
