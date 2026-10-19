import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  bearer,
  mcpHttpHandler,
} from '../../../packages/shared/src/mcp-http.ts';
import type { Identity } from '../../../packages/shared/src/api-keys.ts';
import type { Gateway } from './gateway.ts';
import { AuthorizationError } from './gateway.ts';

export function gatewayHttpHandler(gateway: Gateway, origin: string) {
  return mcpHttpHandler({
    hosts: [new URL(origin).host],
    origins: [origin],
    authorizationErrorStatus: (error) =>
      error instanceof AuthorizationError ? 401 : 503,
    authorize(request, body) {
      const rpc = body as
        | { method?: string; params?: { name?: unknown } }
        | undefined;
      const requestedTool =
        rpc?.method === 'tools/call'
          ? typeof rpc.params?.name === 'string'
            ? rpc.params.name
            : '(invalid tool name)'
          : undefined;
      return gateway.authenticate(bearer(request), requestedTool);
    },
    createServer(identity) {
      const actor = identity as Identity;
      const server = new Server(
        { name: 'urumi-gateway', version: '0.1.0' },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: await gateway.listTools(actor),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) =>
        gateway.call(actor, request.params.name, request.params.arguments),
      );
      return server;
    },
  });
}
