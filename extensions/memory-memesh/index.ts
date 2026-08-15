/**
 * MeMesh Memory Plugin for OpenClaw
 *
 * Native memory-capability plugin that integrates MeMesh's HTTP API
 * (recall/remember/forget) as a first-party memory provider for OpenClaw.
 *
 * Status: Contract confirmed, NOT yet tested live.
 * Based on: @openclaw/memory-lancedb reference implementation
 * Adapts: LanceDB vector ops → MeMesh HTTP calls
 */

import { Type } from "@sinclair/typebox";
import { memeshConfigSchema, type MemeshConfig, DEFAULT_CONFIG } from "./config.js";

// Type stubs for OpenClaw plugin SDK (will resolve from openclaw package at runtime)
type OpenClawPluginApi = any;
type PluginEntry = any;

/**
 * Prompt injection patterns (defensive guard for memory_store)
 * Copied from LanceDB reference: looksLikePromptInjection()
 */
const INJECTION_PATTERNS = [
  /ignore\s+previous/i,
  /disregard/i,
  /new\s+instructions/i,
  /system\s*:/i,
  /you\s+are\s+now/i,
  /forget\s+everything/i,
];

function looksLikePromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Format recall results for the LLM — shared by the memory_recall tool and
 * the auto-recall hook so the two surfaces cannot drift. (They used to be
 * two pasted copies, both joining with the two-character string `\n` —
 * a literal backslash-n — instead of a newline.)
 */
function formatEntities(entities: any[]): string {
  return entities
    .map((entity, i) => {
      const name = entity.name || "untitled";
      const obs = entity.observations?.[0] || "";
      return `${i + 1}. [${entity.type || "note"}] ${name}: ${obs}`;
    })
    .join("\n");
}

/**
 * Extract latest user message text from messages array
 * Simplified version of LanceDB's extractLatestUserText()
 */
function extractLatestUserText(messages: any[]): string | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  // Walk backwards to find the latest user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "user" && typeof msg.content === "string") {
      return msg.content;
    }
  }

  return null;
}

/**
 * Normalize recall query (strip media notes, truncate, sanitize)
 */
function normalizeRecallQuery(text: string, maxChars: number = 1000): string {
  // Strip markdown image syntax: ![alt](url)
  let normalized = text.replace(/!\[.*?\]\(.*?\)/g, "");

  // Strip potential injection patterns (defensive sanitization)
  // Remove system-like prefixes
  normalized = normalized.replace(/^(system|assistant|user)\s*:\s*/gi, "");

  // Remove directive-like patterns at start of query
  normalized = normalized.replace(/^(ignore|disregard|forget|new instructions?)[\s:]/gi, "");

  // Truncate to max chars
  if (normalized.length > maxChars) {
    normalized = normalized.slice(0, maxChars);
  }

  return normalized.trim();
}

/**
 * HTTP client wrapper with timeout support
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * MeMesh HTTP API client
 */
class MemeshClient {
  constructor(private baseUrl: string, private timeoutMs: number) {}

  async recall(query: string, limit: number = 5, agentId?: string): Promise<any[]> {
    const url = `${this.baseUrl}/v1/recall`;
    const body: Record<string, unknown> = { query, limit };

    // Tenant isolation: filter by agent-specific tag if provided.
    // RecallSchema takes `tag` (SINGULAR string) — a `tags` array is an
    // unknown key that Zod silently strips, which would disable the
    // isolation without any error.
    if (agentId) {
      body.tag = `agent:${agentId}`;
    }

    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      this.timeoutMs
    );

    if (!response.ok) {
      throw new Error(`MeMesh recall failed: HTTP ${response.status}`);
    }

    const json = (await response.json()) as {
      success?: boolean;
      data?: { entities?: any[] } | any[];
    };

