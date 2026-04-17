import { detectCapabilities } from './config.js';
import type { LLMConfig } from './config.js';
import type { AnthropicResponse, OpenAIResponse, OllamaResponse } from './types.js';

/**
 * Expand a search query into related keywords using an LLM.
 * Returns an array of search terms (original + expanded).
 * Falls back to [query] if LLM is unavailable or fails.
 */
export async function expandQuery(query: string): Promise<string[]> {
  const caps = detectCapabilities();
  if (!caps.llm) return [query]; // Level 0: no expansion

  try {
    const expanded = await callLLMForExpansion(query, caps.llm);
    // Always include the original query so it's searched verbatim too
    if (!expanded.includes(query)) {
      expanded.unshift(query);
    }
    return expanded;
  } catch {
    return [query]; // Graceful fallback
  }
}

async function callLLMForExpansion(query: string, config: LLMConfig): Promise<string[]> {
  const prompt = `Given the search query "${query}", generate a list of 5-10 related keywords and synonyms that someone might use to describe the same concept. Return ONLY a JSON array of strings, no explanation. Example: ["keyword1", "keyword2", ...]`;

  if (config.provider === 'anthropic') {
    return await callAnthropic(prompt, config);
  } else if (config.provider === 'openai') {
    return await callOpenAI(prompt, config);
  } else if (config.provider === 'ollama') {
    return await callOllama(prompt, config);
  }
  return [query];
}

async function callAnthropic(prompt: string, config: LLMConfig): Promise<string[]> {
  const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model || 'claude-haiku-4-5',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) throw new Error(`Anthropic API error: ${response.status}`);
  const data = await response.json() as AnthropicResponse;
  const text = data.content?.[0]?.text || '[]';
  return parseKeywords(text);
}

async function callOpenAI(prompt: string, config: LLMConfig): Promise<string[]> {
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return [];

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model || 'gpt-4o-mini',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) throw new Error(`OpenAI API error: ${response.status}`);
  const data = await response.json() as OpenAIResponse;
  const text = data.choices?.[0]?.message?.content || '[]';
  return parseKeywords(text);
}

async function callOllama(prompt: string, config: LLMConfig): Promise<string[]> {
  const host = process.env.OLLAMA_HOST || 'http://localhost:11434';

  const response = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model || 'llama3.2',
      prompt,
      stream: false,
    }),
  });

  if (!response.ok) throw new Error(`Ollama error: ${response.status}`);
  const data = await response.json() as OllamaResponse;
  return parseKeywords(data.response || '[]');
}

/**
 * Parse keyword list from LLM response text.
 * Handles JSON arrays, comma-separated, newline-separated, and malformed output.
 * Exported for testing.
 */
export function parseKeywords(text: string): string[] {
  // Try to extract JSON array from the response
  try {
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr)) {
        return arr
          .filter((k: any) => typeof k === 'string' && k.length > 0)
          .slice(0, 15);
      }
    }
  } catch {}
  // Fallback: split by commas or newlines, strip JSON-like artifacts
  return text
    .split(/[,\n]+/)
    .map((s) => s.trim().replace(/["\[\]]/g, ''))
    .filter((s) => s.length > 1)
    .slice(0, 15);
}

/**
 * Check if LLM query expansion is available (Level 1).
 */
export function isExpansionAvailable(): boolean {
  const caps = detectCapabilities();
  return caps.llm !== null;
}
