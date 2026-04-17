// =============================================================================
// Consolidator — LLM-powered observation compression
// Extracted from operations.ts for single-responsibility
// =============================================================================

import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { detectCapabilities } from './config.js';
import type { LLMConfig } from './config.js';
import type { AnthropicResponse, ConsolidateInput, ConsolidateResult, Entity, OllamaResponse, OpenAIResponse } from './types.js';

/**
 * Compress verbose entity observations using an LLM (Level 1 / Smart Mode only).
 * Original observations are removed from the entity and replaced with a compact summary.
 * The LLM summary preserves all key facts in 2–3 dense sentences.
 * If the LLM fails or produces no shorter result, the entity is left unchanged.
 * Requires an LLM provider configured via `memesh setup` or environment variables.
 */
export async function consolidate(args: ConsolidateInput): Promise<ConsolidateResult> {
  const caps = detectCapabilities();
  if (!caps.llm) {
    return {
      consolidated: 0,
      entities_processed: [],
      observations_before: 0,
      observations_after: 0,
      error: 'Consolidation requires an LLM provider. Run: memesh setup',
    };
  }

  const db = getDatabase();
  const kg = new KnowledgeGraph(db);
  const minObs = args.min_observations ?? 5;

  // Collect candidates
  let entities: Entity[];
  if (args.name) {
    const entity = kg.getEntity(args.name);
    entities = entity ? [entity] : [];
  } else if (args.tag) {
    entities = kg.search(undefined, { tag: args.tag, limit: 100 });
  } else {
    entities = kg.listRecent(100);
  }

  // Only process entities that have enough observations
  entities = entities.filter((e) => e.observations.length >= minObs);

  if (entities.length === 0) {
    return { consolidated: 0, entities_processed: [], observations_before: 0, observations_after: 0 };
  }

  let totalBefore = 0;
  let totalAfter = 0;
  const processed: string[] = [];

  for (const entity of entities) {
    totalBefore += entity.observations.length;

    try {
      const compressed = await compressObservations(entity.observations, caps.llm);

      if (compressed.length < entity.observations.length) {
        // Replace observations: remove old ones, add compressed set.
        // Note: removeObservation() permanently deletes the row. The LLM summary
        // preserves the knowledge in denser form.
        for (const obs of entity.observations) {
          kg.removeObservation(entity.name, obs);
        }
        kg.createEntity(entity.name, entity.type, {
          observations: compressed,
        });
        totalAfter += compressed.length;
        processed.push(entity.name);
      } else {
        // Compression produced no gain — leave entity unchanged
        totalAfter += entity.observations.length;
      }
    } catch {
      // LLM failure — leave entity unchanged
      totalAfter += entity.observations.length;
    }
  }

  return {
    consolidated: processed.length,
    entities_processed: processed,
    observations_before: totalBefore,
    observations_after: totalAfter,
  };
}

/**
 * Ask the configured LLM to compress a list of observations into 2–3 dense sentences.
 * Returns the compressed array, or the original array if the LLM response is unusable.
 */
async function compressObservations(observations: string[], llmConfig: LLMConfig): Promise<string[]> {
  const prompt =
    `You have ${observations.length} observations about a topic. ` +
    `Compress them into 2-3 dense, information-rich sentences that preserve all key facts. ` +
    `Return ONLY a JSON array of strings, no explanation.\n\n` +
    `Observations:\n${observations.map((o, i) => `${i + 1}. ${o}`).join('\n')}`;

  let text: string;

  if (llmConfig.provider === 'anthropic') {
    const apiKey = llmConfig.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return observations;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: llmConfig.model || 'claude-haiku-4-5',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`Anthropic API error: ${response.status}`);
    const data = await response.json() as AnthropicResponse;
    text = data.content?.[0]?.text || '[]';
  } else if (llmConfig.provider === 'openai') {
    const apiKey = llmConfig.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) return observations;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: llmConfig.model || 'gpt-4o-mini',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`OpenAI API error: ${response.status}`);
    const data = await response.json() as OpenAIResponse;
    text = data.choices?.[0]?.message?.content || '[]';
  } else if (llmConfig.provider === 'ollama') {
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const response = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: llmConfig.model || 'llama3.2',
        prompt,
        stream: false,
      }),
    });
    if (!response.ok) throw new Error(`Ollama error: ${response.status}`);
    const data = await response.json() as OllamaResponse;
    text = data.response || '[]';
  } else {
    return observations;
  }

  // Parse JSON array from LLM response
  try {
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr) && arr.length > 0) {
        const filtered = arr.filter((s: any) => typeof s === 'string' && s.length > 0);
        if (filtered.length > 0) return filtered;
      }
    }
  } catch {}

  return observations; // fallback: keep originals unchanged
}
