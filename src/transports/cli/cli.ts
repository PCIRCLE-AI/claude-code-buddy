#!/usr/bin/env node

import { Command, Option } from 'commander';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  openDatabase, closeDatabase, getDatabase, reindexFts,
  readVectorGeneration, generationRowIds, discardVectorGeneration,
} from '../../db.js';
import { remember, recallWithConflicts, forget, exportMemories, importMemories, learn, reindex, setPinned } from '../../core/operations.js';
import { readConfig, writeConfig, maskApiKey, detectCapabilities } from '../../core/config.js';
import { MAX_LANGUAGE_LENGTH, languageValueError } from '../../core/output-language.js';
import { getDbPath, getProjectName, homeDir, redactSecrets, redactUserPaths } from '../../core/paths.js';
import { flushPendingEmbeddings, canRefillVectorIndex } from '../../core/embedder.js';
import { NAMESPACES } from '../../core/types.js';
import { assembleBriefing } from '../../core/briefing.js';
import { inspectHosts, allWired, type SetupSeams, type HostStatus } from '../../core/setup.js';
import { installHooks } from '../../core/install-hooks.js';
import { getTaskState, setTaskState } from '../../core/task-state-store.js';
import { TASK_STATE_FIELDS, taskStateLines, type TaskStateField } from '../../core/task-state.js';
import type { LessonSeverity, MergeStrategy, ExportResult } from '../../core/types.js';

// DX: every CLI command that touches the DB used to repeat
//   openDatabase(); try { ...body... } finally { closeDatabase(); }
// withDatabase factors that into one place so future commands cannot
// forget the close. Async-friendly via Promise return type.
async function withDatabase<T>(fn: () => T | Promise<T>): Promise<T> {
  openDatabase();
  try {
    return await fn();
  } finally {
    closeDatabase();
  }
}

/**
 * Reject a flag value that is not one of the documented choices.
 *
 * `config set` has validated its enums since it shipped; the ordinary flags did
 * not, and each unvalidated one failed in its own quiet way, all exiting 0.
 * `--merge sikp` fell through to overwrite and destroyed observations.
 * `--namespace persnal` stored the memory where nothing queries, so it vanished
 * from every scoped view including the dashboard. `--severity catastrophic` was
 * written into the graph as a tag nothing filters on.
 */
function requireOneOf(value: string | undefined, allowed: readonly string[], flag: string): void {
  if (value === undefined || allowed.includes(value)) return;
  console.error(`Error: ${flag} "${value}" is not valid. Use one of: ${allowed.join(', ')}.`);
  process.exit(1);
}

/**
 * True when `tool` resolves to an executable on the current PATH — the same
 * question the upgrade script's `command -v` checks ask, answered up front so
 * a missing prerequisite is one plain sentence before anything runs, not a
 * mid-run death. Windows executables carry a PATHEXT extension (`npm.cmd`,
 * not `npm`), so each extension is tried there.
 */
function isOnPath(tool: string): boolean {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, tool + ext), fs.constants.X_OK);
        return true;
      } catch { /* not in this dir — keep looking */ }
    }
  }
  return false;
}

/**
 * Wire the session hooks for the current user and report in one line — the
 * shared body of `memesh setup`'s install-hooks action and
 * `memesh doctor --fix`'s. installHooks itself backs up settings.json and
 * refuses on plugin-managed machines.
 */
function wireUserHooks(): string {
  const r = installHooks({ pluginRoot: packageRoot, pluginVersion: pkg.version, scope: 'user' });
  return `hooks: added ${r.added}, skipped ${r.skipped} already-installed${r.backupPath ? ` (backup: ${r.backupPath})` : ''}`;
}

// One list, in core. The CLI's private copy was the fourth.

const packageJsonPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../package.json'
);
const packageRoot = path.dirname(packageJsonPath);
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

const program = new Command();
program
  .name('memesh')
  .description('MeMesh — Agentic memory for coding agents')
  .version(pkg.version)
  // DX: silence Commander's default "too many arguments. Expected 0..."
  // error so the root action below can inspect program.args and emit a
  // clear "unknown command 'foo'" message instead. allowExcessArguments
  // is the documented Commander 12+ escape hatch for this case.
  .allowExcessArguments(true)
  .showSuggestionAfterError(true);

// --- remember ---
// Two forms:
//   1. Explicit:  memesh remember --name "auth-decision" --type "decision" --obs "OAuth 2.0"
//   2. Quick:     memesh remember "OAuth 2.0 with PKCE"
// Quick form auto-generates name (date + slug) and defaults type to "note".
// The explicit form is the canonical contract; the quick form exists to
// reduce first-use friction since fresh users naturally try the one-arg
// shape before reading the README.
program
  .command('remember')
  .argument('[text]', 'Quick-capture text — auto-generates name and uses type=note')
  .description('Store knowledge as an entity (use flags for explicit form, or positional text for quick capture)')
  .option('--name <name>', 'Entity name')
  .option('--type <type>', 'Entity type')
  .option('--title <title>', 'Short human-readable label shown as the headline (name stays the stable machine key)')
  .option('--obs <observations...>', 'Observations (space-separated)')
  .option('--tags <tags...>', 'Tags (space-separated)')
  .option('--namespace <namespace>', 'Namespace: personal, team, or global. On a NEW memory this places it (default personal); on one that already exists it MOVES it out of the scope it is in — omit the flag to leave it alone.')
  // The two relation types that DO something. MCP and HTTP callers could state
  // them through `relations`; the CLI had no way to state any relation at all,
  // so `contradicts` — the thing every recall checks for — was unreachable from
  // the terminal, and `memesh recall` always answered "no conflicts" for anyone
  // who only used the CLI. Inert labels are not offered here: they would just be
  // tags with extra steps.
  .option('--supersedes <name...>', 'This memory replaces the named one — ARCHIVES it immediately (recoverable; nothing is deleted)')
  .option('--contradicts <name...>', 'This memory cannot both be true with the named one — both surface as a conflict on every recall')
  .option('--json', 'Output as JSON')
  .action(async (text, opts) => {
    requireOneOf(opts.namespace, NAMESPACES, '--namespace');
    // Resolve quick-capture form into name/type/obs.
    //
    // Each invocation produces a UNIQUE name. The earlier scheme used
    // `quick-<date>-<slug>` which is deterministic by day + first 40
    // chars of text — two calls of `memesh remember "fixed bug"` on
    // the same day would collide and `remember()` would silently merge
    // them into one entity (it appends observations on duplicate
    // name). For a journal/quick-capture flow, that's data loss.
    // Append a short random suffix so each call is a new entity.
    if (text && !opts.name && !opts.type) {
      const slug = String(text)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
      const date = new Date().toISOString().slice(0, 10);
      const suffix = randomBytes(3).toString('hex'); // 6 hex chars = 16M outcomes
      opts.name = `quick-${date}-${slug || 'note'}-${suffix}`;
      opts.type = 'note';
      // The quick-capture text IS the human title — the generated name above
      // is exactly the machine-key noise titles exist to replace. Slice to
      // the transport max; an explicit --title still wins.
      if (!opts.title) opts.title = String(text).slice(0, 200);
      // Same rule as the flag form below: positional text is an observation,
      // never dropped. Without the else, `remember "content" --obs "note"`
      // discarded the content while naming the entity after it.
      if (!opts.obs || opts.obs.length === 0) opts.obs = [String(text)];
      else opts.obs = [...opts.obs, String(text)];
    } else if (text) {
      // Positional text ALONGSIDE flags used to be dropped on the floor:
      // `memesh remember "the content" --name x --type note` reported
      // "Stored (0 observations)" — success, with the user's content gone.
      // The intent is unambiguous: the text is the observation.
      if (!opts.obs || opts.obs.length === 0) opts.obs = [String(text)];
      else opts.obs = [...opts.obs, String(text)];
    }
    if (!opts.name || !opts.type) {
      console.error(
        'Error: provide --name and --type, OR pass quick-capture text as a positional arg.\n' +
        '  memesh remember --name "auth" --type "decision" --obs "Use OAuth 2.0"\n' +
        '  memesh remember "Use OAuth 2.0 with PKCE"'
      );
      process.exit(1);
    }

    const relations = [
      ...((opts.supersedes ?? []) as string[]).map(to => ({ to, type: 'supersedes' })),
      ...((opts.contradicts ?? []) as string[]).map(to => ({ to, type: 'contradicts' })),
    ];

    await withDatabase(async () => {
      const result = remember({
        name: opts.name,
        type: opts.type,
        title: opts.title,
        observations: opts.obs,
        tags: opts.tags,
        namespace: opts.namespace,
        relations: relations.length > 0 ? relations : undefined,
        sourceHost: 'cli',
      });
      if (opts.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(`✅ Stored "${result.name}" (${result.observations} observations, ${result.tags} tags)`);
        // A move drops the memory out of every scoped view it used to appear
        // in, so it is never silent.
        if (result.movedFromNamespace) {
          console.log(`   moved: ${result.movedFromNamespace} → ${opts.namespace} (was in ${result.movedFromNamespace}; re-run with --namespace ${result.movedFromNamespace} to put it back)`);
        }
        // A relation to a target that does not exist is reported, not
        // swallowed: `remember()` collects those into relationErrors, and the
        // consequence the user asked for (an archive, a conflict flag) did not
        // happen.
        if (result.superseded?.length) {
          console.log(`   archived as superseded: ${result.superseded.join(', ')}`);
        }
        // From what was CREATED, never from what was requested. Subtracting the
        // error count from the request count only tells you whether SOMETHING
        // succeeded: with one good and one bad target it printed both, naming a
        // conflict that does not exist two lines above the error saying so.
        const contradicted = (result.relationsCreated ?? [])
          .filter(r => r.type === 'contradicts')
          .map(r => r.to);
        if (contradicted.length > 0) {
          console.log(`   conflicts stated: ${contradicted.join(', ')}`);
        }
        for (const err of result.relationErrors ?? []) console.error(`   ⚠️  ${err}`);
      }
      if (result.relationErrors?.length) process.exitCode = 1;
      await flushPendingEmbeddings();
    });
  });

// --- recall ---
program
  .command('recall')
  .description('Search stored knowledge')
  .argument('[query]', 'Search query')
  .option('--tag <tag>', 'Filter by tag')
  .option('--limit <n>', 'Max results', '20')
  .option('--include-archived', 'Include archived entities')
  .option('--namespace <namespace>', 'Filter by namespace: personal, team, or global')
  .option('--cross-project', 'Search across all project tags (ignores --tag filter)')
  .option('--json', 'Output as JSON')
  .action(async (query, opts) => {
    requireOneOf(opts.namespace, NAMESPACES, '--namespace');
    await withDatabase(async () => {
      // recallWithConflicts: FTS5 + sqlite-vec recall + conflict annotation,
      // owned by core so the transports can't drift on the wrapping rule.
      const { entities, conflicts, retrieval } = await recallWithConflicts({
        query: query || undefined,
        tag: opts.tag,
        limit: parseInt(opts.limit),
        include_archived: opts.includeArchived,
        namespace: opts.namespace,
        cross_project: opts.crossProject,
      });

      if (opts.json) {
        // One envelope shape, always — the old output was a bare array
        // normally and an object when conflicts existed, so every consumer
        // had to special-case it; and it had nowhere to carry `retrieval`,
        // which is the point (a degraded or limit-full recall must say so
        // in-band). MCP and HTTP already answer with this object envelope.
        console.log(JSON.stringify(
          conflicts.length > 0 ? { entities, retrieval, conflicts } : { entities, retrieval },
        ));
      } else if (entities.length === 0) {
        console.log('No results found.');
      } else {
        // Semantic-only result sets get an honest header instead of being
        // dressed as matches: the junk-vs-genuine distance distributions
        // overlap (see Entity.match), so when the keyword index found
        // NOTHING, "closest by meaning" is the most this output can claim.
        const allSemantic = query && entities.every((e) => e.match?.source === 'semantic');
        if (allSemantic) {
          console.log('No keyword matches. Closest memories by meaning — may be unrelated:');
        }
        for (const e of entities) {
          const badge = e.archived ? ' [archived]' : '';
          const semantic = e.match?.source === 'semantic'
            ? ` (~${Math.round((e.match.relevance ?? 0) * 100)}% semantic)`
            : '';
          console.log(`  ${e.name}${badge} (${e.type})${semantic}`);
          for (const obs of e.observations.slice(0, 3)) {
            // Display cap only — storage is untouched. A single 324KB
            // observation used to flood the terminal on every hit.
            let shown = obs;
            if (obs.length > 500) {
              let head = obs.slice(0, 500);
              // Don't cut a surrogate pair in half — a trailing lone high
              // surrogate prints as a broken glyph.
              if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
              shown = `${head} … (+${obs.length - head.length} more chars)`;
            }
            console.log(`    - ${shown}`);
          }
          if (e.observations.length > 3) {
            console.log(`    ... +${e.observations.length - 3} more`);
          }
        }
        const truncatedNote = retrieval.truncated ? ' (limit reached — more may exist)' : '';
        console.log(`\n${entities.length} result(s)${truncatedNote}`);
        if (retrieval.degraded) {
          // Embeddings are configured but the vector side could not run —
          // silence here is exactly the fake-working shape this line removes.
          console.log('Warning: semantic search unavailable right now — keyword-only results (degraded). Run `memesh doctor` to see why.');
        }
        if (conflicts.length > 0) {
          console.log('\nWarning: Conflicts detected:');
          for (const c of conflicts) {
            console.log(`  ${c}`);
          }
        }
      }
    });
  });

// --- forget ---
program
  .command('forget')
  .description('Archive an entity or remove an observation (soft-delete, recoverable)')
  .requiredOption('--name <name>', 'Entity name')
  .option('--observation <text>', 'Remove specific observation only')
  .option('--json', 'Output as JSON')
  // Accept --confirm as a no-op for forward-compat. Users hitting forget
  // for the first time often type `--confirm` by analogy with `rm -i` /
  // `git branch -D` and got "unknown option" before. Soft-archive doesn't
  // need a confirmation gate, but rejecting the flag is hostile UX. Silent
  // accept matches the principle of least surprise.
  .option('--confirm', '[deprecated, no-op] forget is a soft archive — no confirmation needed')
  .action(async (opts) => {
    await withDatabase(() => {
      const result = forget({
        name: opts.name,
        observation: opts.observation,
      });
      if (opts.json) {
        console.log(JSON.stringify(result));
      } else if (result.archived) {
        console.log(`📦 Archived "${opts.name}"`);
      } else if (result.observation_removed) {
        console.log(`✂️  Removed observation (${result.remaining_observations} remaining)`);
      } else if (opts.observation && result.entity_found) {
        // The entity is there; the quoted text just did not match. Saying "not
        // found" sent the user to re-create a memory that already exists — the
        // one action guaranteed to make it worse.
        console.log(`Entity "${opts.name}" has no observation matching that text (${result.remaining_observations} observation(s) present).`);
        console.log(`See them with: memesh recall "${opts.name}" --json`);
        process.exitCode = 1;
      } else {
        // `pin` already exits 1 here, with a comment explaining that a pin
        // which pinned nothing is invisible to scripts. A forget that forgot
        // nothing is the same.
        console.log(`Entity "${opts.name}" not found`);
        process.exitCode = 1;
      }
    });
  });

