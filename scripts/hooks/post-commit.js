#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { basename } from 'path';
import { openHookDb } from './_shared.js';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);

    // Only process Bash tool outputs
    if (data.tool_name !== 'Bash') return exit0();
    const toolOutput = typeof data.tool_output === 'string'
      ? data.tool_output
      : JSON.stringify(data.tool_output || '');

    // Detect git commit in output
    // Pattern: [branch hash] commit message
    const commitMatch = toolOutput.match(/\[[\w/.-]+ ([a-f0-9]{7,})\] (.+)/);
    if (!commitMatch) return exit0();

    const branchMatch = commitMatch[0].match(/^\[([^\s]+)\s/);
    const branch = branchMatch ? branchMatch[1] : 'unknown';

    const commitHash = commitMatch[1];
    const commitMsg = commitMatch[2];
    const projectName = basename(data.cwd || process.cwd());

    // Open DB via shared helper — applies SCHEMA_SQL + status migration.
    // Pass fts:true so the FTS5 entity-search index is also available.
    const { db } = openHookDb(process.env, { fts: true });
    try {
      const entityName = `commit-${commitHash}`;

      // Check if this is a new or existing entity
      const insertResult = db.prepare('INSERT OR IGNORE INTO entities (name, type) VALUES (?, ?)').run(entityName, 'commit');
      const isNew = insertResult.changes > 0;
      const entity = db.prepare('SELECT id FROM entities WHERE name = ?').get(entityName);
      if (entity) {
        // Capture existing observations for FTS delete (before inserting new one)
        const prevObs = isNew
          ? []
          : db.prepare('SELECT content FROM observations WHERE entity_id = ?').all(entity.id);
        const prevObsText = isNew ? undefined : prevObs.map(o => o.content).join(' ');

        // Add observations
        db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(entity.id, commitMsg);
        db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(entity.id, `Branch: ${branch}`);

        // Add richer diff stats as an observation (backward compatible — failures are silently ignored)
        try {
          const stat = execFileSync('git', ['show', '--stat', '--format=', commitHash], {
            cwd: data.cwd || process.cwd(),
            encoding: 'utf8',
            timeout: 5000,
          }).trim();
          if (stat) {
            // Last non-empty line is the summary, e.g. "3 files changed, 45 insertions(+), 12 deletions(-)"
            const statLines = stat.split('\n').filter(l => l.trim());
            const summary = statLines[statLines.length - 1]?.trim() || '';
            if (summary) {
              db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(entity.id, `Diff stats: ${summary}`);
            }
          }
        } catch {
          // git show failed — no diff stats recorded, existing behavior unchanged
        }

        // Add project tag
        const projectTag = `project:${projectName}`;
        db.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)').run(entity.id, projectTag);

        // Update FTS index — delete old entry first if entity existed
        if (prevObsText !== undefined) {
          db.prepare("INSERT INTO entities_fts(entities_fts, rowid, name, observations) VALUES('delete', ?, ?, ?)").run(entity.id, entityName, prevObsText);
        }
        // Fetch all observations (including the one just added) for the new FTS entry
        const allObs = db.prepare('SELECT content FROM observations WHERE entity_id = ?').all(entity.id);
        const allObsText = allObs.map(o => o.content).join(' ');
        db.prepare('INSERT INTO entities_fts(rowid, name, observations) VALUES(?, ?, ?)').run(entity.id, entityName, allObsText);
      }
    } finally {
      db.close();
    }
  } catch (err) {
    // Never crash Claude Code — but leave a trace for debugging
    try { process.stderr.write(`[memesh post-commit] ${err?.message || err}\n`); } catch {}
  }
  console.log(JSON.stringify({ suppressOutput: true }));
  exit0();
});

function exit0() {
  process.exit(0);
}
