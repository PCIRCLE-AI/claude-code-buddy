import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS } from '../src/transports/mcp/handlers.js';

describe('public MCP message tool definition', () => {
  it('advertises principal and exact-session targeting to conforming clients', () => {
    const message = TOOL_DEFINITIONS.find((tool) => tool.name === 'message');
    expect(message).toBeDefined();

    const properties = message?.inputSchema.properties as Record<string, unknown>;
    expect(properties.target_kind).toEqual(expect.objectContaining({
      type: 'string',
      enum: ['principal', 'session'],
    }));
  });
});