// --- pin / unpin ---
// Both commands differ only in the pinned flag and the success message, so a
// single registrar keeps them in lockstep.
function registerPinCommand(name: string, description: string, pinned: boolean, onFound: (entity: string) => string): void {
  program
    .command(name)
    .description(description)
    .requiredOption('--name <name>', 'Entity name')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      await withDatabase(() => {
        const result = setPinned(opts.name, pinned);
        if (opts.json) console.log(JSON.stringify(result));
        else console.log(result.found ? onFound(opts.name) : `Entity "${opts.name}" not found`);
        // A pin that pinned nothing exiting 0 is invisible to scripts — the
        // protection the user asked for silently does not exist.
        if (!result.found) process.exitCode = 1;
      });
    });
}

registerPinCommand('pin', 'Protect an entity from the dreamer’s auto-compaction', true,
  (e) => `📌 Pinned "${e}" — the dreamer will not compact it`);
registerPinCommand('unpin', 'Allow the dreamer to auto-compact an entity again', false,
  (e) => `📍 Unpinned "${e}"`);

// --- consolidate (retired) ---
// The command is kept only to say it is gone. Deleting it outright makes
// Commander answer `memesh consolidate` with "unknown command", which reads as
// a typo or a broken install and tells a user nothing about where their
// compression went. This block is deletable at the next major.
//
// What it used to do: delete an entity's observations and write an LLM summary
// in their place, immediately, with no proposal and no way back. It also
// ignored pins, and reset confidence to 1.0 on success. `memesh dream` is the
// reviewed form of the same idea, so nothing here points at a like-for-like
// replacement -- see `dream --help`.
program
  .command('consolidate')
  .description('(retired) Use `memesh dream` — see the message this prints')
  .allowUnknownOption()
  .action(() => {
    console.error('`memesh consolidate` has been retired.');
    console.error('');
    console.error('It rewrote a memory with an LLM summary and deleted the originals on the spot —');
    console.error('no proposal, no review, and nothing to restore from if the summary was wrong.');
    console.error('');
    console.error('`memesh dream` is the reviewed version of the same idea:');
    console.error('  memesh dream run       propose digests for clusters of noisy memories');
    console.error('  memesh dream list      see what it proposed');
    console.error('  memesh dream accept <id> / reject <id>');
    console.error('');
    console.error('Nothing is changed until you accept a proposal, and sources are archived');
    console.error('rather than deleted. It works on episodic memories (commits, session notes)');
    console.error('and never touches lessons, decisions, architecture notes, or pinned entities —');
    console.error('so it is not a like-for-like replacement for compressing one named entity.');
    process.exitCode = 1;
  });

// --- verify / patterns (retired) ---
// Removed with the agentic-orchestration experiment. Deleting the commands
// outright would make Commander answer "unknown command", which reads as a
// broken install rather than a deliberate retirement — the exact failure mode
// the consolidate signpost above exists to prevent. Same convention: a
// signpost that names what happened and where to go, exiting non-zero so a
// script gating on `memesh verify … && deploy` fails loudly instead of
// deploying on a command that no longer checks anything.
program
  .command('verify')
  .description('(retired) Removed with the agentic-orchestration experiment — see the message this prints')
  .allowUnknownOption()
  .action(() => {
    console.error('`memesh verify` has been retired, along with the agentic-orchestration experiment.');
    console.error('');
    console.error('It recorded a verification report for background-agent work. The protocol it');
    console.error('served was removed without ever leaving opt-in. Run your own verification');
    console.error('(typecheck / tests / lint) and store conclusions with `memesh remember` if you');
    console.error('want them remembered. Existing verification_record entities are untouched.');
    process.exitCode = 1;
  });

program
  .command('patterns')
  .description('(retired) Removed with the agentic-orchestration experiment — see the message this prints')
  .allowUnknownOption()
  .action(() => {
    console.error('`memesh patterns` has been retired, along with the agentic-orchestration experiment.');
    console.error('');
    console.error('It displayed the experiment\'s local skill-usage telemetry, which is no longer');
    console.error('written. A leftover ~/.memesh/skill-usage.jsonl is inert and safe to delete.');
    console.error('For work-pattern insights, use the `user_patterns` MCP tool or GET /v1/patterns.');
    process.exitCode = 1;
  });

// --- export ---
program
  .command('export')
  .description('Export memories as JSON. Defaults to stdout (pipe-friendly); use `-o <file>` to write directly.')
  .option('--tag <tag>', 'Export only entities with this tag')
  .option('--namespace <ns>', 'Export only from this namespace (personal, team, global)')
  .option('--limit <n>', 'Max entities to export', '1000')
  .option('-o, --out <file>', 'Write JSON to <file> instead of stdout. Parent directory must exist.')
  .action(async (opts) => {
    requireOneOf(opts.namespace, NAMESPACES, '--namespace');
    await withDatabase(() => {
      const result = exportMemories({
        tag: opts.tag,
        namespace: opts.namespace,
        limit: parseInt(opts.limit),
      });
      const json = JSON.stringify(result, null, 2);
      if (opts.out) {
        // Check the parent directory first. "ENOENT surfaces through commander
        // with the path in the message" was the intent; what reached the user
        // was a raw `node:fs` frame dump with ten stack lines and the absolute
        // install path. The help already states the precondition ("Parent
        // directory must exist") — it just never checked it.
        const outDir = path.dirname(path.resolve(opts.out));
        if (!fs.existsSync(outDir)) {
          console.error(`Error: cannot write ${opts.out} — the directory ${outDir} does not exist.`);
          console.error(`       Create it first (mkdir -p "${outDir}"), or drop -o to write to stdout.`);
          process.exit(1);
        }
        // Synchronous write so the CLI exits with a deterministic
        // success/error code.
        fs.writeFileSync(opts.out, json + '\n');
        process.stderr.write(`✅ Exported ${result.entity_count} entities to ${opts.out}\n`);
      } else {
        console.log(json);
      }
    });
  });

// --- import ---
program
  .command('import')
  .description('Import memories from a JSON export file')
  .argument('<file>', 'Path to JSON export file')
  .option('--namespace <ns>', 'Override namespace for all imported entities')
  .option('--merge <strategy>', 'Merge strategy: skip | overwrite | append', 'skip')
  .action(async (file, opts) => {
    requireOneOf(opts.merge, ['skip', 'overwrite', 'append'], '--merge');
    requireOneOf(opts.namespace, NAMESPACES, '--namespace');
    await withDatabase(() => {
      // DX: catch the failures new users hit first (missing file,
      // malformed JSON) and produce problem+cause+fix output instead
      // of a raw stack trace. The previous behaviour leaked
      // `<anonymous_script>:1` and `at JSON.parse (<anonymous>)`.
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          console.error(`Error: file not found: ${file}`);
          console.error(`       memesh import expects a file produced by 'memesh export'.`);
          console.error(`       Try: memesh export > my-export.json && memesh import my-export.json`);
          process.exit(1);
        }
        if ((err as NodeJS.ErrnoException)?.code === 'EACCES') {
          console.error(`Error: cannot read ${file} (permission denied).`);
          console.error(`       Check file permissions: ls -la ${file}`);
          process.exit(1);
        }
        throw err;
      }

      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch (err) {
        const lineMatch = /position (\d+)/.exec(err instanceof Error ? err.message : '');
        const where = lineMatch ? ` near position ${lineMatch[1]}` : '';
        console.error(`Error: ${file} is not valid JSON${where}.`);
        console.error(`       memesh import expects a file produced by 'memesh export'.`);
        console.error(`       Try: memesh export > my-export.json && memesh import my-export.json`);
        process.exit(1);
      }

      let result;
      try {
        result = importMemories({
          data: data as ExportResult,
          namespace: opts.namespace,
          merge_strategy: opts.merge as MergeStrategy,
        });
      } catch (err) {
        // importMemories refuses a bundle it cannot read, and says why in one
        // sentence. Uncaught, that sentence arrived on top of a ten-frame Node
        // dump with the absolute install path — the same treatment the JSON
        // and ENOENT cases above already get.
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      console.log(`Imported: ${result.imported}, Skipped: ${result.skipped}, Appended: ${result.appended}`);
      if (result.errors.length > 0) {
        console.error(`Errors:\n  ${result.errors.join('\n  ')}`);
        process.exitCode = 1;
      }
    });
  });

// --- learn ---
program
  .command('learn')
  .description('Record a lesson from a mistake or discovery')
  .requiredOption('--error <text>', 'What went wrong')
  .requiredOption('--fix <text>', 'What fixed it')
  .option('--root-cause <text>', 'Why it happened')
  .option('--prevention <text>', 'How to prevent it next time')
  .option('--severity <level>', 'Severity: critical|major|minor', 'minor')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    requireOneOf(opts.severity, ['critical', 'major', 'minor'], '--severity');
    await withDatabase(() => {
      const result = learn({
        error: opts.error,
        fix: opts.fix,
        root_cause: opts.rootCause,
        prevention: opts.prevention,
        severity: opts.severity as LessonSeverity | undefined,
        sourceHost: 'cli',
      });
      if (opts.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(`Lesson recorded: ${result.name}`);
      }
    });
  });

// --- briefing ---
// The shell-reachable half of A1c. Claude Code gets this block pushed by the
// session-start hook; an MCP client gets it from the `briefing` tool; and an
// agent that has only a shell — the OpenClaw/Hermes integration pattern —
// gets it here. Same assembly, same fence, one owner (core/briefing.ts).
program
  .command('briefing')
  .description('The assembled work topology for a project — task state, decisions, lessons, knowledge, recent activity')
  .option('--project <name>', 'Project name (default: the current directory’s project)')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    await withDatabase(() => {
      const result = assembleBriefing(opts.project);
      if (opts.json) {
        console.log(JSON.stringify(result));
        return;
      }
      if (!result.text) {
        console.log(
          `No memories for "${result.project}" yet.\n` +
          `Capture happens automatically as you work; or set the task state:  memesh task --goal "…"`,
        );
        return;
      }
      console.log(result.text);
    });
  });

// --- why ---
//
// File attribution: local git resolves WHICH commits touched the file (log,
// or blame for --line); the graph answers what memesh remembers about them.
// Every gap is a typed abstention rendered as a sentence below — a commit
// with no entity, or an entity with no session link, is reported as exactly
// that, never guessed around. The git half runs HERE, with the user's own
// cwd; the HTTP route takes hashes instead (see WhySchema).
const WHY_ABSTENTION_TEXT: Record<string, string> = {
  git_unavailable: 'git is not installed or not on PATH — commit attribution unavailable.',
  not_a_git_repo: 'Not inside a git repository — commit attribution unavailable.',
  file_not_tracked: 'File is not tracked by git — commit attribution unavailable.',
  history_unreadable: "git could not read this file's history (too much output, too slow, or the repository has no commits yet) — nothing is listed because the question went unanswered, not because no commit touched the file.",
  no_commits_supplied: 'No commit hashes were supplied — only the file-tag half of this answer ran.',
  line_out_of_range: 'That line does not exist in the tracked file.',
  line_uncommitted: 'That line is not committed yet — nothing to attribute.',
  no_commit_entity: 'memesh has no memory of this commit (it predates capture, or was made without hooks / on another machine).',
  no_session_link: 'This commit was captured before commits recorded their session — the session link does not exist.',
};
program
  .command('why')
  .description('Explain a file: commits memesh remembers touching it, their sessions, and related memories')
  .argument('<file>', 'File path (relative to the current directory or absolute)')
  .option('--line <n>', 'Attribute one line via git blame instead of file history')
  .option('--limit <n>', 'Max commits to inspect', '10')
  .option('--json', 'Output as JSON')
  .action(async (file, opts) => {
    await withDatabase(async () => {
      const { resolveFileCommits, explainCommits } = await import('../../core/why.js');
      const cwd = process.cwd();
      // Both flags reach code that cannot defend itself against NaN, and each
      // failed differently and badly. `--limit abc` put NaN in a SQL LIMIT
      // and crashed with a raw `ERR_SQLITE_ERROR` stack trace carrying the
      // absolute install path. `--line abc` was worse than a crash: NaN
      // reached `git blame -L NaN,NaN`, the failure was caught, and the user
      // was told "That line does not exist in the tracked file." — an
      // affirmatively false statement from the one command whose whole
      // contract is that it abstains rather than guesses.
      const limit = parseInt(opts.limit, 10);
      const line = opts.line !== undefined ? parseInt(opts.line, 10) : undefined;
      for (const [flag, value] of [['--limit', limit], ['--line', line]] as const) {
        if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
          console.error(`Error: ${flag} needs a whole number of 1 or more.`);
          process.exit(1);
        }
      }
      const resolved = resolveFileCommits(cwd, file, { line, limit });
      const result = explainCommits(getDatabase(), {
        file,
        commits: resolved.commits,
        project: getProjectName(cwd),
        limit,
        abstentions: resolved.abstention ? [resolved.abstention] : [],
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`why ${result.file}  (project: ${result.project ?? 'all'})`);
      for (const code of result.abstentions) {
        console.log(`  ! ${WHY_ABSTENTION_TEXT[code] ?? code}`);
      }
      if (result.commits.length === 0 && result.abstentions.length === 0) {
        console.log('  No commits touch this file.');
      }
      for (const c of result.commits) {
        const head = [c.commit.hash.slice(0, 10), c.commit.date, c.commit.subject].filter(Boolean).join('  ');
        console.log(`\n  ${head}`);
        if (c.entity) {
          console.log(`    memory: ${c.entity.name} [mem:${c.entity.id}]`);
          for (const obs of c.entity.observations.slice(0, 3)) console.log(`      - ${obs}`);
        }
        if (c.session) {
          console.log(`    session: ${c.session.session_id}`);
          for (const s of c.session.entities) console.log(`      - ${s.name} (${s.type})`);
          // A capped page that says nothing reads as the whole session.
          if (c.session.truncated) {
            console.log(`      … first ${c.session.entities.length} of a larger session — more exist`);
          }
        }
        for (const code of c.abstentions) {
          console.log(`    ! ${WHY_ABSTENTION_TEXT[code] ?? code}`);
        }
      }
      const fm = result.file_memories.entities;
      if (fm.length > 0) {
        // Honest calibre: these are basename-tag associations, not commit-derived.
        console.log(`\n  Related by file tag (file:${result.basename} — associated, not commit-derived):`);
        for (const e of fm) console.log(`    - ${e.name} (${e.type})${e.title ? `: ${e.title}` : ''}`);
      }
    });
  });