    // Documented envelope (>= the issue-#159 fix): {success, data: {entities}}.
    // Older servers returned data as a bare entity array — handle both.
    const payload = json.data;
    if (Array.isArray(payload)) return payload;
    return payload?.entities ?? [];
  }

  async remember(params: {
    name?: string;
    type?: string;
    observations: string[];
    tags?: string[];
    namespace?: string;
    agentId?: string;
  }): Promise<void> {
    const url = `${this.baseUrl}/v1/remember`;

    // Tenant isolation: inject agent-specific tag
    const body = { ...params };
    if (params.agentId) {
      body.tags = [...(params.tags || []), `agent:${params.agentId}`];
      delete body.agentId; // Don't send agentId to API
    }

    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      this.timeoutMs
    );

    if (!response.ok) {
      throw new Error(`MeMesh remember failed: HTTP ${response.status}`);
    }
  }

  /**
   * Archive (soft-delete) ONE entity by name. This is the server's actual
   * forget contract — ForgetSchema takes `{name}`, not a search query, and
   * there is no bulk endpoint. Query-based forgetting is composed client-side
   * in the memory_forget tool: recall the matches, then forget each by name.
   */
  async forgetByName(name: string): Promise<boolean> {
    const url = `${this.baseUrl}/v1/forget`;
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
      this.timeoutMs
    );

    if (!response.ok) {
      throw new Error(`MeMesh forget failed: HTTP ${response.status}`);
    }

    const json = (await response.json()) as {
      success?: boolean;
      data?: { archived?: boolean };
    };
    return json.data?.archived === true;
  }

  async health(): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/v1/health`;
      const response = await fetchWithTimeout(url, {}, 5000);
      return response.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Cooldown tracker (per-agent recall failures)
 */
interface RecallCooldown {
  until: number;
  error: string;
}

/**
 * Plugin entry point
 */
export default {
  id: "memory-memesh",
  name: "Memory (MeMesh)",
  description: "MeMesh HTTP API-backed memory with auto-recall/capture",
  kind: "memory" as const,
  configSchema: memeshConfigSchema,

  register(api: OpenClawPluginApi) {
    let cfg: MemeshConfig;
    try {
      cfg = { ...DEFAULT_CONFIG, ...api.pluginConfig };
    } catch (error) {
      api.registerService?.({
        id: "memory-memesh",
        start: () => {
          const message = error instanceof Error ? error.message : String(error);
          api.logger?.warn?.(`memory-memesh: disabled until configured (${message})`);
        },
      });
      return;
    }

    const client = new MemeshClient(cfg.baseUrl, cfg.recallTimeoutMs);
    const recallCooldowns = new Map<string, RecallCooldown>();

    // Helper: check/record cooldown
    const readCooldown = (agentId: string): { error: string } | undefined => {
      const cooldown = recallCooldowns.get(agentId);
      if (!cooldown) return undefined;
      if (cooldown.until <= Date.now()) {
        recallCooldowns.delete(agentId);
        return undefined;
      }
      return { error: cooldown.error };
    };

    const recordCooldown = (agentId: string, error: string): void => {
      recallCooldowns.set(agentId, {
        until: Date.now() + cfg.recallCooldownMs,
        error,
      });
    };

    api.logger?.info?.(`memory-memesh: registered (baseUrl: ${cfg.baseUrl})`);

    // Register memory capability (if OpenClaw supports it).
    // No publicArtifacts: MeMesh has no artifact-list endpoint, and a
    // permanent empty stub would advertise a feature that always answers
    // "none" — indistinguishable from working-but-empty. Add the surface
    // when the endpoint exists.
    api.registerMemoryCapability?.({});

    // ========================================================================
    // Tool: memory_recall
    // ========================================================================
    api.registerTool?.((ctx: any) => {
      const agentId = ctx.agentId;
      if (!agentId) return null;

      return {
        name: "memory_recall",
        label: "Memory Recall",
        description:
          "Search through long-term memories. Use when you need context about user preferences, past decisions, or previously discussed topics.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(
            Type.Integer({ description: "Max results (default: 5)", minimum: 1, maximum: 20 })
          ),
        }),

        async execute(_toolCallId: string, params: any) {
          const query = params.query as string;
          const limit = (params.limit as number) ?? 5;

          // Check cooldown
          const cooldown = readCooldown(agentId);
          if (cooldown) {
            return {
              content: [
                { type: "text", text: `Memory recall unavailable: ${cooldown.error}` },
              ],
            };
          }

          try {
            const entities = await client.recall(query, limit, agentId);

            if (entities.length === 0) {
              return {
                content: [{ type: "text", text: "No relevant memories found." }],
                details: { count: 0 },
              };
            }

            return {
              content: [{ type: "text", text: formatEntities(entities) }],
              details: { count: entities.length },
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            // On timeout, enter cooldown
            if (message.includes("aborted")) {
              recordCooldown(agentId, "recall timed out");
            }

            api.logger?.warn?.(`memory-memesh: recall failed: ${message}`);
            return {
              content: [{ type: "text", text: `Memory recall unavailable: ${message}` }],
            };
          }
        },
      };
    }, { name: "memory_recall" });

    // ========================================================================
    // Tool: memory_store
    // ========================================================================
    api.registerTool?.((ctx: any) => {
      const agentId = ctx.agentId;
      if (!agentId) return null;

      return {
        name: "memory_store",
        label: "Memory Store",
        description:
          "Store a new memory. Use for important facts, decisions, or preferences you should remember.",
        parameters: Type.Object({
          text: Type.String({ description: "Content to remember" }),
          category: Type.Optional(
            Type.String({ description: "Category (e.g., 'decision', 'fact', 'preference')" })
          ),
          importance: Type.Optional(
            Type.Integer({ description: "Importance (1-10)", minimum: 1, maximum: 10 })
          ),
        }),

        async execute(_toolCallId: string, params: any) {
          const text = params.text as string;
          const category = (params.category as string) ?? "note";

          // Prompt injection guard (critical safety check)
          if (looksLikePromptInjection(text)) {
            return {
              content: [
                {
                  type: "text",
                  text: "Memory rejected: content looks like a prompt injection attempt.",
                },
              ],
            };
          }

          try {
            // Generate name from first 50 chars of text
            const name = text.slice(0, 50).trim() + (text.length > 50 ? "..." : "");

            await client.remember({
              name, // Required by API
              type: category,
              observations: [text],
              namespace: "personal",
              agentId, // Tenant isolation via tag
            });

            return {
              content: [{ type: "text", text: "Memory stored successfully." }],
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            api.logger?.warn?.(`memory-memesh: store failed: ${message}`);
            return {
              content: [{ type: "text", text: `Memory store failed: ${message}` }],
            };
          }
        },
      };
    }, { name: "memory_store" });

    // ========================================================================
    // Tool: memory_forget
    // ========================================================================
    api.registerTool?.((ctx: any) => {
      const agentId = ctx.agentId;
      if (!agentId) return null;

      return {
        name: "memory_forget",
        label: "Memory Forget",
        description: "Delete memories matching a search query. Use to remove outdated information.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query for memories to forget" }),
        }),

        async execute(_toolCallId: string, params: any) {
          const query = params.query as string;

          try {
            // The server's forget contract is name-based (ForgetSchema takes
            // {name}; there is no query/bulk endpoint). Compose query-based
            // forgetting honestly: recall the matches (agent-scoped), archive
            // each by name, count what the server actually confirmed.
            const matches = await client.recall(query, 20, agentId);
            if (matches.length === 0) {
              return {
                content: [{ type: "text", text: "No memories found matching that query." }],
                details: { count: 0 },
              };
            }

            let archived = 0;
            for (const entity of matches) {
              if (typeof entity?.name !== "string" || entity.name.length === 0) continue;
              if (await client.forgetByName(entity.name)) archived++;
            }

            return {
              content: [
                {
                  type: "text",
                  text: `Archived ${archived} of ${matches.length} matching memor${matches.length === 1 ? "y" : "ies"} (soft-delete; restorable server-side).`,
                },
              ],
              details: { count: archived },
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            api.logger?.warn?.(`memory-memesh: forget failed: ${message}`);
            return {
              content: [{ type: "text", text: `Memory forget failed: ${message}` }],
            };
          }
        },
      };
    }, { name: "memory_forget" });

    // ========================================================================
    // Hook: before_prompt_build (auto-recall)
    // ========================================================================
    api.on?.("before_prompt_build", async (event: any, ctx: any) => {
      if (!cfg.autoRecall) {
        return undefined;
      }

      const agentId = ctx.agentId;
      if (!agentId) {
        return undefined;
      }

      if (!event.prompt || event.prompt.length < 5) {
        return undefined;
      }

      // Check cooldown
      const cooldown = readCooldown(agentId);
      if (cooldown) {
        api.logger?.debug?.(
          `memory-memesh: auto-recall skipped during cooldown: ${cooldown.error}`
        );
        return undefined;
      }

      try {
        // Extract query from latest user message
        const latestUserText =
          extractLatestUserText(Array.isArray(event.messages) ? event.messages : []) ??
          event.prompt;

        const recallQuery = normalizeRecallQuery(latestUserText, 1000);
        if (!recallQuery) {
          return undefined;
        }

        // Fetch memories with tenant isolation
        const entities = await client.recall(recallQuery, cfg.recallResultCap, agentId);

        if (entities.length === 0) {
          return undefined;
        }

        // Return context to inject before prompt
        return {
          context: `Relevant memories:\n${formatEntities(entities)}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // On timeout, enter cooldown
        if (message.includes("aborted")) {
          recordCooldown(agentId, "auto-recall timed out");
        }

        api.logger?.warn?.(`memory-memesh: auto-recall failed: ${message}`);
        return undefined;
      }
    });

    api.logger?.info?.("memory-memesh: auto-recall hook registered");
  },
} as PluginEntry;
