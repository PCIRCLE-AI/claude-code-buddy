import { getDatabase } from '../db.js';
import type { LLMConfig } from './config.js';
import type { AnthropicResponse, OpenAIResponse, OllamaResponse } from './types.js';

const VALID_PREFIXES = ['project:', 'topic:', 'tech:', 'severity:', 'scope:'];

/**
 * Generate tags for an entity using LLM.
 * Returns 2-5 tags in format: project:X, topic:X, tech:X.
 * Returns empty array if LLM is unavailable or fails.
 */
export async function autoTag(
  name: string,
  type: string,
  observations: string[],
  llmConfig: LLMConfig
): Promise<string[]> {
  const prompt = `Given this memory entity, suggest 2-5 tags. Each tag must use one of these prefixes: project:, topic:, tech:, severity:, scope:.

Entity name: ${name}
Entity type: ${type}
Facts: ${observations.slice(0, 5).join('; ')}

Return ONLY a JSON array of tag strings, nothing else. Example: ["project:memesh", "topic:auth", "tech:sqlite"]`;

  try {
    const text = await callLLM(prompt, llmConfig);
    return parseTags(text);
  } catch {
    return [];
  }
}

/**
 * Apply auto-generated tags to an existing entity.
 * Fire-and-forget: caller should not await this.
 */
export async function autoTagAndApply(
  entityId: number,
  name: string,
  type: string,
  observations: string[],
  llmConfig: LLMConfig
): Promise<void> {
  const tags = await autoTag(name, type, observations, llmConfig);
  if (tags.length === 0) return;

  try {
    const db = getDatabase();
    const insertTag = db.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)');
    for (const tag of tags) {
      insertTag.run(entityId, tag);
    }
  } catch {
    // DB write failed — non-critical
  }
}

export function parseTags(text: string): string[] {
  try {
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];

    return arr
      .filter((t: unknown): t is string => typeof t === 'string')
      .map((t: string) => t.toLowerCase().trim())
      .filter((t: string) => VALID_PREFIXES.some(p => t.startsWith(p)))
      .slice(0, 5);
  } catch {
    return [];
  }
}

async function callLLM(prompt: string, config: LLMConfig): Promise<string> {
  // Use provider-specific env var to avoid sending wrong key to wrong provider
  let apiKey = config.apiKey;
  if (!apiKey) {
    if (config.provider === 'anthropic') apiKey = process.env.ANTHROPIC_API_KEY;
    else if (config.provider === 'openai') apiKey = process.env.OPENAI_API_KEY;
  }

  if (config.provider === 'anthropic') {
    if (!apiKey) throw new Error('No API key');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model || 'claude-haiku-4-5', max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json() as AnthropicResponse;
    return data.content?.[0]?.text || '';
  }

  if (config.provider === 'openai') {
    if (!apiKey) throw new Error('No API key');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model || 'gpt-4o-mini', max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json() as OpenAIResponse;
    return data.choices?.[0]?.message?.content || '';
  }

  if (config.provider === 'ollama') {
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const res = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model || 'llama3.2', prompt, stream: false }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const data = await res.json() as OllamaResponse;
    return data.response || '';
  }

  return '';
}
