import type { LLMConfig } from './config.js';
import type { AnthropicResponse, OpenAIResponse, OllamaResponse } from './types.js';

export interface StructuredLesson {
  error: string;
  rootCause: string;
  fix: string;
  prevention: string;
  errorPattern: string;
  fixPattern: string;
  severity: 'critical' | 'major' | 'minor';
}

/**
 * Analyze errors from a session and extract a structured lesson using LLM.
 * Deduplicates and limits errors to max 5 unique entries.
 * Returns null if LLM fails or produces unparseable output.
 */
export async function analyzeFailure(
  errors: string[],
  filesEdited: string[],
  llmConfig: LLMConfig
): Promise<StructuredLesson | null> {
  // Deduplicate and limit to 5
  const unique = [...new Set(errors)].slice(0, 5);
  if (unique.length === 0) return null;

  const prompt = `You are analyzing a coding session where errors were encountered and fixed.

Errors found:
${unique.map((e, i) => `${i + 1}. ${e.slice(0, 200)}`).join('\n')}

Files edited to fix:
${filesEdited.slice(0, 10).join(', ')}

Analyze the root cause and return a JSON object (ONLY the JSON, no explanation):
{
  "error": "concise error description (1 sentence)",
  "rootCause": "why this happened (1 sentence)",
  "fix": "what fixed it (1 sentence)",
  "prevention": "how to prevent this in future (1 sentence, actionable)",
  "errorPattern": "category: null-reference | type-error | import-missing | config-error | test-failure | build-error | runtime-error | logic-error | other",
  "fixPattern": "category: defensive-coding | type-guard | validation | config-fix | dependency-update | refactor | test-fix | other",
  "severity": "critical | major | minor"
}`;

  try {
    const text = await callLLM(prompt, llmConfig);
    return parseLesson(text);
  } catch {
    return null;
  }
}

async function callLLM(prompt: string, config: LLMConfig): Promise<string> {
  const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;

  if (config.provider === 'anthropic') {
    if (!apiKey) throw new Error('No API key');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model || 'claude-haiku-4-5', max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
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
      body: JSON.stringify({ model: config.model || 'gpt-4o-mini', max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
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

export function parseLesson(text: string): StructuredLesson | null {
  try {
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) return null;
    const obj = JSON.parse(match[0]);

    // Validate required fields
    if (!obj.error || !obj.fix) return null;

    const validErrorPatterns = ['null-reference', 'type-error', 'import-missing', 'config-error', 'test-failure', 'build-error', 'runtime-error', 'logic-error', 'other'];
    const validFixPatterns = ['defensive-coding', 'type-guard', 'validation', 'config-fix', 'dependency-update', 'refactor', 'test-fix', 'other'];
    const validSeverities = ['critical', 'major', 'minor'];

    return {
      error: String(obj.error).slice(0, 200),
      rootCause: String(obj.rootCause || 'Unknown').slice(0, 200),
      fix: String(obj.fix).slice(0, 200),
      prevention: String(obj.prevention || 'Review similar code paths').slice(0, 200),
      errorPattern: validErrorPatterns.includes(obj.errorPattern) ? obj.errorPattern : 'other',
      fixPattern: validFixPatterns.includes(obj.fixPattern) ? obj.fixPattern : 'other',
      severity: validSeverities.includes(obj.severity) ? obj.severity : 'minor',
    };
  } catch {
    return null;
  }
}
