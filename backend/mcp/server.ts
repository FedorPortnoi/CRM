import '../config/env';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createVerifier } from 'fast-jwt';
import { getJwtSecret } from '../config/security';
import { validateMcpPrincipal, mcpToolAllowedForRole } from './validation';
import { projectModelFacing } from './model-projection';
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

/**
 * Per-tool declarations about what this tool's RESULT may contain once it is in
 * front of a language model. Everything here is default-deny: a tool that says
 * nothing gets the strictest treatment, and relaxing it is an explicit, visible
 * act at the registration site.
 */
export type ToolModelFacingOptions = {
  /**
   * `'omit'` (default) — operator ФИО is stripped out of this tool's result by
   * `projectModelFacing`. Applies to every tool that does not say otherwise,
   * including ones written after this comment.
   *
   * `'allowed'` — this tool's whole output IS about named people, so stripping
   * the names would delete the feature rather than minimise it. The only such
   * tool today is `get_rep_performance`, and the trade-off is an open decision
   * in docs/decisions/002-operator-names-in-model-facing-analytics.md. Do not
   * add a second one to dodge a test.
   */
  operatorNames?: 'omit' | 'allowed';
};

const tools: ToolEntry[] = [];

const DENIED_RESULT_CODES = new Set([
  'FORBIDDEN',
  'UNAUTHORIZED',
  'INVALID_TOKEN',
  'SESSION_REVOKED',
]);

function classifyToolResult(result: unknown): {
  outcome: 'success' | 'failure' | 'denied';
  code?: string;
} {
  if (!result || typeof result !== 'object') return { outcome: 'success' };
  const error = (result as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return { outcome: 'success' };
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' || code.length === 0) return { outcome: 'failure' };
  return { outcome: DENIED_RESULT_CODES.has(code) ? 'denied' : 'failure', code };
}

export const mcpServer = new Server(
  { name: 'crm-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// The stdio catalogue CANNOT be filtered by role, and that is a property of the
// transport rather than an omission: this server authenticates per CALL — the JWT
// arrives as a tool argument (see the CallTool handler below) — so at list time
// there is no principal to filter against. An external MCP client therefore sees
// every tool and gets refused on the ones its role may not use. Filtering is a
// prompt-hygiene measure for the in-process assistant (listMcpTools), never the
// enforcement; enforcement is requireMcpToolCapability inside each handler, which
// both doors run.
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

  const classification = classifyToolResult(result);
  await auditLog({
    action: `mcp.tool.${name}`,
    outcome: classification.outcome,
    organizationId: user.org_id,
    userId: user.sub,
    ...(classification.code ? { metadata: { reason: classification.code } } : {}),
  });

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
  };
});

/**
 * Register a tool.
 *
 * The handler is wrapped, not stored raw: `projectModelFacing` runs over
 * whatever it returns before the result reaches a caller. This is the single
 * place where model-visible data gets shaped, and it sits HERE rather than in
 * the assistant because both doors below — the stdio `CallToolRequestSchema`
 * handler and the in-process `invokeMcpTool` — read the same `tools` array, and
 * an external MCP client on the stdio transport is a language model too.
 *
 * Wrapping at registration rather than at the two call sites is deliberate: a
 * future tool file cannot opt out of the projection by forgetting something,
 * because the only way into the registry is through this function. See
 * ./model-projection.ts for what it strips and why the assistant's
 * `redactToolResult` structurally cannot.
 */
export function registerTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: ToolHandler,
  options?: ToolModelFacingOptions,
): void {
  const projected: ToolHandler =
    options?.operatorNames === 'allowed'
      ? handler
      : async (args, user) => projectModelFacing(await handler(args, user));

  tools.push({ name, description, inputSchema, handler: projected });
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
      await import('./tools/pipeline-stages');
      await import('./tools/reminders');
      await import('./tools/amocrm');
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

/**
 * The catalogue offered to the model, narrowed to what this principal's role
 * could actually invoke.
 *
 * The user argument is REQUIRED, not optional. An offered-but-refused tool is
 * not a harmless extra: the model calls create_deal because it was on the menu,
 * eats a round of the MAX_TOOL_ROUNDS budget on a FORBIDDEN, and then has to
 * explain a refusal to somebody who was never allowed to ask. A default would
 * make forgetting the argument silent, so there is no default.
 *
 * This is a narrowing of the MENU only. Every gated handler still checks for
 * itself, because the stdio transport above cannot filter and because nothing
 * stops a model from naming a tool that was never offered.
 */
export async function listMcpTools(user: McpUser): Promise<McpToolDefinition[]> {
  await loadMcpTools();
  return tools
    .filter((t) => mcpToolAllowedForRole(user.role, t.name))
    .map((t) => ({
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
    const classification = classifyToolResult(result);
    await auditLog({
      action: `mcp.tool.${name}`,
      outcome: classification.outcome,
      organizationId: user.org_id,
      userId: user.sub,
      metadata: {
        via: 'in_process',
        ...(classification.code ? { reason: classification.code } : {}),
      },
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