// --- setup ---
//
// Machine-level wiring, which doctor structurally cannot do: doctor scopes
// every check to the COPY being invoked, so it cannot see a plugin install
// from the npm binary or vice versa. setup reads the HOSTS' own state
// (Claude Code's plugin registry and settings.json, Codex's and Gemini's
// MCP registries) and offers to wire whatever is present but unwired —
// through each host CLI's own `mcp add`, never by writing their config
// files directly.
program
  .command('setup')
  .description('Detect Claude Code / Codex / Gemini on this machine, wire memesh into each, and verify')
  .option('--check', 'Only report wiring status per host; change nothing (exit 1 if a present host is unwired)')
  .option('--yes', 'Apply every wiring action without asking')
  .action(async (opts) => {
    const { spawnSync, execFileSync } = await import('child_process');

    // Windows npm shims are .cmd files: execFileSync cannot spawn them
    // directly (no PATHEXT resolution -> ENOENT), so resolve the full path
    // via `where` and run .cmd through a shell. Every cmd/args pair here is
    // a fixed string from core/setup.ts -- nothing user-supplied.
    const runSeam = (cmd: string, args: string[]) => {
      try {
        let target = cmd;
        let useShell = false;
        if (process.platform === 'win32') {
          const resolved = execFileSync('where', [cmd], { encoding: 'utf8' }).split(/\r?\n/)[0]?.trim();
          if (resolved) { target = resolved; useShell = /\.(cmd|bat)$/i.test(resolved); }
        }
        const r = spawnSync(target, args, { encoding: 'utf8', shell: useShell });
        return { status: r.status, stderr: r.stderr ?? '' };
      } catch (err) {
        return { status: null, stderr: err instanceof Error ? err.message : String(err) };
      }
    };
    // isOnPath is the module-scope PATH walker upgrade-plugin already uses —
    // one predicate, no `which`/`where` subprocess per host.
    const seams: SetupSeams = { home: () => homeDir(), isOnPath, run: runSeam };

    const render = (statuses: HostStatus[]) => {
      for (const st of statuses) {
        if (!st.present) { console.log(`   ${st.title}: not found (looked for ${st.presenceDetail}) — skipped`); continue; }
        const mark = st.wired === true ? '✅' : st.wired === false ? '❌' : '❓';
        console.log(`${mark} ${st.title}: ${st.wiredDetail}`);
      }
    };

    let statuses = inspectHosts(seams);

    if (opts.check) {
      render(statuses);
      process.exit(allWired(statuses) ? 0 : 1);
    }

    const pending = statuses.filter((st) => st.present && st.actions.length > 0);
    if (pending.length === 0) {
      render(statuses);
      console.log(allWired(statuses)
        ? '\nEverything present is wired. Nothing to do.'
        : '\nNothing to wire automatically — see the lines above.');
      process.exit(allWired(statuses) ? 0 : 1);
    }

    render(statuses);
    console.log('\nPlanned actions:');
    for (const st of pending) for (const a of st.actions) {
      console.log(`  • [${st.title}] ${a.label}${a.cmd ? `\n      ${a.cmd} ${(a.args ?? []).join(' ')}` : ''}`);
    }

    // Non-interactive without --yes: show the plan, change nothing. The
    // confirmed path is --yes (or a TTY answering per action below) — the
    // same refuse-without---yes convention `demo --reset` uses.
    if (!opts.yes && !process.stdin.isTTY) {
      console.error('\nNot a terminal and --yes not given — nothing was changed. Re-run with: memesh setup --yes');
      process.exit(1);
    }

    const confirmAll = Boolean(opts.yes);
    let rl: import('node:readline/promises').Interface | null = null;
    if (!confirmAll) {
      const { createInterface } = await import('node:readline/promises');
      rl = createInterface({ input: process.stdin, output: process.stdout });
    }

    let failed = false;
    for (const st of pending) {
      for (const action of st.actions) {
        if (!confirmAll && rl) {
          const answer = (await rl.question(`\n[${st.title}] ${action.label} — proceed? [y/N] `)).trim().toLowerCase();
          if (answer !== 'y' && answer !== 'yes') { console.log('  skipped'); continue; }
        }
        if (action.kind === 'install-hooks') {
          console.log(`  ✅ ${wireUserHooks()}`);
        } else if (action.cmd) {
          const r = runSeam(action.cmd, action.args ?? []);
          if (r.status === 0) console.log(`  ✅ done (${action.cmd} ${(action.args ?? []).join(' ')})`);
          else { console.error(`  ❌ ${action.cmd} exited ${r.status ?? 'without running'}${r.stderr ? `: ${r.stderr.trim()}` : ''}`); failed = true; }
        }
      }
    }
    rl?.close();

    // Verify by re-reading the hosts, not by trusting the actions.
    console.log('\nAfter wiring:');
    statuses = inspectHosts(seams);
    render(statuses);
    process.exit(failed || !allWired(statuses) ? 1 : 0);
  });

// --- task ---
// The human-driven half of task-state. The MCP tool is how an agent records
// this mid-session; this is how you set it yourself, and how you check what
// the next session is about to be told.
program
  .command('task')
  .description('Show or update where the work stands on this project')
  .option('--project <name>', 'Project name (default: the current directory’s project)')
  .option('--goal <text>', 'What this work is FOR — the outcome being aimed at')
  .option('--next <text>', 'The next concrete step')
  .option('--blocked <text>', 'What is standing in the way (pass "" to clear it once resolved)')
  .option('--done <text>', 'What was just finished')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    await withDatabase(() => {
      // Which flags were PASSED, not which have text: `--blocked ""` is a
      // request to clear, and reading truthiness here would silently drop it.
      const patch: Partial<Record<TaskStateField, string>> = {};
      for (const field of TASK_STATE_FIELDS) {
        if (opts[field] !== undefined) patch[field] = opts[field] as string;
      }

      if (Object.keys(patch).length === 0) {
        const { project, state } = getTaskState(opts.project);
        if (opts.json) {
          console.log(JSON.stringify({ project, state }));
          return;
        }
        const lines = taskStateLines(state, project);
        if (lines.length === 0) {
          console.log(
            `Nothing recorded for "${project}" yet.\n` +
            `Set it with:  memesh task --goal "…" --next "…"`,
          );
          return;
        }
        console.log(lines.join('\n'));
        return;
      }

      const result = setTaskState({ project: opts.project, patch, sourceHost: 'cli' });
      if (opts.json) {
        console.log(JSON.stringify(result));
        return;
      }
      if (result.changed.length === 0) {
        console.log(`No change — "${result.project}" already said exactly that.`);
        return;
      }
      console.log(`Updated ${result.changed.join(', ')} for "${result.project}".`);
      console.log(taskStateLines(result.state, result.project).join('\n'));
    });
  });

// --- config ---
const configCmd = program.command('config').description('Manage configuration');

configCmd
  .command('list')
  .description('Show current configuration')
  .action(() => {
    const config = readConfig();
    const caps = detectCapabilities(config);
    console.log('Configuration (~/.memesh/config.json):');
    // Iterate ALLOWED_KEYS (the single source of truth for settable keys) so
    // `list` and `set` can't drift — previously `list` hard-coded only the
    // three llm.* keys, so a user who set sessionLimit / llmFallbacks /
    // embedder.* got "✅ Set" but saw no trace of it here.
    const rows = buildConfigListing(config as unknown as Record<string, unknown>);
    if (rows.length === 0) {
      console.log('  (no keys set — all defaults)');
    } else {
      for (const { key, value } of rows) console.log(`  ${key}: ${value}`);
    }
    console.log(`\nSearch level: ${caps.searchLevel} (${caps.searchLevel === 1 ? 'Smart Mode' : 'Core'})`);
  });

// Allowlist of nested keys we accept for set/unset. Each entry is
// the dotted path the user types. Anything outside this list is
// rejected — preferring an explicit allowlist keeps `memesh config`
// from accidentally writing arbitrary deep-nested junk into config.json.
//
// `aliases` lets the legacy `llm.api-key` (with hyphen) keep working
// while the canonical key (used everywhere in code) is `llm.apiKey`.
const SET_KEY_ALIASES: Record<string, string> = {
  'llm.api-key': 'llm.apiKey',
};

const ALLOWED_KEYS = new Set([
  'llm.provider',
  'llm.apiKey',
  'llm.model',
  'embedder.provider',
  // 'embedder.model' is deliberately absent — see EmbedderConfig in config.ts.
  // It printed "✅ Set" and changed nothing, because the value never reached the
  // embedding call.
  'autoUpdate',
  'sessionLimit',
  'autoCapture',
  // Cross-provider LLM failover. Shipped in v4.2.0 with a full consumer
  // side (config.ts, consolidator, dream, session-summary) but NO setter:
  // it was absent here and the dashboard never sent it, so the only way to
  // populate it was hand-editing config.json. Effectively every install ran
  // with `llmFallbacks: []`, meaning the failover feature never engaged for
  // anyone. Takes a JSON array because it is a list of provider objects.
  'llmFallbacks',
  // Output language for LLM-generated content (dreamer digests, patterns,
  // lessons, validator reasons). Free-form — 'zh-TW' and '繁體中文' both
  // work; it becomes a prompt instruction, not a parsed locale. Unset =
  // English. See src/core/output-language.ts.
  'language',
  // Transcript mining opt-in for the dreamer (B1-B4). Both doctor.ts and
  // the dream CLI tell users to run `memesh config set transcriptMining
  // true` — this entry is what makes that documented command actually
  // succeed (it was missing, so the printed fix exited 1 "Unknown key").
  'transcriptMining',
]);

const KEY_VALIDATORS: Record<string, (value: string) => string | null> = {
  'llm.provider': (v) => ['anthropic', 'openai', 'ollama'].includes(v) ? null : `must be one of: anthropic, openai, ollama`,
  'language': (v) => {
    if (v.trim().length === 0) return 'must not be blank — use `memesh config unset language` to clear it';
    if (v.length > MAX_LANGUAGE_LENGTH) return `must be ${MAX_LANGUAGE_LENGTH} characters or fewer (a language name or locale code)`;
    // The value lands inside every content-generating LLM prompt; a newline
    // would let it smuggle in a free-standing instruction line. Shared with
    // the HTTP write surface via languageValueError.
    return languageValueError(v);
  },
  'embedder.provider': (v) => ['openai', 'ollama'].includes(v) ? null : `must be one of: openai, ollama`,
  'autoUpdate': (v) => ['off', 'patch', 'minor', 'major'].includes(v) ? null : `must be one of: off, patch, minor, major`,
  'llmFallbacks': (v) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(v);
    } catch {
      return 'must be a JSON array, e.g. \'[{"provider":"openai","model":"gpt-4o-mini","apiKey":"sk-..."}]\'';
    }
    if (!Array.isArray(parsed)) return 'must be a JSON ARRAY of provider objects';
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return 'every entry must be an object like {"provider":"openai"}';
      }
      const provider = (entry as { provider?: unknown }).provider;
      if (!['anthropic', 'openai', 'ollama'].includes(String(provider))) {
        return `every entry needs provider = anthropic | openai | ollama (got ${JSON.stringify(provider)})`;
      }
    }
    return null;
  },
};

function setNested(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const part = path[i];
    if (typeof cur[part] !== 'object' || cur[part] === null) {
      cur[part] = {};
    }
    cur = cur[part] as Record<string, unknown>;
  }
  cur[path[path.length - 1]] = value;
}

/** Read a dotted path (mirror of setNested); undefined if any segment is absent. */
function getNested(obj: Record<string, unknown>, path: string[]): unknown {
  return path.reduce<unknown>(
    (cur, part) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined),
    obj,
  );
}

/** Marker shown in place of any secret in the `config list` dump. Full
 *  redaction (not maskApiKey's first4+last4) because `list` prints EVERY key
 *  including the whole fallback chain — a broad dump should reveal no key
 *  bytes at all, and it keeps the tainted value out of the log entirely. */
const REDACTED = '***';

/** Format a value for display, dropping every apiKey so no key bytes reach the
 *  log (same leak class as the HTTP config response). Secrets are removed from
 *  the value before it is stringified, not merely overwritten. */
function formatConfigValue(key: string, raw: unknown): string {
  if (key.toLowerCase().includes('key')) return REDACTED;
  if (key === 'llmFallbacks' && Array.isArray(raw)) {
    const redacted = raw.map((fb) => {
      if (fb && typeof fb === 'object') {
        // Destructure apiKey OUT so the raw value never flows into the result.
        const { apiKey, ...rest } = fb as Record<string, unknown>;
        return apiKey ? { ...rest, apiKey: REDACTED } : rest;
      }
      return fb;
    });
    return JSON.stringify(redacted);
  }
  if (typeof raw === 'object') return JSON.stringify(raw);
  return String(raw);
}

/**
 * Build the `config list` rows from ALLOWED_KEYS — the single source of truth
 * for settable keys — so `list` shows every key `set` accepts and the two can't
 * drift. Only keys that are actually present are listed.
 */
function buildConfigListing(config: Record<string, unknown>): Array<{ key: string; value: string }> {
  const rows: Array<{ key: string; value: string }> = [];
  for (const key of Array.from(ALLOWED_KEYS).sort()) {
    const raw = getNested(config, key.split('.'));
    if (raw === undefined || raw === null) continue;
    rows.push({ key, value: formatConfigValue(key, raw) });
  }
  return rows;
}

function deleteNested(obj: Record<string, unknown>, path: string[]): boolean {
  if (path.length === 0) return false;
  if (path.length === 1) {
    if (path[0] in obj) { delete obj[path[0]]; return true; }
    return false;
  }
  const head = path[0];
  if (typeof obj[head] !== 'object' || obj[head] === null) return false;
  const child = obj[head] as Record<string, unknown>;
  const removed = deleteNested(child, path.slice(1));
  // Prune empty parent so { llm: {} } doesn't linger after unsetting last key
  if (removed && Object.keys(child).length === 0) delete obj[head];
  return removed;
}

