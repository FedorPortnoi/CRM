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
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Invalid jwt_token' }) }],
      isError: true,
    };
  }

  const principalError = await validateMcpPrincipal(user);
  if (principalError) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(principalError) }],
      isError: true,
    };
  }

  const { jwt_token: _stripped, ...remainingArgs } = callArgs;
  void _stripped;

  const result = await entry.handler(remainingArgs, user);
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

export async function startMcp(): Promise<void> {
  // Dynamic imports prevent circular-init: tool files call registerTool() at
  // module scope, so they must load after tools[] and registerTool are ready.
  await import('./tools/contacts');
  await import('./tools/deals');
  await import('./tools/tasks');
  await import('./tools/calendar');
  await import('./tools/analytics');
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}
