// =============================================================================
// Why — file-level attribution: which commits memesh remembers touching a
// file, which sessions those commits came from, and which memories are
// associated with the file.
//
// Two halves with different trust models, kept as separate functions:
//
//   resolveFileCommits() shells out to LOCAL git (log / blame). Only the CLI
//   calls it, with the user's own cwd. The HTTP route never runs git — it
//   takes commit hashes the caller resolved themselves, so the server's
//   attack surface stays pure-DB.
//
//   explainCommits() is the DB half, shared by CLI and HTTP.
//
// Honesty contract (the reason this module exists at all): every gap in the
// chain is reported as a TYPED abstention, never papered over. A commit that
// predates memesh capture is `no_commit_entity`; a commit entity written
// before commits recorded their session is `no_session_link`. The
// `file_memories` block is labelled `basis: 'file-tag'` because it is
// associated by basename tag, NOT derived from the commits — the two must
// never be presented as the same kind of evidence.
// =============================================================================

import { execFileSync } from 'child_process';
import type { MemeshDatabase } from '../storage/sqlite.js';

/** Everything this module can decline to answer, as machine-readable codes.
 *  Presentation layers map these to sentences; core never emits prose. */
export type WhyAbstention =
  | 'git_unavailable'
  | 'not_a_git_repo'
  | 'file_not_tracked'
  | 'line_out_of_range'
  | 'line_uncommitted'
  | 'no_commit_entity'
  | 'no_session_link';

export interface WhyGitCommit {
  /** Full 40-char SHA from git; may be shorter when supplied by an API caller. */
  hash: string;
  subject?: string;
  date?: string;
}

export interface WhyEntityRef {
  id: number;
  name: string;
  type: string;
  title: string | null;
  created_at: string;
}

export interface WhyCommitAttribution {
  commit: WhyGitCommit;
  /** The commit entity the hooks captured, or null (see abstentions). */
  entity: (WhyEntityRef & { observations: string[] }) | null;
  /** Session the commit was made in — only known for commits captured after
   *  post-commit started recording `metadata.session_id`. */
  session: { session_id: string; entities: WhyEntityRef[] } | null;
  abstentions: WhyAbstention[];
}

export interface WhyResult {
  file: string;
  basename: string;
  /** Project scope applied to the file-tag half; null = all projects. */
  project: string | null;
  commits: WhyCommitAttribution[];
  file_memories: {
    /** These are associated by `file:<basename>` tag — the same signal
     *  pre-edit-recall uses — not derived from the commit chain. */
    basis: 'file-tag';
    entities: WhyEntityRef[];
  };
  /** Abstentions about the query as a whole (git-side failures). */
  abstentions: WhyAbstention[];
}

export interface ResolveCommitsResult {
  commits: WhyGitCommit[];
  abstention: WhyAbstention | null;
}

const GIT_TIMEOUT_MS = 5000;

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** All-zero hash git blame uses for lines not yet committed. */
const UNCOMMITTED_HASH = /^0+$/;

/**
 * Resolve which commits touched `file` via local git. CLI-only — see the
 * module header for why the HTTP surface never reaches this function.
 */