configCmd
  .command('set')
  .description('Set a config value (e.g. llm.provider, embedder.provider)')
  .argument('<key>', 'Config key — see `memesh config list` for valid keys')
  .argument('<value>', 'Config value')
  .action((key, value) => {
    const canonical = SET_KEY_ALIASES[key] ?? key;
    if (!ALLOWED_KEYS.has(canonical)) {
      console.error(`Unknown key: ${key}`);
      console.error(`Allowed keys: ${Array.from(ALLOWED_KEYS).sort().join(', ')}`);
      process.exit(1);
    }
    const validate = KEY_VALIDATORS[canonical];
    if (validate) {
      const err = validate(value);
      if (err) {
        console.error(`Invalid value for ${canonical}: ${err}`);
        process.exit(1);
      }
    }
    // Coerce numeric string values for keys that take numbers
    let coerced: unknown = value;
    if (canonical === 'sessionLimit') coerced = parseInt(value, 10);
    if (canonical === 'llmFallbacks') coerced = JSON.parse(value);
    if (canonical === 'autoCapture') {
      coerced = value === 'true' || value === '1';
    }
    if (canonical === 'transcriptMining') {
      // The consumer (isTranscriptMiningEnabled) checks `=== true`, so a
      // raw "true" string would silently leave the feature off.
      coerced = value === 'true' || value === '1';
    }

    const config = readConfig() as Record<string, unknown>;
    setNested(config, canonical.split('.'), coerced);
    writeConfig(config as never);
    const displayValue = canonical.toLowerCase().includes('key') ? maskApiKey(String(value)) : String(value);
    console.log(`✅ Set ${canonical} = ${displayValue}`);

    // A key without a provider configures nothing. Say so here, where the user
    // is looking, instead of letting them discover it from features that
    // quietly do nothing.
    if (canonical === 'llm.apiKey' && !(config.llm as { provider?: string } | undefined)?.provider) {
      console.log('⚠️  No llm.provider is set, so this key is not used yet and LLM features stay off.');
      console.log('    Set one with: memesh config set llm.provider <anthropic|openai|ollama>');
    }
  });

configCmd
  .command('unset')
  .description('Remove a config value (supports nested keys like llm.apiKey)')
  .argument('<key>', 'Config key — see `memesh config list` for valid keys')
  .action((key) => {
    const canonical = SET_KEY_ALIASES[key] ?? key;
    if (!ALLOWED_KEYS.has(canonical)) {
      console.error(`Unknown key: ${key}`);
      console.error(`Allowed keys: ${Array.from(ALLOWED_KEYS).sort().join(', ')}`);
      process.exit(1);
    }
    const config = readConfig() as Record<string, unknown>;
    const removed = deleteNested(config, canonical.split('.'));
    if (!removed) {
      console.log(`(no change — ${canonical} was not set)`);
      return;
    }
    writeConfig(config as never);
    console.log(`✅ Removed ${canonical}`);
  });

// --- export-schema ---
program
  .command('export-schema')
  .description('Export MeMesh tools in OpenAI function calling format')
  .option('--format <format>', 'Output format (openai)', 'openai')
  .action(async (opts) => {
    const { exportOpenAITools } = await import('../../core/schema-export.js');
    if (opts.format === 'openai') {
      console.log(JSON.stringify(exportOpenAITools(), null, 2));
    } else {
      console.error(`Unknown format: ${opts.format}. Available: openai`);
      process.exit(1);
    }
  });

// --- demo (seed onboarding tour) ---
//
// SDD plan SPEC-4: a fresh install (entity_count = 0) renders a
// dashboard full of empty charts. `memesh demo` populates 30 curated
// entities so the user can immediately see Browse / Lessons / Roadmap
// behaving with real shape. Every demo entity carries
// `metadata.demo = true` so `memesh demo --reset --yes` strips the
// tour cleanly without touching anything the user captured for real.
program
  .command('demo')
  .description('Seed (or reset) a 30-entity onboarding tour')
  .option('--reset', 'Remove every entity tagged metadata.demo = true')
  .option('--yes', 'Skip confirmation prompt for --reset')
  .action(async (opts) => {
    await withDatabase(async () => {
      const { seedDemo } = await import('../../core/demo.js');
      const db = getDatabase();
      if (opts.reset) {
        if (!opts.yes) {
          console.error('memesh demo --reset is destructive. Re-run with --yes to confirm.');
          process.exit(1);
        }
        const result = seedDemo(db, { reset: true });
        console.log(`✓ Removed ${result.removed} demo entit${result.removed === 1 ? 'y' : 'ies'}.`);
        return;
      }
      const result = seedDemo(db);
      if (result.inserted === 0) {
        console.log('Demo data already present — re-run with --reset --yes first if you want to refresh.');
        return;
      }
      console.log(`✓ Seeded ${result.inserted} demo entit${result.inserted === 1 ? 'y' : 'ies'} tagged project:memesh-demo.`);
      console.log('  Open the dashboard (memesh serve) and tour Browse / Lessons / Graph / Analytics.');
      console.log('  Wipe with: memesh demo --reset --yes');
    });
  });

// --- serve (start HTTP server) ---
program
  .command('serve')
  .description('Start the HTTP API server and web dashboard')
  .option('--port <port>', 'Port number', '3737')
  .option('--host <host>', 'Host to bind', '127.0.0.1')
  // The token sentence is conditional and used not to say so. Auth is keyed to
  // the bind ADDRESS, not to this flag: `--allow-remote` on the default
  // 127.0.0.1 generates no token and requires none, while the help promised
  // both. Measured: `/v1/entities` answered 200 unauthenticated.
  .option('--allow-remote', 'Permit binding to a non-loopback host. Pair it with --host; on a non-loopback bind a bearer token is generated and REQUIRED for every /v1 request, and the startup output says where it lives. On the default loopback host this flag changes nothing.')
  .action(async (opts) => {
    const { startServer } = await import('../http/server.js');
    try {
      // autoUpdateCheck: a user-launched serve is online by definition, so it
      // fills the npm update cache itself instead of nagging the user to.
      startServer(opts.host, parseInt(opts.port, 10), { allowRemote: opts.allowRemote, autoUpdateCheck: true });
    } catch (err) {
      // startServer refuses a non-loopback bind without an opt-in, and the
      // refusal is a good actionable sentence. Thrown out of an async action
      // it became an unhandled rejection: the sentence arrived buried in a
      // Node stack dump with three absolute install paths.
      console.error(`MeMesh: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// --- update ---
program
  .command('update')
  .description('Update MeMesh to latest version (npm global installs)')
  .action(async () => {
    const { getCurrentInstallChannel, getInstallChannelSupport } = await import('../../core/install-channel.js');
    const install = getCurrentInstallChannel({ packageRoot });
    const installSupport = getInstallChannelSupport(install);

    if (!installSupport.canSelfUpdate) {
      console.error(`❌ memesh update does not support this install method (${installSupport.label}).`);
      console.error(`   ${installSupport.guidance}`);
      process.exit(1);
    }

    const { checkForUpdate } = await import('../../core/version-check.js');
    const check = await checkForUpdate(pkg.version);

    if (!check.checkSucceeded || !check.latestVersion) {
      console.error('❌ Unable to check npm for the latest MeMesh version right now.');
      console.error('   Try again later, or update manually: npm install -g @pcircle/memesh@latest');
      process.exit(1);
    }

    if (!check.updateAvailable) {
      console.log(`✅ Already on latest version (${pkg.version})`);
      return;
    }

    console.log(`🔄 Updating ${pkg.version} → ${check.latestVersion}...`);

    try {
      const { runGlobalUpdate } = await import('../../core/updater.js');
      const result = runGlobalUpdate(check.latestVersion);
      console.log(`✅ Updated to ${result.installedVersion}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      console.error(`❌ Update failed: ${message}`);
      console.error('   This command supports npm global installs.');
      console.error('   Try manually: npm install -g @pcircle/memesh@latest');
      process.exit(1);
    }
  });

// --- upgrade-plugin ---
//
// Claude Code's plugin marketplace pins versions at install time and never
// auto-updates. The bundled scripts/upgrade-plugin.sh closes that gap, but
// reaching it meant hand-substituting the installed version into
// ~/.claude/plugins/cache/pcircle-memesh/memesh/<version>/scripts/... — a
// path shape most users get wrong on the first try. This command finds the
// newest installed plugin version itself, checks the script's prerequisites
// up front (the script hard-requires node, npm and rsync and would otherwise
// die partway through), and runs it with the script's own exit code.
program
  .command('upgrade-plugin')
  .description('Upgrade the Claude Code plugin install (finds and runs its bundled upgrade script)')
  .action(async () => {
    const { spawnSync } = await import('child_process');
    const cacheRoot = path.join(homeDir(), '.claude', 'plugins', 'cache', 'pcircle-memesh', 'memesh');

    // The cache holds one directory per installed version. Only
    // version-shaped names count, so a stray directory can never win the
    // sort below.
    let versions: string[] = [];
    try {
      versions = fs.readdirSync(cacheRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+/.test(entry.name))
        .map((entry) => entry.name);
    } catch { /* ENOENT — no plugin cache at all; the empty list says so below */ }

    if (versions.length === 0) {
      console.error('No Claude Code plugin install found (looked in ~/.claude/plugins/cache/pcircle-memesh).');
      console.error('If you installed via npm, upgrade with: memesh update');
      process.exit(1);
    }

    // The highest installed version carries the newest copy of the upgrade
    // script. `numeric: true` compares dotted segments as numbers, so 4.10.0
    // sorts above 4.9.0 where a plain string sort would not.
    versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const newest = versions[versions.length - 1];
    const script = path.join(cacheRoot, newest, 'scripts', 'upgrade-plugin.sh');
    if (!fs.existsSync(script)) {
      console.error(`Plugin install found (v${newest}), but it has no scripts/upgrade-plugin.sh — plugin versions before 4.2.5 shipped without it.`);
      console.error('Reinstall once from the Claude Code /plugin UI, or run the npm-global copy directly:');
      console.error('  bash "$(npm prefix -g)/lib/node_modules/@pcircle/memesh/scripts/upgrade-plugin.sh"');
      process.exit(1);
    }

    // Same three tools the script itself demands, checked BEFORE it runs.
    const installHints: Record<string, string> = {
      node: 'node is required by the upgrade script. Install Node.js from https://nodejs.org',
      npm: 'npm is required by the upgrade script. It ships with Node.js — reinstall from https://nodejs.org',
      rsync: 'rsync is required by the upgrade script. macOS: already installed; Debian/Ubuntu: sudo apt install rsync',
    };
    const missing = Object.keys(installHints).filter((tool) => !isOnPath(tool));
    if (missing.length > 0) {
      for (const tool of missing) console.error(installHints[tool]);
      process.exit(1);
    }

    const run = spawnSync('bash', [script], { stdio: 'inherit' });
    if (run.error) {
      console.error(`Could not run the upgrade script: ${run.error.message}`);
      console.error('bash is required to run it. If bash is available under another name, run it yourself:');
      console.error(`  bash ${script}`);
      process.exit(1);
    }
    // The script's exit code is the verdict; pass it through unchanged.
    // A signal kill leaves status null — report failure, not success.
    process.exit(run.status ?? 1);
  });

// --- telemetry ---
//
// Exposes the contents of the `llm_telemetry` table written by every
// callLLM attempt across the 5 Smart-Mode flows. Lets a user answer
// "is my LLM pipeline actually working?" without diving into SQLite —
// surfaces the same data the Insights / Analytics dashboard tabs
// will consume programmatically. Default window is 30 days.
program
  .command('telemetry')
  .description('Show LLM call telemetry (per-flow scorecard for the last N days)')
  .option('--window <days>', 'Look-back window in days (default 30)', (v) => parseInt(v, 10), 30)
  .option('--prune <days>', 'Delete rows older than N days BEFORE rendering (closes v4.2.0 retention gap)', (v) => parseInt(v, 10))
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    // `--window abc` parses to NaN, which reached `new Date(NaN).toISOString()`
    // and threw a RangeError with a stack trace. Commander's parser cannot
    // reject it, so the check belongs here.
    for (const [flag, value] of [['--window', opts.window], ['--prune', opts.prune]] as const) {
      if (value !== undefined && !Number.isFinite(value)) {
        console.error(`Error: ${flag} needs a number of days.`);
        process.exit(1);
      }
    }
    await withDatabase(async () => {
      const { summariseTelemetry, pruneTelemetry } = await import('../../core/llm-telemetry.js');
      let pruneResult: { deletedRows: number; cutoffIso: string; totalRowsAfter: number } | null = null;
      if (typeof opts.prune === 'number' && Number.isFinite(opts.prune) && opts.prune >= 0) {
        pruneResult = pruneTelemetry({ olderThanDays: opts.prune });
      }
      const summaries = summariseTelemetry(opts.window);
      if (opts.json) {
        console.log(JSON.stringify({ pruned: pruneResult, summaries }, null, 2));
        return;
      }
      if (pruneResult) {
        console.log(`Pruned ${pruneResult.deletedRows} row${pruneResult.deletedRows === 1 ? '' : 's'} older than ${opts.prune} days.`);
        console.log('');
      }
      if (summaries.length === 0) {
        console.log(`No LLM telemetry recorded in the last ${opts.window} days.`);
        console.log(`(Smart-Mode flows write rows automatically — run \`memesh dream run\`, \`memesh dream patterns\`, or trigger a session with errors to populate.)`);
        return;
      }
      console.log(`LLM telemetry — last ${opts.window} days`);
      console.log('');
      for (const s of summaries) {
        const successRate = s.total_attempts > 0 ? Math.round((s.successes / s.total_attempts) * 100) : 0;
        console.log(`▸ ${s.flow}`);
        console.log(`    calls:        ${s.total_calls} (${s.total_attempts} provider attempts)`);
        console.log(`    success rate: ${successRate}%  (${s.successes} ok, ${s.failures} failed)`);
        if (s.fallback_used > 0) {
          console.log(`    fallback used: ${s.fallback_used} time${s.fallback_used === 1 ? '' : 's'}  ⚠️  primary failed`);
        }
        if (s.median_latency_ms != null) {
          console.log(`    median latency: ${s.median_latency_ms}ms`);
        }
        const okFail = (rec: Record<string, { ok: number; fail: number }>) =>
          Object.entries(rec).map(([k, v]) => `${k}=${v.ok}/${v.ok + v.fail}`).join(', ');
        const providers = okFail(s.by_provider);
        if (providers) console.log(`    by provider:  ${providers}`);
        const models = okFail(s.by_model);
        if (models) console.log(`    by model:     ${models}`);
        const projects = okFail(s.by_project);
        if (projects) console.log(`    by project:   ${projects}`);
        const errors = Object.entries(s.by_error_class);
        if (errors.length > 0) {
          const errStr = errors.sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}=${n}`).join(', ');
          console.log(`    error classes: ${errStr}`);
        }
        if (s.sample_errors.length > 0) {
          console.log(`    recent errors:`);
          for (const e of s.sample_errors) {
            console.log(`      • [${e.error_class ?? 'unknown'}] ${e.message.slice(0, 100)}`);
          }
        }
        console.log('');
      }
    });
  });

// --- kg backfill ---
//
// Heuristic relation backfill — fixes the orphan-entity problem in
// the KG without an LLM call. Two rules: tag co-occurrence (≥ 2
// shared topical tags → `related-to`) and project clustering
// (orphan lesson / decision in project X → `belongs-to-project`
// edge to the most-recent release / feature in that project).
const kgCmd = program
  .command('kg')
  .description('Knowledge graph maintenance');

kgCmd
  .command('backfill-relations')
  .description('Propose / apply heuristic relations to connect orphan entities (no LLM)')
  .option('--project <name>', 'Restrict to one project')
  .option('--dry-run', 'Show proposals without writing (default off — use to preview)')
  .option('--max-per-source <n>', 'Max edges per orphan (default 3)', (v) => parseInt(v, 10), 3)
  .option('--min-shared-tags <n>', 'Min shared topical tags to gate co-occurrence rule (default 2)', (v) => parseInt(v, 10), 2)
  .option('--include-archived', 'Also process archived entities')
  .option('--session-cooccurrence', 'Rule 3: link high-signal orphans co-created in the same session')
  .option('--name-tokens', 'Rule 4: link orphans sharing ≥3 name content tokens (or Jaccard ≥ 0.50)')
  .option('--min-jaccard <n>', 'Jaccard threshold for name similarity (default 0.50)', parseFloat)
  .option('--all-rules', 'Enable all heuristic rules (Rules 1–5)')
  .option('--no-evidence-links', 'Disable Rule 5: evidence → work-item links via shared session id (on by default — these edges feed the graph\'s evidence badges)')
  .option('--reset-idempotency', 'Clear the persistent "already-attempted" orphan cache before running (use after schema changes or to reconsider every orphan)')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    await withDatabase(async () => {
      const { backfillRelations, proposeBackfillCandidates } = await import('../../core/kg-backfill.js');
      const allRules = !!opts.allRules;
      const baseOpts = {
        project: opts.project,
        maxEdgesPerSource: opts.maxPerSource,
        minSharedTags: opts.minSharedTags,
        includeArchived: !!opts.includeArchived,
        dryRun: !!opts.dryRun,
        includeSessionCooccurrence: allRules || !!opts.sessionCooccurrence,
        includeNameTokenSimilarity: allRules || !!opts.nameTokens,
        // Commander's --no-evidence-links negation: opts.evidenceLinks is
        // true unless the user passed the flag. Rule 5 is default-ON.
        includeEvidenceLinks: opts.evidenceLinks !== false,
        minNameJaccard: opts.minJaccard,
        resetIdempotency: !!opts.resetIdempotency,
      };
      if (opts.dryRun) {
        const { candidates, skippedOrphanIds } = proposeBackfillCandidates(baseOpts);
        if (opts.json) {
          console.log(JSON.stringify({ candidates, skippedOrphanIds }, null, 2));
          return;
        }
        console.log(`Proposed ${candidates.length} relation${candidates.length === 1 ? '' : 's'} (dry-run, nothing written).`);
        const sample = candidates.slice(0, 20);
        for (const c of sample) {
          console.log(`  ${c.fromName}  --[${c.relationType}]-->  ${c.toName}   (${c.reason})`);
        }
        if (candidates.length > sample.length) {
          console.log(`  … ${candidates.length - sample.length} more (use --json to see them all)`);
        }
        // Per-rule breakdown
        const byRule = new Map<string, number>();
        for (const c of candidates) byRule.set(c.relationType, (byRule.get(c.relationType) ?? 0) + 1);
        console.log('');
        for (const [rule, n] of byRule) console.log(`  ${rule}: ${n}`);
        if (skippedOrphanIds.length > 0) {
          console.log('');
          console.log(`  idempotency: ${skippedOrphanIds.length} orphan${skippedOrphanIds.length === 1 ? '' : 's'} skipped (already attempted in a prior run; use --reset-idempotency to reconsider).`);
        }
        return;
      }
      const result = backfillRelations(baseOpts);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Proposed ${result.candidatesProposed} relations, wrote ${result.edgesWritten} new edges.`);
      console.log(`  tag co-occurrence: ${result.byRule.tagCooccurrence}`);
      console.log(`  project clustering: ${result.byRule.projectClustering}`);
      console.log(`  session co-occurrence: ${result.byRule.sessionCooccurrence}`);
      console.log(`  name token similarity: ${result.byRule.nameTokenSimilarity}`);
      console.log(`  evidence links: ${result.byRule.evidenceLinks}`);
      if (result.candidatesProposed > result.edgesWritten) {
        console.log(`  (${result.candidatesProposed - result.edgesWritten} candidates were already-existing edges; INSERT OR IGNORE skipped them.)`);
      }
      if (result.orphansSkippedIdempotent > 0) {
        console.log(`  idempotency: skipped ${result.orphansSkippedIdempotent} orphan${result.orphansSkippedIdempotent === 1 ? '' : 's'} already attempted in a prior run (use --reset-idempotency to reconsider them).`);
      }
      if (result.orphansMarkedProcessed > 0) {
        console.log(`  idempotency: marked ${result.orphansMarkedProcessed} new orphan${result.orphansMarkedProcessed === 1 ? '' : 's'} as attempted.`);
      }
    });
  });

