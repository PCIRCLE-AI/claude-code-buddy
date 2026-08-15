import { Type, Static } from "@sinclair/typebox";

/**
 * MeMesh memory plugin configuration schema
 */
export const memeshConfigSchema = Type.Object({
  /**
   * MeMesh HTTP API base URL (default: http://localhost:3737)
   */
  baseUrl: Type.Optional(
    Type.String({
      default: "http://localhost:3737",
      description: "MeMesh HTTP API base URL",
    })
  ),

  /**
   * Enable automatic recall on before_prompt_build hook
   */
  autoRecall: Type.Optional(
    Type.Boolean({
      default: true,
      description: "Enable automatic memory recall before building prompts",
    })
  ),

  /**
   * Enable automatic capture (EXPERIMENTAL - test A/B before enabling)
   *
   * WARNING: Threshold-gated capture (max 3/turn) is different from
   * Hermes's every-turn model. Test with autoCapture: false first.
   */
  autoCapture: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Enable automatic memory capture (EXPERIMENTAL)",
    })
  ),

  /**
   * Auto-recall result cap (default: 3, matching LanceDB's default)
   */
  recallResultCap: Type.Optional(
    Type.Integer({
      default: 3,
      minimum: 1,
      maximum: 10,
      description: "Max memories injected on auto-recall",
    })
  ),

  /**
   * Recall timeout in milliseconds (default: 15000)
   */
  recallTimeoutMs: Type.Optional(
    Type.Integer({
      default: 15000,
      minimum: 1000,
      maximum: 60000,
      description: "Recall operation timeout",
    })
  ),

  /**
   * Cooldown after recall failure in milliseconds (default: 60000)
   */
  recallCooldownMs: Type.Optional(
    Type.Integer({
      default: 60000,
      minimum: 10000,
      maximum: 300000,
      description: "Cooldown duration after recall timeout",
    })
  ),
});

export type MemeshConfig = Static<typeof memeshConfigSchema>;

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Required<MemeshConfig> = {
  baseUrl: "http://localhost:3737",
  autoRecall: true,
  autoCapture: false,
  recallResultCap: 3,
  recallTimeoutMs: 15000,
  recallCooldownMs: 60000,
};