export function resolveFileCommits(
  repoDir: string,
  file: string,
  opts: { line?: number; limit?: number } = {},
): ResolveCommitsResult {
  const limit = opts.limit ?? 10;

  try {
    runGit(repoDir, ['rev-parse', '--show-toplevel']);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { commits: [], abstention: code === 'ENOENT' ? 'git_unavailable' : 'not_a_git_repo' };
  }

  try {
    runGit(repoDir, ['ls-files', '--error-unmatch', '--', file]);
  } catch {
    return { commits: [], abstention: 'file_not_tracked' };
  }

  if (opts.line != null) {
    let out: string;
    try {
      out = runGit(repoDir, ['blame', '-L', `${opts.line},${opts.line}`, '--porcelain', '--', file]);
    } catch {
      // The file is tracked (checked above), so a blame failure here is the
      // line number, not the file.
      return { commits: [], abstention: 'line_out_of_range' };
    }
    // Porcelain: first line is `<hash> <orig-line> <final-line> ...`; a
    // `summary <subject>` header line follows for the commit.
    const hash = out.split('\n')[0]?.split(' ')[0] ?? '';
    if (!/^[a-f0-9]{7,40}$/.test(hash)) return { commits: [], abstention: 'line_out_of_range' };
    if (UNCOMMITTED_HASH.test(hash)) return { commits: [], abstention: 'line_uncommitted' };
    const summary = out.split('\n').find((l) => l.startsWith('summary '));
    return { commits: [{ hash, subject: summary?.slice('summary '.length) }], abstention: null };
  }

  let out: string;
  try {
    out = runGit(repoDir, [
      'log', '-n', String(limit), '--follow', '--format=%H%x09%ad%x09%s', '--date=short', '--', file,
    ]);
  } catch {
    // Tracked file, git present — a log failure means no history is
    // answerable (e.g. an empty repo). Report the honest empty set.
    return { commits: [], abstention: null };
  }
  const commits: WhyGitCommit[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [hash, date, subject] = line.split('\t');
    if (hash && /^[a-f0-9]{7,40}$/.test(hash)) commits.push({ hash, date, subject });
  }
  return { commits, abstention: null };
}

/** Basename that survives both path separators — mirrors the hooks' file-tag
 *  convention (session-summary tags by basename, not path). */
export function basenameOf(file: string): string {
  return file.split(/[\\/]/).filter(Boolean).pop() ?? file;
}