kgCmd
  .command('rename-project')
  .description('Merge or rename a project:<name> tag across all entities (heals mis-homed tags from before git-based project identity)')
  .option('--from <name>', 'Existing project name to rewrite. Omit both --from/--to to just LIST all project tags + counts.')
  .option('--to <name>', 'New project name to rewrite it to')
  .option('--apply', 'Actually write the change. Default is a dry-run preview. Backs up the DB first.')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    await withDatabase(async () => {
      const { listProjectTags, renameProjectTag } = await import('../../core/project-tags.js');

      // List mode — no --from/--to: show the current project-tag distribution
      // so the user can spot splits (e.g. tim vs TIM) before mapping them.
      if (!opts.from && !opts.to) {
        const tags = listProjectTags();
        if (opts.json) { console.log(JSON.stringify(tags, null, 2)); return; }
        if (tags.length === 0) { console.log('No project:* tags found.'); return; }
        console.log('Project tags (entity count):');
        for (const t of tags) console.log(`  ${String(t.count).padStart(5)}  ${t.project}`);
        console.log(`\nRewrite one with:  memesh kg rename-project --from <old> --to <new>   (add --apply to write)`);
        return;
      }
      if (!opts.from || !opts.to) {
        console.error('Provide BOTH --from and --to (or neither, to list).');
        process.exitCode = 1;
        return;
      }

      // Dry-run preview first (always computed).
      const preview = renameProjectTag(opts.from, opts.to, { apply: false });
      if (!opts.apply) {
        if (opts.json) { console.log(JSON.stringify({ ...preview, dryRun: true }, null, 2)); return; }
        console.log(`Dry-run: project:${opts.from} → project:${opts.to}`);
        console.log(`  ${preview.affectedEntities} entit${preview.affectedEntities === 1 ? 'y' : 'ies'} carry project:${opts.from}`);
        console.log(`  ${preview.renamed} would be renamed, ${preview.merged} already have project:${opts.to} (their project:${opts.from} row would be removed)`);
        console.log(`\nNothing written. Re-run with --apply to commit (the DB is backed up first).`);
        return;
      }

      if (preview.affectedEntities === 0) {
        console.log(`No entities carry project:${opts.from} — nothing to do.`);
        return;
      }

      // --apply: back up the whole DB file before any mutation (recoverable).
      const dbPath = getDbPath();
      const backupDir = path.join(process.cwd(), 'data', 'backups');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `kg-before-rename-project-${stamp}.db`);
      try {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.copyFileSync(dbPath, backupPath);
      } catch (err) {
        console.error(`❌ Could not back up the DB before applying (${err instanceof Error ? err.message : err}); aborting without changes.`);
        process.exitCode = 1;
        return;
      }

      const result = renameProjectTag(opts.from, opts.to, { apply: true });
      if (opts.json) { console.log(JSON.stringify({ ...result, backupPath }, null, 2)); return; }
      console.log(`✅ project:${opts.from} → project:${opts.to}`);
      console.log(`  ${result.renamed} renamed, ${result.merged} merged (${result.affectedEntities} entities total)`);
      console.log(`  Backup: ${backupPath}`);
      console.log(`  Restore if needed: cp "${backupPath}" "${dbPath}"`);
    });
  });

