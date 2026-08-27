import { createHash } from 'node:crypto';
import type { MemeshDatabase } from '../storage/sqlite.js';

export const PRODUCT_IMPROVEMENT_KIND = 'product_improvement' as const;

export type ImprovementPriority = 'p0' | 'p1' | 'p2' | 'p3';

export interface ProductImprovementPayload {
  name: string;
  title: string;
  type: typeof PRODUCT_IMPROVEMENT_KIND;
  observations: string[];
  tags: string[];
  improvement: {
    problem: string;
    proposed_change: string;
    verification_scenario: string;
    success_criteria: string[];
    priority: ImprovementPriority;
    source_names: string[];
    source_host?: string;
  };
}

export interface StageProductImprovementInput {
  project: string;
  source_names: string[];
  title: string;
  problem: string;
  proposed_change: string;
  verification_scenario: string;
  success_criteria: string[];
  priority?: ImprovementPriority;
  sourceHost?: string;
}

export interface ProductImprovementProposalResult {
  proposal_id: number;
  status: string;
  created: boolean;
  title: string;
  source_ids: number[];
  review: {
    required: true;
    authority: 'human';
    state: 'pending' | 'settled';
    inspect: string;
    accept?: string;
    reject?: string;
  };
}

export interface ProductImprovementStatus {
  proposal_id: number;
  status: string;
  title: string;
  project: string;
  source_ids: number[];
  reason: string | null;
  created_at: string;
  reviewed_at: string | null;
  accepted_entity_name: string | null;
}

type ProposalRow = {
  id: number;
  project: string;
  source_ids: string;
  proposed_digest: string;
  status: string;
  reason: string | null;
  created_at: string;
  reviewed_at: string | null;
};

function clean(label: string, value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) throw new Error(`${label} must not be blank`);
  if (normalized.length > max) throw new Error(`${label} must be at most ${max} characters`);
  return normalized;
}

function canonicalCriteria(values: string[]): string[] {
  const unique = new Set(values.map((value) => clean('success criterion', value, 1000)));
  if (unique.size === 0) throw new Error('at least one success criterion is required');
  if (unique.size > 20) throw new Error('at most 20 success criteria are allowed');
  return [...unique].sort((a, b) => a.localeCompare(b));
}

function parseSourceIds(raw: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('product-improvement proposal carries malformed source ids');
  }
  if (!Array.isArray(parsed) || parsed.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error('product-improvement proposal carries malformed source ids');
  }
  return parsed as number[];
}

function parsePayload(raw: string): ProductImprovementPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error('product-improvement proposal carries malformed content');
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('product-improvement proposal carries malformed content');
  }
  const candidate = payload as Partial<ProductImprovementPayload>;
  const improvement = candidate.improvement;
  if (
    candidate.type !== PRODUCT_IMPROVEMENT_KIND
    || typeof candidate.name !== 'string'
    || typeof candidate.title !== 'string'
    || !Array.isArray(candidate.observations)
    || candidate.observations.length === 0
    || candidate.observations.some((value) => typeof value !== 'string' || !value.trim() || value.length > 10_000)
    || !Array.isArray(candidate.tags)
    || candidate.tags.some((value) => typeof value !== 'string' || value.length > 255)
    || !improvement
    || typeof improvement.problem !== 'string'
    || typeof improvement.proposed_change !== 'string'
    || typeof improvement.verification_scenario !== 'string'
    || !Array.isArray(improvement.success_criteria)
    || improvement.success_criteria.length === 0
    || improvement.success_criteria.some((value) => typeof value !== 'string' || !value.trim() || value.length > 1000)
    || !Array.isArray(improvement.source_names)
    || improvement.source_names.length === 0
    || improvement.source_names.some((value) => typeof value !== 'string' || !value.trim() || value.length > 255)
    || !['p0', 'p1', 'p2', 'p3'].includes(String(improvement.priority))
    || (improvement.source_host !== undefined && typeof improvement.source_host !== 'string')
  ) {
    throw new Error('product-improvement proposal carries malformed content');
  }
  clean('proposal name', candidate.name, 255);
  clean('title', candidate.title, 200);
  clean('problem', improvement.problem, 5000);
  clean('proposed change', improvement.proposed_change, 5000);
  clean('verification scenario', improvement.verification_scenario, 5000);
  if (improvement.source_host !== undefined) clean('source host', improvement.source_host, 64);
  return candidate as ProductImprovementPayload;
}

function proposalResult(row: ProposalRow, created: boolean): ProductImprovementProposalResult {
  const payload = parsePayload(row.proposed_digest);
  const pending = row.status === 'pending';
  return {
    proposal_id: row.id,
    status: row.status,
    created,
    title: payload.title,
    source_ids: parseSourceIds(row.source_ids),
    review: {
      required: true,
      authority: 'human',
      state: pending ? 'pending' : 'settled',
      inspect: `memesh dream show ${row.id}`,
      ...(pending ? {
        accept: `memesh dream accept ${row.id}`,
        reject: `memesh dream reject ${row.id} --reason <text>`,
      } : {}),
    },
  };
}

/**
 * Stage one governed memory-to-product proposal.
 *
 * The whole resolve/dedupe/insert sequence takes an IMMEDIATE transaction so
 * two agent hosts submitting the same proposal cannot both pass the read and
 * create separate review items. No source is changed here; staging is a
 * reversible request for human review, never a product-policy mutation.
 */