function parseMetadata(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Match a full (or longer-abbreviated) hash against the `commit-<abbrev>`
 * naming post-commit uses. Git prints the ABBREVIATED hash in `[branch abc1234]`
 * and that is what the entity name carries, while blame/log emit full SHAs —
 * so an exact-name lookup finds nothing, ever. Prefix-match both directions:
 * the stored abbrev may be shorter than the query, or (API callers may send
 * 7-char hashes) the query shorter than a longer stored abbrev.
 */
function findCommitEntity(
  db: MemeshDatabase,
  hash: string,
): (WhyEntityRef & { metadata: Record<string, unknown> | null }) | null {
  // The prefix join is a substring comparison, NOT a LIKE match, and the
  // difference is the whole security of this lookup.
  //
  // The query used to read `? LIKE substr(name, 8) || '%'`, which makes the
  // STORED NAME the pattern. `%` and `_` are wildcards there, and the name is
  // writable through the ordinary public API: `remember` accepts
  // `commit-%%%%…` (nameField only strips control characters), and so does an
  // import bundle. One such entity answers for EVERY hash, and
  // `ORDER BY length(name) DESC` makes it win deterministically — real
  // abbreviations are 7-40 characters and a name may be 255. Measured: a
  // seeded `commit-_______` was returned for an unrelated 40-char hash, and
  // the caller's abstention flipped from `no_commit_entity` to a confidently
  // asserted memory. The parameters were always bound correctly; binding does
  // not constrain LIKE semantics over attacker-writable data.
  //
  // `substr(?, 1, length(substr(name,8))) = substr(name,8)` compares text,
  // so a stored `%` matches only a literal `%` — which no real hash contains.
  // The hex guard is belt-and-braces: it also keeps a junk name out of the
  // candidate set entirely.
  const rows = db.prepare(
    `SELECT id, name, type, title, created_at, metadata FROM entities
     WHERE type = 'commit' AND name LIKE 'commit-%'
       AND length(substr(name, 8)) >= 7
       AND substr(name, 8) GLOB '[0-9a-fA-F]*'
       AND (
         substr(?, 1, length(substr(name, 8))) = substr(name, 8)
         OR substr(substr(name, 8), 1, length(?)) = ?
       )
     ORDER BY length(name) DESC`,
  ).all(hash, hash, hash) as unknown as Array<WhyEntityRef & { metadata: string | null }>;
  if (rows.length === 0) return null;
  // Longest stored abbrev wins if several match (same commit captured twice
  // at different abbreviation lengths).
  const row = rows[0];
  return { ...row, metadata: parseMetadata(row.metadata) };
}

function observationsOf(db: MemeshDatabase, entityId: number): string[] {
  const rows = db.prepare(
    'SELECT content FROM observations WHERE entity_id = ? ORDER BY id',
  ).all(entityId) as Array<{ content: string }>;
  return rows.map((r) => r.content);
}

function sessionEntities(db: MemeshDatabase, sessionId: string): WhyEntityRef[] {
  return db.prepare(
    `SELECT DISTINCT e.id, e.name, e.type, e.title, e.created_at
     FROM entities e JOIN tags t ON t.entity_id = e.id
     WHERE t.tag = ? AND e.status != 'archived'
     ORDER BY e.created_at`,
  ).all(`session:${sessionId}`) as unknown as WhyEntityRef[];
}

/**
 * The DB half: join resolved commits to captured commit entities and their
 * sessions, and collect file-tag-associated memories. Shared by the CLI and
 * `POST /v1/why`.
 */
export function explainCommits(
  db: MemeshDatabase,
  input: {
    file: string;
    commits?: WhyGitCommit[];
    project?: string | null;
    limit?: number;
    abstentions?: WhyAbstention[];
  },
): WhyResult {
  const basename = basenameOf(input.file);
  const limit = input.limit ?? 10;
  const project = input.project ?? null;

  const commits: WhyCommitAttribution[] = [];
  for (const commit of (input.commits ?? []).slice(0, limit)) {
    const abstentions: WhyAbstention[] = [];
    const found = findCommitEntity(db, commit.hash);
    let entity: WhyCommitAttribution['entity'] = null;
    let session: WhyCommitAttribution['session'] = null;
    if (!found) {
      // Predates memesh capture, made without hooks, or made on another
      // machine — the graph honestly has nothing for this hash.
      abstentions.push('no_commit_entity');
    } else {
      entity = {
        id: found.id, name: found.name, type: found.type,
        title: found.title, created_at: found.created_at,
        observations: observationsOf(db, found.id),
      };
      const sessionId = found.metadata?.session_id;
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        session = { session_id: sessionId, entities: sessionEntities(db, sessionId) };
      } else {
        // Captured before post-commit recorded session ids (or the payload
        // had none). The link does not exist — say so, do not guess one.
        abstentions.push('no_session_link');
      }
    }
    commits.push({ commit, entity, session, abstentions });
  }

  // File-tag half — the same two tags session-summary writes and
  // pre-edit-recall reads: `file:<basename>` and `file:<basename-no-ext>`.
  const noExt = basename.replace(/\.[^.]+$/, '');
  const fileTags = noExt && noExt !== basename
    ? [`file:${basename}`, `file:${noExt}`]
    : [`file:${basename}`];
  const tagPlaceholders = fileTags.map(() => '?').join(',');
  const params: string[] = [...fileTags];
  let projectClause = '';
  if (project) {
    projectClause = `AND EXISTS (SELECT 1 FROM tags pt WHERE pt.entity_id = e.id AND pt.tag = ?)`;
    params.push(`project:${project}`);
  }
  const fileMemories = db.prepare(
    `SELECT DISTINCT e.id, e.name, e.type, e.title, e.created_at
     FROM entities e JOIN tags t ON t.entity_id = e.id
     WHERE t.tag IN (${tagPlaceholders})
       AND e.status != 'archived'
       AND e.type != 'commit'
       ${projectClause}
     ORDER BY e.created_at DESC
     LIMIT ?`,
  ).all(...params, limit) as unknown as WhyEntityRef[];

  return {
    file: input.file,
    basename,
    project,
    commits,
    file_memories: { basis: 'file-tag', entities: fileMemories },
    abstentions: input.abstentions ?? [],
  };
}
