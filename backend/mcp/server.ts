import '../config/env';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createVerifier } from 'fast-jwt';
import { getJwtSecret } from '../config/security';
import { validateMcpPrincipal } from './validation';
import { auditLog } from '../services/audit';

export type McpUser = { sub: string; org_id: string; role: string; sid?: string };

const verify = createVerifier({ key: getJwtSecret() });

export function verifyToken(token: string): McpUser {
  const payload = verify(token) as Record<string, string>;
  return { sub: payload['sub'], org_id: payload['org_id'], role: payload['role'], sid: payload['sid'] };
}

type ToolHandler = (
  args: Record<string, unknown>,
  user: McpUser,
) => Promise<unknown>;

type ToolEntry = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
};

const tools: ToolEntry[] = [];

export const mcpServer = new Server(
  { name: 'crm-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
});

mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const callArgs: Record<string, unknown> = (args ?? {}) as Record<string, unknown>;

  const entry = tools.find((t) => t.name === name);
  if (!entry) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      isError: true,
    };
  }

  const jwtToken = callArgs['jwt_token'];
  if (typeof jwtToken !== 'string') {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: 'jwt_token is required' }) }],
      isError: true,
    };
  }

  let user: McpUser;
  try {
    user = verifyToken(jwtToken);
  } catch {
    await auditLog({
      action: `mcp.tool.${name}`,
      outcome: 'failure',
      metadata: { reason: 'invalid_jwt' },
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Invalid jwt_token' }) }],
      isError: true,
    };
  }

  const principalError = await validateMcpPrincipal(user);
  if (principalError) {
    await auditLog({
      action: `mcp.tool.${name}`,
      outcome: 'denied',
      organizationId: user.org_id,
      userId: user.sub,
      metadata: { reason: principalError.error.code },
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(principalError) }],
      isError: true,
    };
  }

  const { jwt_token: _stripped, ...remainingArgs } = callArgs;
  void _stripped;

  let result: unknown;
  try {
    result = await entry.handler(remainingArgs, user);
  } catch (err) {
    await auditLog({
      action: `mcp.tool.${name}`,
      outcome: 'failure',
      organizationId: user.org_id,
      userId: user.sub,
      metadata: { error: err instanceof Error ? err.message : 'UNKNOWN_ERROR' },
    });
    throw err;
  }

  await auditLog({
    action: `mcp.tool.${name}`,
    outcome: 'success',
    organizationId: user.org_id,
    userId: user.sub,
  });

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
  };
});

export function registerTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: ToolHandler,
): void {
  tools.push({ name, description, inputSchema, handler });
  mcpServer.sendToolListChanged().catch(() => {
    // ignore if transport not yet connected
  });
}

let toolModulesLoading: Promise<void> | null = null;

// Dynamic imports prevent circular-init: tool files call registerTool() at
// module scope, so they must load after tools[] and registerTool are ready.
// Memoised because the in-process callers below may hit it on every request.
export function loadMcpTools(): Promise<void> {
  if (!toolModulesLoading) {
    toolModulesLoading = (async () => {
      await import('./tools/contacts');
      await import('./tools/deals');
      await import('./tools/tasks');
      await import('./tools/calendar');
      await import('./tools/analytics');
    })();
  }

  return toolModulesLoading;
}

export async function startMcp(): Promise<void> {
  await loadMcpTools();
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

// ─── In-process invocation ───────────────────────────────────────────────────
// The AI assistant runs inside the Fastify process and must reuse these exact
// handlers so org scoping, the visibility cone and the viewer write-block stay
// in one place. It cannot reach them over the stdio transport, so the two
// exports below expose the same registry the CallTool handler uses, with the
// same principal validation and audit trail.

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpInvocationResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

export async function listMcpTools(): Promise<McpToolDefinition[]> {
  await loadMcpTools();
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export async function invokeMcpTool(
  name: string,
  args: Record<string, unknown>,
  user: McpUser,
): Promise<McpInvocationResult> {
  await loadMcpTools();

  const entry = tools.find((t) => t.name === name);
  if (!entry) {
    return { ok: false, error: { code: 'TOOL_NOT_FOUND', message: `Unknown tool: ${name}` } };
  }

  const principalError = await validateMcpPrincipal(user);
  if (principalError) {
    await auditLog({
      action: `mcp.tool.${name}`,
      outcome: 'denied',
      organizationId: user.org_id,
      userId: user.sub,
      metadata: { reason: principalError.error.code, via: 'in_process' },
    });
    return { ok: false, error: principalError.error };
  }

  // jwt_token is a transport concern of the stdio server. Never let an
  // in-process caller — least of all a language model — smuggle one through.
  const { jwt_token: _stripped, ...safeArgs } = args;
  void _stripped;

  try {
    const result = await entry.handler(safeArgs, user);
    await auditLog({
      action: `mcp.tool.${name}`,
      outcome: 'success',
      organizationId: user.org_id,
      userId: user.sub,
      metadata: { via: 'in_process' },
    });
    return { ok: true, result };
  } catch (err) {
    await auditLog({
      action: `mcp.tool.${name}`,
      outcome: 'failure',
      organizationId: user.org_id,
      userId: user.sub,
      metadata: { via: 'in_process', error: err instanceof Error ? err.message : 'UNKNOWN_ERROR' },
    });
    return {
      ok: false,
      error: {
        code: 'TOOL_EXECUTION_FAILED',
        message: err instanceof Error ? err.message : 'Tool execution failed',
      },
    };
  }
}
