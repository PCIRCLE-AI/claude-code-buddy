// =============================================================================
// LLM client — single dispatch point for anthropic / openai / ollama
// =============================================================================
//
// Four modules used to inline the same provider-switch + fetch + response
// shape extraction (~50 lines each, ~200 LOC total):
//   - query-expander.ts
//   - failure-analyzer.ts
//   - auto-tagger.ts
//   - consolidator.ts
//
// Each call site keeps its own prompt construction, output parser, and
// safety wrapper (deliberate-design from the F7 prompt-safety work — output
// validators must stay co-located with their prompts). Only the HTTP
// machinery moves here.
//
// Per-call-site differences worth preserving:
//   - max_tokens varies: 200 (query-expander, auto-tagger),
//                        300 (failure-analyzer),
//                        500 (consolidator)
//   - model defaults vary by provider
//   - error formatting is provider-specific (Anthropic vs OpenAI vs Ollama)

import type { LLMConfig } from './config.js';
import type { AnthropicResponse, OpenAIResponse, OllamaResponse } from './types.js';

export interface CallLLMOptions {
  /** Per-call-site max-output budget. Defaults to 200. */
  maxTokens?: number;
}

/**
 * Send a single prompt to the configured LLM provider and return the
 * response as a plain string. Each call site is responsible for parsing
 * the string into its own structured shape (JSON array, object, etc).
 *
 * Provider-specific defaults:
 *   - anthropic: model=claude-haiku-4-5, requires apiKey from config or
 *                ANTHROPIC_API_KEY env
 *   - openai:    model=gpt-4o-mini, requires apiKey from config or
 *                OPENAI_API_KEY env
 *   - ollama:    model=llama3.2, host from OLLAMA_HOST env or localhost
 *
 * Throws if the provider is configured but the API call fails. Returns
 * empty string for unknown provider (caller should treat as no-op).
 */
export async function callLLM(
  prompt: string,
  config: LLMConfig,
  opts: CallLLMOptions = {},
): Promise<string> {
  const maxTokens = opts.maxTokens ?? 200;

  if (config.provider === 'anthropic') {
    const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('No API key');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model || 'claude-haiku-4-5',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
    const data = await res.json() as AnthropicResponse;
    return data.content?.[0]?.text || '';
  }

  if (config.provider === 'openai') {
    const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('No API key');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model || 'gpt-4o-mini',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
    const data = await res.json() as OpenAIResponse;
    return data.choices?.[0]?.message?.content || '';
  }

  if (config.provider === 'ollama') {
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const res = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model || 'llama3.2',
        prompt,
        stream: false,
        // Ollama doesn't expose max_tokens directly; max-output budget is
        // controlled by the model itself or num_predict in raw-mode. The
        // helper accepts maxTokens for parity with cloud providers but
        // doesn't forward it — silently dropped to match prior behavior.
      }),
    });
    if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
    const data = await res.json() as OllamaResponse;
    return data.response || '';
  }

  return '';
}