// --- doctor ---
program
  .command('doctor')
  .description('Verify local install health and show actionable fixes')
  .option('--json', 'Output machine-readable diagnostics as JSON')
  .option('--probe-http', 'Also probe the local HTTP server health endpoint')
  .option('--probe', 'Make one small live call to the configured LLM to confirm it actually answers')
  .option('--url <url>', 'Base URL for --probe-http', 'http://127.0.0.1:3737')
  .option('--fix', 'Apply the whitelisted fixes doctor prescribes (asks per fix; --yes skips asking)')
  .option('--yes', 'With --fix: apply without asking')
  .action(async (opts) => {
    const { formatDoctorReport, runDoctor } = await import('../../core/doctor.js');
    let result = await runDoctor({
      packageRoot,
      packageVersion: pkg.version,
      probeHttp: opts.probeHttp,
      probeCapabilities: opts.probe,
      httpBaseUrl: opts.url,
    });

    // --fix executes only prescriptions that carry a fixId — attached at the
    // diagnosing branch in doctor.ts, never parsed from the human fix text.
    // The whitelist is deliberately short: hook wiring (installHooks backs
    // up settings.json and refuses on plugin machines), the keyword-index
    // rebuild (free, local), and the db chmod. NOT here on purpose:
    // `memesh reindex` (vector_index) re-embeds the whole database — on a
    // paid provider that costs real money — and the rm/mv database branches
    // destroy or move user data. Those stay human decisions.
    if (opts.fix) {
      // The dispatch is a Record, not an if-chain, so a fourth fixId added
      // in doctor.ts fails to COMPILE here instead of prompting the user
      // and then silently doing nothing — a success-shaped no-op being the
      // exact failure class this repo audits for.
      const FIX_ACTIONS: Record<NonNullable<typeof result.checks[number]['fixId']>, () => string> = {
        'install-hooks': wireUserHooks,
        'fts-rebuild': () => {
          openDatabase();
          try { return `keyword index rebuilt (${reindexFts().entities} entities)`; }
          finally { closeDatabase(); }
        },
        'chmod-db': () => {
          fs.chmodSync(getDbPath(), 0o600);
          return `permissions restored: chmod 600 ${getDbPath()}`;
        },
      };
      const fixable = result.checks.filter((c) => c.fixId && (c.status === 'warn' || c.status === 'fail'));
      if (fixable.length === 0) {
        console.log('Nothing on the --fix whitelist to apply.');
      } else {
        if (!opts.yes && !process.stdin.isTTY) {
          console.error('Not a terminal and --yes not given — nothing was changed. Re-run with: memesh doctor --fix --yes');
          process.exit(1);
        }
        let rl: import('node:readline/promises').Interface | null = null;
        if (!opts.yes) {
          const { createInterface } = await import('node:readline/promises');
          rl = createInterface({ input: process.stdin, output: process.stdout });
        }
        for (const check of fixable) {
          console.log(`\n${check.label}: ${check.summary}`);
          if (rl) {
            const answer = (await rl.question(`Apply fix (${check.fixId})? [y/N] `)).trim().toLowerCase();
            if (answer !== 'y' && answer !== 'yes') { console.log('  skipped'); continue; }
          }
          try {
            console.log(`  ✅ ${FIX_ACTIONS[check.fixId!]()}`);
          } catch (err) {
            console.error(`  ❌ ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        rl?.close();

        // The verdict is a fresh doctor run, not trust in the fixes (the
        // inspectors are module-private, so re-run + diff beats an export
        // refactor). Probes are FORCED OFF here whatever the original flags
        // said: no whitelisted fix can change what a live LLM/HTTP probe
        // answers, and --probe --fix would otherwise pay the LLM call twice.
        // The diff is scoped to fixable checks for the same reason — a
        // "probe: pass → skipped" flip would be noise from the re-run's own
        // flags, not a fix taking effect.
        console.log('\nAfter fixes:');
        const before = new Map(result.checks.map((c) => [c.id, c.status]));
        // Scoped by the BEFORE run's fixable ids — the re-run's healthy rows
        // carry no fixId (a PASS prescribes nothing), so filtering on the
        // new rows' fixId would swallow the very warn→pass lines this
        // diff exists to show.
        const fixedIds = new Set(fixable.map((c) => c.id));
        result = await runDoctor({
          packageRoot,
          packageVersion: pkg.version,
          probeHttp: false,
          probeCapabilities: false,
          httpBaseUrl: opts.url,
        });
        for (const c of result.checks) {
          const was = before.get(c.id);
          if (fixedIds.has(c.id) && was && was !== c.status) console.log(`  ${c.label}: ${was} → ${c.status}`);
        }
      }
    }

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const line of formatDoctorReport(result, pkg.version)) {
        console.log(line);
      }
      // Bridge from "doctor found a problem" to "user knows how to
      // report it". Mirrors the dashboard DoctorBanner's Get-help
      // affordance so terminal-only users get the same path. Skip
      // for --json (machine output should stay clean for parsing).
      if (result.status !== 'PASS') {
        console.log('');
        console.log('Need help? Run `memesh feedback` to file a GitHub issue with the diagnostics pre-attached.');
      }
    }

    if (result.status === 'FAIL') {
      process.exitCode = 1;
    }
  });

// --- dream (LLM cluster compactor — #39 Phase 2) ---
//
// `memesh dream` — runs the dreamer on recent episodic clusters,
// writes pending proposals to dream_proposals (NEVER touches source
// entities). User reviews via `memesh dream list` + `dream accept`
// or `dream reject`. Mirrors Mem0's 4-op + Graphiti's
// invalidate-don't-delete + Anthropic AutoDream's safety promise.
const dreamCmd = program.command('dream').description('Consolidate noisy episodic memories into digests (LLM-driven, opt-in review)');

dreamCmd
  .command('run', { isDefault: true })
  .description('Run a dream pass — propose digests for clusters of compactable entities')
  .option('--project <name>', 'Restrict to one project')
  .option('--dry-run', 'Compute proposals without writing to dream_proposals')
  .option('--max-llm-calls <n>', 'Hard cap on LLM calls (default 100)', (v) => parseInt(v, 10))
  .option('--window-days <n>', 'Look-back window in days (default 56 = 8 weeks)', (v) => parseInt(v, 10))
  .option('--validate', 'Run a second LLM pass to cross-check each digest against its sources (doubles LLM calls per proposal; surfaces under flow=digest_validator in `memesh telemetry`)')
  .option('--from-transcripts', 'EXPERIMENTAL: mine Claude Code session transcripts for this project (decisions/lessons/facts hidden in the conversation) and STAGE them as proposals for `dream accept`, instead of clustering existing entities. Scoped to the current project only — --project does not apply here. With --dry-run, lists sessions and conversation-turn counts without calling an LLM.')
  .option('--if-due', 'For a scheduler (cron/launchd): only mine if `transcriptMining` is enabled in config AND at least --min-interval-hours have passed since this project was last mined; otherwise exit 0 doing nothing. Lets one frequently-firing entry self-throttle. Only meaningful with --from-transcripts.')
  .option('--min-interval-hours <n>', 'With --if-due: minimum hours between mined runs for this project (default 24).', (v) => parseInt(v, 10))
  .action(async (opts) => {
    // --from-transcripts is the transcript-source path (Task #18). B1 shipped
    // discovery; B2 adds extraction + staging (still REVERSIBLE — proposals sit
    // in dream_proposals for a human `dream accept`; nothing enters the KG).
    if (opts.fromTranscripts) {
      const windowDays = typeof opts.windowDays === 'number' && !Number.isNaN(opts.windowDays) ? opts.windowDays : 3;

      // --dry-run: discovery + a real, cheap conversation-turn count. No LLM,
      // no DB writes. (A "how many candidates" number would need an LLM pass or
      // a new unpinned classifier — deliberately not shown, to avoid fake
      // precision reading as "how many memories you'd get".)
      if (opts.dryRun) {
        const { scanTranscripts } = await import('../../core/transcript-source.js');
        const { countConversationTurns } = await import('../../core/transcript-extractor.js');
        const sessions = scanTranscripts({ windowDays });
        console.log(`[dry-run] transcript sessions for this project in the last ${windowDays} day(s): ${sessions.length}`);
        let totalTurns = 0;
        for (const s of sessions) {
          const turns = countConversationTurns(s.path);
          totalTurns += turns;
          console.log(`  ${s.sessionId}  ${turns} conversation turns  ${s.lineCount} lines  ${(s.sizeBytes / 1024).toFixed(0)}KB  ${s.modifiedAt}`);
        }
        console.log(`  total: ${totalTurns} conversation turns across ${sessions.length} session(s)`);
        console.log('');
        console.log('Run without --dry-run to extract high-value memories and stage them as proposals.');
        return;
      }

      // --if-due (for a scheduler): gate on the opt-in switch + a per-project
      // throttle BEFORE opening the DB or calling an LLM. Either "off" or "not
      // due yet" exits 0 doing nothing, so a frequently-firing cron/launchd entry
      // is harmless while the switch is off and self-paces once it is on.
      if (opts.ifDue) {
        const { isTranscriptMiningEnabled } = await import('../../core/config.js');
        if (!isTranscriptMiningEnabled(readConfig())) {
          console.log('Scheduled transcript mining is off (opt-in). Enable it with `memesh config set transcriptMining true`; this scheduled run will then start mining when due.');
          return;
        }
        const { getProjectName } = await import('../../core/paths.js');
        const { lastTranscriptMineAt, transcriptMiningDue } = await import('../../core/transcript-source.js');
        const projectKey = getProjectName(process.cwd());
        const intervalH = typeof opts.minIntervalHours === 'number' && !Number.isNaN(opts.minIntervalHours) ? opts.minIntervalHours : 24;
        const last = lastTranscriptMineAt(projectKey);
        if (!transcriptMiningDue(Date.now(), last, intervalH)) {
          const agoH = last === null ? null : (Date.now() - last) / 3600_000;
          console.log(`Not due yet: this project was mined ${agoH === null ? 'recently' : `${agoH.toFixed(1)}h ago`}; interval is ${intervalH}h. Nothing to do.`);
          return;
        }
      }

      // Real run: extract + stage. Requires an LLM (semantic extraction is not
      // a rule). Same detectCapabilities + fallback wiring as `dream run`.
      if (opts.project) {
        console.log('note: --project does not scope --from-transcripts — the transcript source is always the current project. Ignoring --project.');
      }
      await withDatabase(async () => {
        const { runTranscriptSource } = await import('../../core/transcript-extractor.js');
        const { getDatabase } = await import('../../db.js');
        const cfg = readConfig();
        const llm = detectCapabilities().llm;
        if (!llm) {
          console.error('No LLM configured. Run `memesh config set llm.provider <anthropic|openai|ollama>` first (or set ANTHROPIC_API_KEY / OPENAI_API_KEY).');
          console.error('LLM is required for `--from-transcripts` because extracting durable memory from prose is a semantic decision, not a rule.');
          process.exit(1);
        }
        const result = await runTranscriptSource(getDatabase(), llm, {
          windowDays,
          maxLlmCalls: opts.maxLlmCalls,
          fallbacks: cfg.llmFallbacks,
        });
        // Advance the per-project throttle on ANY completed run — manual or
        // scheduled — so an `--if-due` cron does not re-mine right after a hand
        // run. A scan that found nothing still counts: it did the work of looking.
        const { getProjectName } = await import('../../core/paths.js');
        const { recordTranscriptMine } = await import('../../core/transcript-source.js');
        recordTranscriptMine(getProjectName(process.cwd()), Date.now());
        console.log(`Transcript mining complete in ${result.durationMs}ms`);
        console.log(`  sessions scanned:    ${result.sessionsScanned}`);
        console.log(`  LLM calls:           ${result.llmCalls}`);
        console.log(`  candidates extracted: ${result.candidatesExtracted}`);
        console.log(`  proposals created:   ${result.proposalsCreated}`);
        if (result.duplicatesSkipped > 0) console.log(`  duplicates skipped:  ${result.duplicatesSkipped} (already a pending proposal)`);
        // B3: near-duplicates of an EXISTING entity are never a silent drop —
        // name each candidate and the memory it matched so the reviewer can
        // audit the decision (and re-remember it manually if the match was wrong).
        if (result.nearDuplicatesSkipped > 0) {
          console.log(`  near-duplicates skipped: ${result.nearDuplicatesSkipped} candidate(s) skipped as near-duplicates of existing memories`);
          for (const d of result.nearDuplicates) {
            console.log(`    - "${d.candidateName}" ~= existing "${d.matchedEntityName}" (distance ${d.distance.toFixed(3)})`);
          }
        }
        if (result.secretsDropped > 0) console.log(`  secret-bearing candidates dropped: ${result.secretsDropped}`);
        if (result.llmFailures > 0) console.log(`  LLM call failures:   ${result.llmFailures} (sessions not mined — retry when the provider is reachable)`);
        if (result.parseFailures > 0) console.log(`  unparsable replies:  ${result.parseFailures} (chunk reply not valid JSON — likely truncated; those candidates were lost, retry)`);
        // Never let a size-cap truncation be a silent 0: name each session that
        // lost tail turns (the newest content, likeliest to hold a reversal).
        if (result.truncatedTurns > 0) {
          console.log(`  size-cap truncation: ${result.truncatedTurns} conversation turn(s) beyond the cap were NOT analysed`);
          for (const t of result.truncatedSessions) {
            console.log(`    - session ${t.sessionId}: ${t.truncatedTurns} tail turn(s) not analysed`);
          }
        }
        if (result.skipped.length > 0) {
          const reasonCounts = new Map<string, number>();
          for (const s of result.skipped) reasonCounts.set(s.reason, (reasonCounts.get(s.reason) ?? 0) + 1);
          console.log(`  skipped:             ${result.skipped.length}`);
          for (const [reason, n] of reasonCounts) console.log(`    - ${reason}${n > 1 ? ` (×${n})` : ''}`);
        }
        if (result.proposalsCreated > 0) {
          console.log('');
          console.log('Review with: memesh dream list');
          console.log('Accept:      memesh dream accept <id>');
        }
      });
      return;
    }
    await withDatabase(async () => {
      const { runDreamer } = await import('../../core/dreamer.js');
      const { getDatabase } = await import('../../db.js');
      // Fallback chain still comes from the config file — there is no env
      // shape for it; only the PRIMARY provider is env-detectable.
      const cfg = readConfig();
      // detectCapabilities, not readConfig: `status` and `doctor` count an
      // env-var API key as Smart Mode, and this gate reading only the config
      // file made the same machine say "Smart Mode" and "No LLM configured"
      // in consecutive commands.
      const llm = detectCapabilities().llm;
      if (!llm) {
        console.error('No LLM configured. Run `memesh config set llm.provider <anthropic|openai|ollama>` first (or set ANTHROPIC_API_KEY / OPENAI_API_KEY).');
        console.error('LLM is required for `memesh dream` because consolidation is a semantic decision, not a rule.');
        process.exit(1);
      }
      const result = await runDreamer(getDatabase(), llm, {
        project: opts.project,
        dryRun: !!opts.dryRun,
        maxLlmCalls: opts.maxLlmCalls,
        windowDays: opts.windowDays,
        fallbacks: cfg.llmFallbacks,
        validateBeforeStage: !!opts.validate,
      });
      console.log(`${opts.dryRun ? '[dry-run] ' : ''}Dream pass complete in ${result.durationMs}ms`);
      console.log(`  clusters scanned: ${result.clustersScanned}`);
      // Grouping by calendar week instead of by meaning changes what gets
      // proposed, so it is stated rather than left to be inferred from the
      // digests. Same for candidates that carry no vector.
      if (result.clusteringMode) {
        console.log(`  grouped by:       ${result.clusteringMode === 'semantic' ? 'meaning (embeddings)' : 'calendar week (no embeddings)'}`);
      }
      if (result.clusteringNote) console.log(`    note: ${result.clusteringNote}`);
      console.log(`  LLM calls:        ${result.llmCalls}`);
      console.log(`  proposals created: ${result.proposalsCreated}`);
      if (result.skipped.length > 0) {
        console.log(`  skipped:           ${result.skipped.length}`);
        // Group by the FULL reason text — earlier we split on ':' which
        // truncated "LLM call failed: Anthropic API error: 401" down to
        // just "LLM call failed" and silently dropped the actual error
        // class. Surfacing the full reason makes outages debuggable
        // without dropping into the dreamer module directly.
        const reasonCounts = new Map<string, number>();
        for (const s of result.skipped) {
          reasonCounts.set(s.reason, (reasonCounts.get(s.reason) ?? 0) + 1);
        }
        for (const [reason, n] of reasonCounts) {
          console.log(`    - ${reason}${n > 1 ? ` (×${n})` : ''}`);
        }
      }
      if (!opts.dryRun && result.proposalsCreated > 0) {
        console.log('');
        console.log(`Review with: memesh dream list`);
        console.log(`Accept all:  memesh dream accept --all`);
      }
    });
  });

dreamCmd
  .command('patterns')
  .description('Run pattern detector — surface emerging patterns/conventions/repeated mistakes per project (Phase 3)')
  .option('--project <name>', 'Restrict to one project (default: all projects)')
  .option('--dry-run', 'Compute proposals without writing to dream_proposals')
  .option('--max-llm-calls <n>', 'Hard cap on LLM calls (default 10)', (v) => parseInt(v, 10))
  .option('--window-days <n>', 'Look-back window in days (default 30)', (v) => parseInt(v, 10))
  .option('--min-signal <n>', 'Minimum signal_score to include in scan (default 0.3)', (v) => parseFloat(v))
  .action(async (opts) => {
    await withDatabase(async () => {
      const { runPatternDetector } = await import('../../core/dreamer.js');
      const { getDatabase } = await import('../../db.js');
      const cfg = readConfig();
      const llm = detectCapabilities().llm;
      if (!llm) {
        console.error('No LLM configured. Pattern detection requires an LLM.');
        console.error('Run `memesh config set llm.provider <anthropic|openai|ollama>` first (or set ANTHROPIC_API_KEY / OPENAI_API_KEY).');
        process.exit(1);
      }
      const result = await runPatternDetector(getDatabase(), llm, {
        project: opts.project,
        dryRun: !!opts.dryRun,
        maxLlmCalls: opts.maxLlmCalls,
        windowDays: opts.windowDays,
        minSignal: opts.minSignal,
        fallbacks: cfg.llmFallbacks,
      });
      console.log(`${opts.dryRun ? '[dry-run] ' : ''}Pattern detector complete in ${result.durationMs}ms`);
      console.log(`  entities scanned: ${result.entitiesScanned}`);
      console.log(`  LLM calls:        ${result.llmCalls}`);
      console.log(`  patterns proposed: ${result.proposalsCreated}`);
      if (result.skipped.length > 0) {
        console.log(`  skipped:           ${result.skipped.length}`);
        for (const s of result.skipped.slice(0, 5)) {
          console.log(`    - ${s.project ?? '?'}: ${s.reason}`);
        }
      }
      if (!opts.dryRun && result.proposalsCreated > 0) {
        console.log('');
        console.log(`Review with: memesh dream list`);
      }
    });
  });

dreamCmd
  .command('list')
  .description('List dream proposals (pending by default)')
  // Accepting a proposal writes status 'applied' (see dreamer.ts), so
  // 'accepted' was never a value any row could hold — `--status accepted`
  // silently returned nothing while the help text advertised it.
  .option('--status <s>', 'Filter by status: pending | applied | rejected', 'pending')
  .option('--json', 'Output JSON')
  .action(async (opts) => {
    await withDatabase(async () => {
      const { listProposals } = await import('../../core/dreamer.js');
      const { getDatabase } = await import('../../db.js');
      const proposals = listProposals(getDatabase(), opts.status);
      if (opts.json) { console.log(JSON.stringify(proposals, null, 2)); return; }
      if (proposals.length === 0) {
        console.log(`No ${opts.status} dream proposals.`);
        return;
      }
      console.log(`${proposals.length} ${opts.status} proposal(s):`);
      console.log('');
      for (const p of proposals) {
        // Label transcript-sourced proposals distinctly so a reviewer knows a
        // digest was mined from a session's conversation, not clustered from
        // existing entities — and conflict-judge proposals, whose acceptance
        // creates a relation instead of an entity.
        const srcLabel = p.kind === 'relation' ? ' (conflict)'
          : p.source_kind === 'transcript' ? ' (transcript)' : '';
        console.log(`  #${p.id}  [${p.project}/${p.cluster_key}]${srcLabel}  ${p.source_count} source(s) → "${p.digest_name}"`);
        // preview is null (not the old '(empty)' sentinel) when the digest
        // has no observations — print nothing rather than a fake value.
        if (p.digest_observations_preview !== null) {
          console.log(`         ${p.digest_observations_preview}`);
        }
        console.log(`         created: ${p.created_at}`);
        console.log('');
      }
      console.log(`Inspect: memesh dream show <id>   |   Apply: memesh dream accept <id>   |   Reject: memesh dream reject <id>`);
    });
  });

// --- dream conflicts (contradiction judge — conflict pipeline P2) ---
//
// Candidate generation (conflict-candidates.ts) is deterministic and free;
// this command spends the LLM on the tightest pairs and STAGES verdicts as
// kind='relation' proposals for the same `dream list`/`accept`/`reject`
// review every other machine proposal goes through. Nothing applies
// automatically; UNRELATED verdicts are remembered so a pair is never
// re-bought.
dreamCmd
  .command('conflicts')
  .description('Judge semantically-close memory pairs for contradiction / supersession / duplication (LLM) and stage relation proposals for review')
  .option('--max-pairs <n>', 'Judge at most N of the tightest candidate pairs this run (default 20)', (v) => parseInt(v, 10))
  .option('--dry-run', 'Show how many candidates are queued without calling an LLM or writing anything')
  .action(async (opts) => {
    await withDatabase(async () => {
      const cfg = readConfig();
      const llm = detectCapabilities().llm;
      if (!llm) {
        console.error('No LLM configured. Run `memesh config set llm.provider <anthropic|openai|ollama>` first (or set ANTHROPIC_API_KEY / OPENAI_API_KEY).');
        console.error('LLM is required for `memesh dream conflicts` because "do these two entries disagree" is a semantic judgement, not a rule.');
        process.exit(1);
      }
      const { judgeConflicts, CONFLICT_JUDGE_MAX_PAIRS } = await import('../../core/conflict-judge.js');
      const { getDatabase } = await import('../../db.js');
      const result = await judgeConflicts(getDatabase(), llm, {
        maxPairs: typeof opts.maxPairs === 'number' && !Number.isNaN(opts.maxPairs) ? opts.maxPairs : CONFLICT_JUDGE_MAX_PAIRS,
        dryRun: !!opts.dryRun,
        fallbacks: cfg.llmFallbacks,
      });
      console.log(`${opts.dryRun ? '[dry-run] ' : ''}Conflict pass complete in ${result.durationMs}ms`);
      console.log(`  candidate pairs available: ${result.candidatesAvailable}`);
      if (opts.dryRun) {
        console.log('  (dry run — no LLM called, nothing judged or written)');
        return;
      }
      console.log(`  LLM calls:      ${result.llmCalls}`);
      console.log(`  judged:         ${result.judged} (${result.unrelated} unrelated, remembered so they are never re-bought)`);
      console.log(`  staged:         ${result.staged} relation proposal(s)`);
      if (result.llmFailures > 0) {
        // A parse failure is NOT a verdict — those pairs stay unjudged and
        // return as candidates next run, AT THE HEAD of the list (it is
        // sorted tightest-first): a model that reliably fails on the same
        // pairs will re-buy them every run, which this line makes visible.
        console.log(`  failed:         ${result.llmFailures} (unparseable or errored LLM responses; those pairs stay at the head of the candidate list and are retried next run)`);
      }
      if (result.aborted) {
        // Everything counted above is real, committed work — say so before
        // the error, or a re-run's smaller numbers look like the whole story.
        console.error(`  ABORTED after the work above: ${result.aborted}`);
        process.exit(1);
      }
      if (result.staged > 0) {
        console.log('');
        console.log('Review: memesh dream list   |   Apply: memesh dream accept <id>   |   Reject: memesh dream reject <id>');
      }
    });
  });

dreamCmd
  .command('show <id>')
  .description('Show a proposal in full — name, type, ALL observations, tags, source — so you can review the whole thing before accepting')
  .option('--json', 'Output JSON')
  .action(async (id, opts) => {
    await withDatabase(async () => {
      const { getProposalDetail } = await import('../../core/dreamer.js');
      const { getDatabase } = await import('../../db.js');
      const detail = getProposalDetail(getDatabase(), parseInt(id, 10));
      if (!detail) {
        console.error(`proposal #${id} not found`);
        console.error('See ids with: memesh dream list');
        process.exit(1);
      }
      if (opts.json) { console.log(JSON.stringify(detail, null, 2)); return; }
      console.log(`Proposal #${detail.id}  [${detail.project}/${detail.cluster_key}]  source: ${detail.source_kind}  status: ${detail.status}`);
      console.log(`created: ${detail.created_at}`);
      console.log('');
      // Relation proposals carry a judge payload, not a digest — showing the
      // dummy digest here would hide exactly what the reviewer must see
      // (rationale, severity, excerpts, and for supersedes WHICH SIDE
      // survives) before accepting.
      if (detail.kind === 'relation') {
        const rel = detail.relation as {
          verdict?: string; relation_type?: string; severity?: string;
          a?: { id?: number; name?: string }; b?: { id?: number; name?: string };
          direction?: string; rationale?: string; recommended_action?: string;
          excerpts?: { a?: string; b?: string }; cosine_distance?: number;
        } | null;
        if (!rel) {
          console.error('relation payload is corrupt — reject this proposal');
          process.exit(1);
        }
        const [fromE, toE] = rel.relation_type === 'supersedes' && rel.direction === 'b_supersedes_a' ? [rel.b, rel.a] : [rel.a, rel.b];
        console.log(`verdict: ${rel.verdict}  (severity: ${rel.severity ?? 'unknown'})`);
        console.log(`accepting creates: ${fromE?.name} —${rel.relation_type}→ ${toE?.name}`);
        if (rel.relation_type === 'supersedes') {
          console.log(`  survivor: ${fromE?.name}  (the arrow points from the surviving claim to the obsolete one)`);
        }
        console.log(`rationale: ${rel.rationale ?? '(none given)'}`);
        if (rel.recommended_action) console.log(`recommended action: ${rel.recommended_action}`);
        if (rel.excerpts?.a || rel.excerpts?.b) {
          console.log(`excerpt A (${rel.a?.name}): ${rel.excerpts?.a ?? ''}`);
          console.log(`excerpt B (${rel.b?.name}): ${rel.excerpts?.b ?? ''}`);
        }
        if (typeof rel.cosine_distance === 'number') console.log(`cosine distance: ${rel.cosine_distance.toFixed(3)}`);
        console.log('');
        console.log(`Accept: memesh dream accept ${detail.id}   |   Reject: memesh dream reject ${detail.id}`);
        return;
      }
      console.log(`name: ${detail.digest.name}`);
      console.log(`type: ${detail.digest.type}`);
      // ALL observations, in full — this is the point of `show`: nothing is
      // truncated, so a secret in observation 2+ or past char 120 is visible.
      console.log(`observations (${detail.digest.observations.length}):`);
      for (const o of detail.digest.observations) console.log(`  - ${o}`);
      if (detail.digest.tags.length > 0) console.log(`tags: ${detail.digest.tags.join(', ')}`);
      console.log(`source: ${JSON.stringify(detail.source)}`);
      console.log('');
      console.log(`Accept: memesh dream accept ${detail.id}   |   Reject: memesh dream reject ${detail.id}`);
    });
  });

dreamCmd
  .command('accept <id>')
  .description('Accept a pending proposal — creates digest entity, soft-archives sources')
  .action(async (id) => {
    await withDatabase(async () => {
      const { applyProposal } = await import('../../core/dreamer.js');
      const { getDatabase } = await import('../../db.js');
      const { KnowledgeGraph } = await import('../../knowledge-graph.js');
      const kg = new KnowledgeGraph(getDatabase());
      // A wrong id is the most common slip in the review flow; it used to
      // print the throw as a raw stack trace. The message alone is enough.
      let result;
      try {
        result = applyProposal(getDatabase(), parseInt(id, 10), kg);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        console.error('See pending ids with: memesh dream list');
        process.exit(1);
      }
      // A transcript accept schedules a fire-and-forget embed for the new entity
      // (so the next transcript run's vector dedup can see it). withDatabase
      // closes the DB in its finally, so flush BEFORE it does or the write lands
      // on a closing DB and the dedup gap stays open in the real path. remember
      // flushes for the same reason (see the remember command).
      await flushPendingEmbeddings();
      console.log(`Applied proposal #${result.proposalId}`);
      console.log(`  digest entity: ${result.digestEntityName}`);
      console.log(`  sources archived: ${result.sourcesArchived}`);
    });
  });

dreamCmd
  .command('reject <id>')
  .description('Reject a pending proposal — sources untouched, proposal marked rejected')
  .option('--reason <text>', 'Reason for rejection (saved for audit)')
  .action(async (id, opts) => {
    await withDatabase(async () => {
      const { rejectProposal } = await import('../../core/dreamer.js');
      const { getDatabase } = await import('../../db.js');
      try {
        rejectProposal(getDatabase(), parseInt(id, 10), opts.reason);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        console.error('See pending ids with: memesh dream list');
        process.exit(1);
      }
      console.log(`Rejected proposal #${id}`);
    });
  });

// --- install-hooks / uninstall-hooks ---
//
// memesh ships hooks/hooks.json for Claude Code's plugin runtime,
// but `npm install -g` only puts the CLI on PATH — the plugin
// runtime never reads them. Inject the hooks directly into
// ~/.claude/settings.json so they fire on every Claude Code session,
// preserving any user-global hooks the user already wired.
program
  .command('install-hooks')
  .description('Wire memesh\'s session hooks into Claude Code (~/.claude/settings.json)')
  .option('--scope <scope>', 'user (default) or project — project writes to ./.claude/settings.json', 'user')
  .option('--dry-run', 'Show what would change without modifying any file')
  .option('--force-over-plugin', 'Write user-level hooks even when Claude Code\'s plugin runtime already wires them. Causes double-firing — only use if you genuinely want both surfaces.')
  .action(async (opts) => {
    const { installHooks } = await import('../../core/install-hooks.js');
    const scope = opts.scope === 'project' ? 'project' : 'user';
    try {
      const result = installHooks({
        pluginRoot: packageRoot,
        pluginVersion: pkg.version,
        scope,
        dryRun: !!opts.dryRun,
        forceOverPlugin: !!opts.forceOverPlugin,
      });
      if (result.pluginRuntimeDetected) {
        console.log('memesh is already wired via the Claude Code plugin runtime — skipping install-hooks to avoid double-firing.');
        console.log(`  Plugin install: ${result.pluginRuntimeDetected.installPath} (v${result.pluginRuntimeDetected.version})`);
        console.log('');
        console.log('Hooks are active. Verify with: memesh doctor');
        console.log('');
        console.log('If you really want a second copy in ~/.claude/settings.json on top of the plugin, re-run with --force-over-plugin. (Not recommended — every session-start / Stop / PreToolUse event will fire memesh\'s hooks twice.)');
        return;
      }
      console.log(`${opts.dryRun ? '[dry-run] ' : ''}Settings: ${result.settingsPath}`);
      console.log(`${opts.dryRun ? '[dry-run] Would add ' : 'Added '}${result.added} hook entr${result.added === 1 ? 'y' : 'ies'}, ${opts.dryRun ? 'would skip ' : 'skipped '}${result.skipped} already-installed.`);
      if (result.pruned > 0) {
        console.log(`${opts.dryRun ? '[dry-run] Would remove ' : 'Removed '}${result.pruned} retired memesh hook entr${result.pruned === 1 ? 'y' : 'ies'} no longer shipped by this version.`);
      }
      if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
      if (result.conflicts.length > 0) {
        console.log('');
        console.log('Note: memesh hooks now coexist with the following pre-existing entries:');
        for (const c of result.conflicts) {
          console.log(`  - ${c.event} (matcher: ${c.matcher}) — ${c.existingCount} non-memesh hook command${c.existingCount === 1 ? '' : 's'} preserved`);
        }
      }
      if (!opts.dryRun) {
        console.log('');
        console.log('Restart Claude Code (or open a new session) for hooks to take effect.');
        console.log('Verify with: memesh doctor');
      }
    } catch (err) {
      console.error(`install-hooks failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command('uninstall-hooks')
  .description('Remove memesh\'s session hooks from Claude Code settings')
  .option('--scope <scope>', 'user (default) or project', 'user')
  .option('--dry-run', 'Show what would change without modifying any file')
  .action(async (opts) => {
    const { uninstallHooks } = await import('../../core/install-hooks.js');
    const scope = opts.scope === 'project' ? 'project' : 'user';
    try {
      const result = uninstallHooks({ scope, dryRun: !!opts.dryRun });
      console.log(`${opts.dryRun ? '[dry-run] ' : ''}Settings: ${result.settingsPath}`);
      console.log(`${opts.dryRun ? '[dry-run] ' : ''}Removed ${result.removed} memesh hook command${result.removed === 1 ? '' : 's'}.`);
      if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
    } catch (err) {
      console.error(`uninstall-hooks failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// --- feedback ---
//
// CLI counterpart to the dashboard FeedbackWidget. Builds the same
// pre-filled GitHub issue URL (title + body + labels) and opens it
// in the default browser. Same transparency contract: install_id
// and doctor diagnostics are only included when the user opts in.
program
  .command('feedback')
  .description('Open a pre-filled GitHub issue (bug / feature / question) with optional diagnostics')
  .option('--bug', 'File a bug report (default if no type flag)')
  .option('--feature', 'File a feature request')
  .option('--question', 'Ask a question')
  .option('--no-diagnostics', 'Skip including doctor output and install_id')
  .option('--no-open', 'Print the URL instead of opening a browser (CI / headless)')
  .option('-m, --message <text>', 'Pre-fill the description (otherwise prompt is omitted)')
  .action(async (opts) => {
    const { runDoctor } = await import('../../core/doctor.js');
    const { getInstallId } = await import('../../core/install-id.js');

    const fbType = opts.feature ? 'feature' : opts.question ? 'question' : 'bug';
    const typeLabel = fbType.charAt(0).toUpperCase() + fbType.slice(1);
    const labels = `feedback,from-cli,${fbType}`;

    let body = (opts.message ?? '').trim() || `<!-- Describe the ${fbType} here -->`;

    if (opts.diagnostics !== false) {
      try {
        const result = await runDoctor({ packageRoot, packageVersion: pkg.version });
        const installCheck = result.checks.find(c => c.id === 'install_id');
        const installLine = installCheck
          ? `\n_Anonymous install ID: \`${(installCheck.summary.match(/[0-9a-f-]{36}/) ?? [getInstallId()])[0]}\` — included only because --diagnostics is on (default)._\n`
          : '';
        const otherChecks = result.checks
          .filter(c => c.id !== 'install_id')
          .sort((a, b) => {
            const order: Record<string, number> = { fail: 0, warn: 1, pass: 2 };
            return (order[a.status] ?? 3) - (order[b.status] ?? 3);
          });
        const lines = otherChecks.map(c => {
          const icon = c.status === 'fail' ? '❌' : c.status === 'warn' ? '⚠️' : '✅';
          const fix = c.fix ? ` _Fix: ${c.fix}_` : '';
          return `- ${icon} **${c.label}**: ${c.summary}${fix}`;
        });
        body += `\n\n---\n**System Info**\n- Version: \`${pkg.version}\`\n- Node: \`${process.version}\`\n- Platform: \`${process.platform} ${process.arch}\`\n\n**Diagnostics** (overall: ${result.status})${installLine}\n${lines.join('\n')}`;
      } catch {
        // doctor failed — still let the user file an issue
        body += `\n\n---\n**System Info**\n- Version: \`${pkg.version}\`\n- Node: \`${process.version}\`\n- Platform: \`${process.platform} ${process.arch}\`\n_Diagnostics unavailable: doctor probe failed._`;
      }
    }

    // The issue tracker is public. Nothing that names the account goes into
    // it, and nothing credential-shaped either — same two-pass redaction as
    // the dashboard's /v1/doctor egress, in the same order.
    body = redactUserPaths(redactSecrets(body));

    const url = `https://github.com/PCIRCLE-AI/memesh/issues/new?title=${encodeURIComponent(`[${typeLabel}] `)}&body=${encodeURIComponent(body)}&labels=${encodeURIComponent(labels)}`;

    if (opts.open === false) {
      console.log(url);
      return;
    }

    // Show what is about to be published, in the terminal, before the browser
    // opens. The browser does render the same text, but at the bottom of a
    // GitHub form the user opened in order to type — the diagnostics block
    // scrolls past and gets submitted unread. This is a public issue tracker:
    // the last chance to see the payload belongs in the place the user is
    // already looking.
    console.log('This will be pre-filled into a PUBLIC GitHub issue:');
    console.log('---');
    console.log(body);
    console.log('---');
    if (opts.diagnostics !== false) {
      console.log('Re-run with --no-diagnostics to leave out the install ID and the doctor report.');
    }

    // Cross-platform open. macOS `open`, Linux `xdg-open`, Windows `start`.
    const { spawn } = await import('child_process');
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'cmd'
      : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.unref();
      console.log(`Opened browser to file ${fbType} issue.`);
      console.log('Edit the title + body before submitting.');
    } catch {
      console.log('Could not open browser. URL:');
      console.log(url);
    }
  });

// --- reindex ---
program
  .command('reindex')
  .description('Regenerate vector embeddings for all entities (--fts rebuilds the keyword index instead)')
  .option('--namespace <namespace>', 'Reindex only entities in this namespace')
  .option('--fts', 'Rebuild the full-text keyword index instead of the vector index')
  .option(
    '--discard-generation',
    'Throw away a half-built vector index left by an interrupted rebuild, without rebuilding',
  )
  .option('--json', 'Output as JSON')
  // `--vectors` is retired. It is registered here ONLY so Commander does not
  // answer with its bare "unknown option" — which reads as a typo and teaches
  // nothing — and the action refuses it below with what to run instead. Same
  // treatment the retired `consolidate` command gets. Deletable at the next
  // major. It is hidden so it does not appear in --help as a live option.
  .addOption(new Option('--vectors').hideHelp())
  .action(async (opts) => {
    if (opts.vectors) {
      if (opts.json) {
        console.log(JSON.stringify({
          refused: true,
          reason: 'the --vectors flag is retired',
          fix: 'run plain memesh reindex; to change provider first: memesh config set embedder.provider ollama|openai',
          indexTouched: false,
        }));
        process.exit(1);
      }
      console.error('`memesh reindex --vectors` has been retired.'); // retired-flag-message: scan skips this line
      console.error('');
      console.error('It existed to consent to dropping every stored embedding before a refill.');
      console.error('A rebuild now happens beside the live index and replaces it only when');
      console.error('complete, so there is nothing left to consent to.');
      console.error('');
      console.error('Run plain `memesh reindex`. To change embedding provider first:');
      console.error('  memesh config set embedder.provider ollama   (or openai)');
      process.exit(1);
    }
    requireOneOf(opts.namespace, NAMESPACES, '--namespace');

    // The deliberate way out of a half-built generation. Two situations need it:
    // a rebuild the user has decided to abandon (the staging index otherwise sits
    // on disk indefinitely, roughly doubling vector storage, and nothing reclaims
    // it), and a generation whose marker cannot be read, where the code refuses
    // to guess between resuming — which could merge two embedding spaces — and
    // discarding, which throws away work already paid for.
    if (opts.discardGeneration) {
      await withDatabase(async () => {
        const read = readVectorGeneration();
        const staged = generationRowIds().size;
        if (read.state === 'none' && staged === 0) {
          if (opts.json) console.log(JSON.stringify({ discarded: false, staged: 0 }));
          else console.log('Nothing to discard: there is no half-built vector index.');
          return;
        }
        const describe = read.state === 'open'
          ? `${read.info.dimension}-dim, provider ${read.info.provider}, started ${read.info.startedAt}`
          : read.state === 'unreadable'
            ? `marker unreadable (${read.detail})`
            : 'no marker';
        discardVectorGeneration();
        if (opts.json) {
          console.log(JSON.stringify({ discarded: true, staged, generation: read, liveIndexTouched: false }));
        } else {
          console.log(
            `Discarded a half-built vector index: ${staged} staged vectors (${describe}).\n` +
            '   Your live index was not touched. Run `memesh reindex` to build a new one.'
          );
        }
      });
      return;
    }
    try {
      // The keyword index normally rebuilds itself once, on the first open
      // after an upgrade, guarded by a version marker in memesh_metadata. That
      // marker only moves forward, which leaves one state it cannot describe:
      // a database migrated by this version, then written to by an older one
      // that does not know the marker exists. Those memories are indexed with
      // the old rules and re-upgrading short-circuits past them, so a
      // partial-phrase query never finds them.
      //
      // Users reach that state legitimately — an npm-global and a
      // plugin-marketplace install side by side, or a downgrade to recover
      // from a bad release. This is the way out, and `memesh doctor` points
      // here when it detects it.
      if (opts.fts) {
        await withDatabase(async () => {
          const { entities } = reindexFts();
          if (opts.json) {
            console.log(JSON.stringify({ rebuilt: 'fts', entities }));
          } else {
            console.log(`✅ Keyword index rebuilt from ${entities} active memories.`);
          }
        });
        return;
      }

      // A full rebuild builds a new generation before anything is replaced, so
      // it is no longer destructive — but a provider that cannot produce a
      // vector at the configured width will fill nothing, and the run would
      // spend its whole length discovering that. `canRefillVectorIndex`
      // embeds one probe string and measures it, which is the only honest
      // form of the question. `isEmbeddingAvailable` cannot answer it: it
      // reports which provider the CONFIG names and says yes for openai and
      // ollama without checking a key, reaching an endpoint or comparing a
      // width.
      if (!opts.namespace && !(await canRefillVectorIndex())) {
        // Two different problems wore one message. "Unconfigured" and
        // "configured but not answering" need opposite advice: the first user
        // has no key or server to check, and was told to check one.
        const embedder = detectCapabilities().embeddings;
        const written = readConfig().embedder?.provider;
        // Three states, three sentences. "Absent" and "set to something MeMesh
        // does not know" both resolve to keyword-only, and the first version of
        // this message called both "no provider is configured" — so a user with
        // a typo'd provider saw `config list` name one and this line deny it.
        const known = embedder === 'openai' || embedder === 'ollama';
        const invalid = written !== undefined && !known;
        const unconfigured = written === undefined && !known;
        const reason = invalid
          ? `embedder.provider is set to '${written}', which is not a provider MeMesh knows`
          : unconfigured
            ? 'no embedding provider is configured, so there is nothing to build vectors with'
            : 'could not produce a test embedding at the configured vector width';
        const fix = invalid || unconfigured
          ? (invalid ? 'Set it to one MeMesh knows: ' : 'Pick one first: ') +
            '`memesh config set embedder.provider ollama` (local, needs `ollama serve`) ' +
            'or `memesh config set embedder.provider openai` (needs OPENAI_API_KEY). Until then, recall ' +
            'runs on keyword search, which needs no rebuild.'
          : 'Check that Ollama is running (or that your OpenAI API key is valid), then run this again. ' +
            '`memesh doctor` reports which provider is configured.';
        if (opts.json) {
          console.log(JSON.stringify({ refused: true, reason, fix, indexTouched: false }));
        } else {
          console.error(
            `❌ Nothing was rebuilt: ${reason}.\n` +
            '   Your existing index is untouched and still answering queries.\n' +
            `   ${fix}`
          );
        }
        process.exit(1);
      }

      await withDatabase(async () => {
        const result = await reindex({ namespace: opts.namespace });

        // Two questions, and the tick requires both answered yes: is every
        // memory holding a vector, and did everything this run tried to write
        // actually get written. The row count alone answers only the first,
        // and when the index is already full it answers it with the STALE
        // vectors — so a provider switch that refused every write reported
        // itself complete and exited 0. That is the case the command is for.
        // A third question, because the first two cannot see it. `missingVectors`
        // is counted against whatever is LIVE, so when the staging index was
        // refused that is the old index — complete by construction — and the run
        // read as success while stderr said the new one was not switched in.
        const incomplete = result.missingVectors > 0
          || result.failed > 0
          || result.generationSwapped === false
          || result.abortedAfter !== null;

        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          // Not a tick when the run could not embed everything. Saying so is the
          // whole point of counting outcomes.
          console.log(incomplete ? `⚠️  Reindex incomplete:` : `✅ Reindex complete:`);
          console.log(`   Processed: ${result.processed}`);
          console.log(`   Embedded:  ${result.embedded}`);
          console.log(`   Skipped:   ${result.skipped}`);

          if (incomplete) {
            if (result.abortedAfter !== null) {
              console.log(
                `   Stopped early after ${result.abortedAfter} entities: the provider failed ` +
                `repeatedly. Everything embedded so far is kept — run this again to continue.`
              );
            }
            if (result.generationSwapped === false) {
              console.log(
                `   The new index was NOT switched in, so your existing index is untouched ` +
                `and still answering queries.`
              );
            }
            if (result.missingVectors > 0) {
              console.log(`   Still without a vector: ${result.missingVectors}`);
            }
            if (result.failed > 0 && result.missingVectors === 0) {
              console.log(
                `   Could not be regenerated: ${result.failed} ` +
                `(these still hold their previous embedding)`
              );
            }
            for (const [outcome, count] of Object.entries(result.outcomes)) {
              if (outcome !== 'stored' && count > 0) console.log(`     ${outcome}: ${count}`);
            }
          } else if (!result.pendingReindexCleared) {
            // Everything asked for succeeded, but another namespace is behind, so
            // the database-wide flag stays set. Saying so beats a bare tick next
            // to a `memesh doctor` that still reports a reindex as outstanding.
            console.log(
              `   Note: ${result.missingVectorsDatabaseWide} memories in other namespaces still ` +
              `have no vector, so the reindex-needed flag stays set.`
            );
          }
        }

        // Exit non-zero so a script that shells out to this can tell an
        // incomplete run from a complete one. `✅` on stdout was the only
        // signal before, and it was printed either way.
        if (incomplete) process.exitCode = 1;
      });
    } catch (err) {
      if (err instanceof Error) {
        if (opts.json) console.log(JSON.stringify({ refused: true, reason: err.message, indexTouched: false }));
        else console.error(`❌ Reindex failed: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  });

// --- status ---
program
  .command('status')
  .description('Show MeMesh status and capabilities')
  .option('--cached', 'Use cached update info only (skip fresh npm lookup)')
  .action(async (opts) => {
    const caps = detectCapabilities();
    const { getCurrentInstallChannel, getInstallChannelSupport } = await import('../../core/install-channel.js');
    const install = getCurrentInstallChannel({ packageRoot });
    const installSupport = getInstallChannelSupport(install);
    const { getUpdateCheck, formatUpdateCheckStatus } = await import('../../core/version-check.js');
    const update = await getUpdateCheck(pkg.version, { preferFresh: !opts.cached });

    console.log(`MeMesh v${pkg.version}`);
    console.log(`Search level: ${caps.searchLevel} (${caps.searchLevel === 1 ? 'Smart Mode' : 'Core'})`);
    console.log(`Embeddings: ${caps.embeddings}`);
    // `?? 'default'` and not `${model}`: a provider set without a model is
    // normal — each one has a built-in default — and printing the literal
    // word "undefined" made a working setup look broken. The other half of
    // `LLM: undefined (undefined)`, a key with no provider, is now filtered
    // out in detectCapabilities and reaches this line as "not configured".
    console.log(`LLM: ${caps.llm ? `${caps.llm.provider} (${caps.llm.model ?? 'default'})` : 'not configured'}`);
    console.log(`Install method: ${installSupport.label}`);

    for (const line of formatUpdateCheckStatus(update)) {
      console.log(`\n${line}`);
    }

    // Codex round 39: when a fresh lookup confirms `latestVersion ===
    // currentVersion` on a deprecated install, the status line above
    // already says "deprecated, no upgrade target yet". Appending
    // "Update path: memesh update" would contradict it — the command
    // is a no-op against the same already-installed version. Suppress
    // the trailer ONLY in that exact (fresh + confirmed-no-target)
    // case; everywhere else, keep the actionable hint.
    const confirmedNoUpgradeTarget = Boolean(
      update?.currentVersionDeprecated
      && update.latestVersion
      && update.latestVersion === update.currentVersion
      && update.freshness === 'fresh',
    );
    if (!confirmedNoUpgradeTarget) {
      if (installSupport.recommendedCommand) {
        console.log(`Update path: ${installSupport.recommendedCommand}`);
      } else {
        console.log(`Update path: ${installSupport.guidance}`);
      }
    }
  });

// Default action: print help when run with no subcommand — the convention
// of git/npm/docker, and what a first-time user typing `memesh` to see
// "what can this do" actually needs. It used to start the dashboard server
// on a RANDOM port and hang the terminal: the P7 audit's worst first-run
// moment (no explanation, no way out but Ctrl+C, different URL every time).
// Dashboard is `memesh serve`, which prints its URL.
// DX: detect the unknown-subcommand case (`memesh nonexistent-cmd`) by
// inspecting program.args inside the root action and producing a clear
// error. We can't use Commander's `.argument()` here without leaking
// a confusing internal arg into `--help`, and `.command('*')` is
// deprecated in Commander 12+. Reading program.args is the documented
// escape hatch when no subcommand matched.
program.action(async () => {
  const stray = program.args.filter((a) => !a.startsWith('-'));
  if (stray.length > 0) {
    console.error(`Error: unknown command '${stray[0]}'.`);
    console.error(`       Run 'memesh --help' to see available commands.`);
    process.exitCode = 1;
    return;
  }
  // exitCode + return, not process.exit(): help is a 20+ line payload, and
  // exit() can truncate it mid-write when stdout is a pipe (`memesh | head`).
  // Nothing here opens a handle, so the process ends when the loop drains.
  program.outputHelp();
  process.exitCode = 0;
});

program.parse();