export function stageProductImprovement(
  db: MemeshDatabase,
  input: StageProductImprovementInput,
): ProductImprovementProposalResult {
  const project = clean('project', input.project, 200);
  const title = clean('title', input.title, 200);
  const problem = clean('problem', input.problem, 5000);
  const proposedChange = clean('proposed change', input.proposed_change, 5000);
  const verificationScenario = clean('verification scenario', input.verification_scenario, 5000);
  const successCriteria = canonicalCriteria(input.success_criteria);
  const priority = input.priority ?? 'p1';

  const sourceNames = [...new Set(input.source_names.map((name) => clean('source name', name, 255)))]
    .sort((a, b) => a.localeCompare(b));
  if (sourceNames.length === 0) throw new Error('at least one source memory is required');
  if (sourceNames.length > 20) throw new Error('at most 20 source memories are allowed');

  const tx = db.transaction(() => {
    const placeholders = sourceNames.map(() => '?').join(',');
    const sourceRows = db.prepare(
      `SELECT id, name, status FROM entities WHERE name IN (${placeholders}) ORDER BY id ASC`,
    ).all(...sourceNames) as Array<{ id: number; name: string; status: string }>;
    const foundByName = new Map(sourceRows.map((row) => [row.name, row]));
    const unavailable = sourceNames.filter((name) => {
      const row = foundByName.get(name);
      return !row || row.status !== 'active';
    });
    if (unavailable.length > 0) {
      throw new Error(`source memories must exist and be active: ${unavailable.join(', ')}`);
    }
    const sourceIds = sourceRows.map((row) => row.id).sort((a, b) => a - b);

    const canonical = {
      project,
      source_ids: sourceIds,
      title,
      problem,
      proposed_change: proposedChange,
      verification_scenario: verificationScenario,
      success_criteria: successCriteria,
      priority,
    };
    const digest = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    const clusterKey = `product-improvement:${digest}`;

    const existing = db.prepare(
      `SELECT id, project, source_ids, proposed_digest, status, reason, created_at, reviewed_at
       FROM dream_proposals
       WHERE kind = ? AND cluster_key = ? AND status = 'pending'
       ORDER BY id ASC LIMIT 1`,
    ).get(PRODUCT_IMPROVEMENT_KIND, clusterKey) as ProposalRow | undefined;
    if (existing) return proposalResult(existing, false);

    const priorCycles = db.prepare(
      `SELECT COUNT(*) AS n FROM dream_proposals WHERE kind = ? AND cluster_key = ?`,
    ).get(PRODUCT_IMPROVEMENT_KIND, clusterKey) as { n: number };
    const reviewCycle = priorCycles.n + 1;

    const sourceHost = input.sourceHost
      ? clean('source host', input.sourceHost, 64)
      : undefined;
    const baseName = `product-improvement-${digest.slice(0, 24)}`;
    const name = reviewCycle === 1 ? baseName : `${baseName}-r${reviewCycle}`;
    const payload: ProductImprovementPayload = {
      name,
      title,
      type: PRODUCT_IMPROVEMENT_KIND,
      observations: [
        `Problem: ${problem}`,
        `Proposed change: ${proposedChange}`,
        `Verification scenario: ${verificationScenario}`,
        ...successCriteria.map((criterion) => `Success criterion: ${criterion}`),
        'State: pending human review; implementation and outcome are not verified.',
      ],
      tags: [
        `project:${project}`,
        `priority:${priority}`,
        'status:proposed',
        'source:product-improvement-proposal',
      ],
      improvement: {
        problem,
        proposed_change: proposedChange,
        verification_scenario: verificationScenario,
        success_criteria: successCriteria,
        priority,
        source_names: sourceNames,
        ...(sourceHost ? { source_host: sourceHost } : {}),
      },
    };

    const inserted = db.prepare(
      `INSERT INTO dream_proposals
        (project, cluster_key, source_ids, proposed_digest, llm_model, prompt_version, source_kind, kind)
       VALUES (?, ?, ?, ?, NULL, 'product-improvement-v1', 'entities', ?)`,
    ).run(
      project,
      clusterKey,
      JSON.stringify(sourceIds),
      JSON.stringify(payload),
      PRODUCT_IMPROVEMENT_KIND,
    );
    const row = db.prepare(
      `SELECT id, project, source_ids, proposed_digest, status, reason, created_at, reviewed_at
       FROM dream_proposals WHERE id = ?`,
    ).get(Number(inserted.lastInsertRowid)) as ProposalRow;
    return proposalResult(row, true);
  });

  return tx.immediate();
}

export function getProductImprovementStatus(
  db: MemeshDatabase,
  proposalId: number,
): ProductImprovementStatus {
  if (!Number.isInteger(proposalId) || proposalId <= 0) {
    throw new Error('proposal id must be a positive integer');
  }
  const row = db.prepare(
    `SELECT id, project, source_ids, proposed_digest, status, reason, created_at, reviewed_at
     FROM dream_proposals WHERE id = ? AND kind = ?`,
  ).get(proposalId, PRODUCT_IMPROVEMENT_KIND) as ProposalRow | undefined;
  if (!row) throw new Error(`product-improvement proposal #${proposalId} not found`);
  const payload = parsePayload(row.proposed_digest);
  const accepted = db.prepare(
    `SELECT name FROM entities
     WHERE json_valid(metadata)
       AND json_extract(metadata, '$.proposal_id') = ?
       AND type = ?
     LIMIT 1`,
  ).get(proposalId, PRODUCT_IMPROVEMENT_KIND) as { name: string } | undefined;
  return {
    proposal_id: row.id,
    status: row.status,
    title: payload.title,
    project: row.project,
    source_ids: parseSourceIds(row.source_ids),
    reason: row.reason,
    created_at: row.created_at,
    reviewed_at: row.reviewed_at,
    accepted_entity_name: accepted?.name ?? null,
  };
}

export function readProductImprovementPayload(raw: string): ProductImprovementPayload {
  return parsePayload(raw);
}

export function readProductImprovementSourceIds(raw: string): number[] {
  return parseSourceIds(raw);
}
