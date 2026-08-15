// =============================================================================
// Shared Zod validation schemas for all transports (MCP, HTTP, CLI)
// Single source of truth — imported by handlers.ts and server.ts
// =============================================================================

import { z } from 'zod';
import { NAMESPACES } from '../core/types.js';
import { TITLE_MAX_LENGTH } from '../core/title.js';

const sanitizeName = (s: string) => s.replace(/[\r\n\t]+/g, ' ').trim();
const nameField = z.string().min(1).max(255).transform(sanitizeName).refine(s => s.length > 0, {
  message: 'Name must not be blank after sanitization',
});
// A blank-after-sanitize title collapses to `undefined`, not `''` — the
// RememberInput contract is "omit to leave an existing title untouched"
// (same rule namespace already follows), and an empty string would instead
// read as "explicitly clear the title", which is not what a caller sending
// whitespace meant.
const titleField = z
  .string()
  // TITLE_MAX_LENGTH from core/title.ts — the same constant the hook
  // generators and the backfill truncate to. Validators REJECT above the
  // cap (an API caller can react); generators truncate (nobody to bounce
  // the input back to).
  .max(TITLE_MAX_LENGTH)
  .transform(sanitizeName)
  .transform(s => (s.length > 0 ? s : undefined))
  .optional();

export const RememberSchema = z.object({
  name: nameField,
  type: z.string().min(1).max(100),
  title: titleField,
  observations: z.array(z.string().max(10000)).max(100).optional(),
  tags: z.array(z.string().max(255)).max(50).optional(),
  relations: z
    .array(z.object({ to: z.string().min(1).max(255), type: z.string().min(1).max(100) }))
    .max(50)
    .optional(),
  namespace: z.enum(NAMESPACES).optional(),
});

export const RecallSchema = z.object({
  query: z.string().max(1000).optional(),
  tag: z.string().max(255).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  include_archived: z.boolean().optional(),
  namespace: z.enum(NAMESPACES).optional(),
  cross_project: z.boolean().optional(),
});
// Deliberately NO refine requiring query/tag: `{}` is the documented
// list-recent mode (tests/transports/http.test.ts pins it). The P7 audit
// initially read the empty-DB `[]` answer as a silent failure; it is the
// list mode listing an empty database.

// `.strict()` because on THIS tool a stripped key is destructive. Zod drops
// unknown properties by default, and `forget` branches on whether
// `observation` is present: absent means "archive the whole entity". So
// `{name, observations: "one fact"}` — the plural, which is exactly the word
// `remember` uses for the same concept — loses the key, falls through to the
// archive branch, and answers `{"archived": true}`. The caller asked to remove
// one fact and was told it succeeded; the entity is gone from recall and from
// session-start injection with both observations still in it.
//
// Rejecting is the fix, not aliasing the plural: an alias would invent API
// surface, while the rejection tells the caller the exact key it got wrong.
export const ForgetSchema = z.object({
  name: nameField,
  observation: z.string().max(10000).optional(),
}).strict();

export const ExportSchema = z.object({
  tag: z.string().max(255).optional(),
  // A typo here produced a successful EMPTY backup. See ImportSchema below for
  // why these two were the loose ones.
  namespace: z.enum(NAMESPACES).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
});

export const ExportResultSchema = z.object({
  version: z.string(),
  exported_at: z.string(),
  entity_count: z.number(),
  entities: z.array(z.object({
    name: nameField,
    type: z.string().min(1).max(100),
    namespace: z.string(),
    observations: z.array(z.string().max(10000)),
    tags: z.array(z.string().max(255)),
    relations: z.array(z.object({ to: z.string().min(1).max(255), type: z.string().min(1).max(100) })),
  })),
});

export const ImportSchema = z.object({
  data: ExportResultSchema,
  // The enum, not a free string. `remember` and `recall` validated this field
  // from the start; `import` and `export` were `z.string().max(50)`, and once
  // an explicit namespace began MOVING entities that already exist, that
  // looseness became a way to relocate memories into a scope nothing queries —
  // gone from every scoped view while the import reports them appended. Core
  // refuses the same value in `importMemories`, so the CLI is covered too.
  namespace: z.enum(NAMESPACES).optional(),
  merge_strategy: z.enum(['skip', 'overwrite', 'append']),
});

export const LearnSchema = z.object({
  error: z.string().min(1).max(5000),
  fix: z.string().min(1).max(5000),
  root_cause: z.string().max(5000).optional(),
  prevention: z.string().max(5000).optional(),
  severity: z.enum(['critical', 'major', 'minor']).optional(),
});

// Every field optional, including the project: a call with no fields at all is
// the READ. Empty string is meaningful and therefore allowed — it is how a
// resolved blocker gets removed, so `.min(1)` here would make the state
// append-only and keep injecting a blocker that is gone.
export const TaskStateSchema = z.object({
  project: z.string().min(1).max(200).optional(),
  goal: z.string().max(1000).optional(),
  next: z.string().max(1000).optional(),
  blocked: z.string().max(1000).optional(),
  done: z.string().max(1000).optional(),
// `.strict()`, alone among the schemas here, because on THIS tool a stripped
// key changes the operation. "No recognised field" is what marks a call as a
// read, so a model that writes `blocker:` for `blocked:` would have its key
// dropped, fall through to the read branch, and get a success-shaped response
// back with nothing recorded. Everywhere else an unknown key still leaves the
// intended write intact. It also makes the runtime agree with the
// `additionalProperties: false` this tool already publishes.
}).strict();

export const UserPatternsSchema = z.object({
  categories: z.array(z.enum(['workSchedule', 'toolPreferences', 'focusAreas', 'workflow', 'strengths', 'learningAreas'])).optional()
    .describe('Specific categories to return. Omit for all.'),
});

