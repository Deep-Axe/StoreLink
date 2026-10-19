import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { internalServer } from '../../../packages/shared/src/internal-server.ts';
import { secret } from '../../../packages/shared/src/secrets.ts';
const port = Number(process.env.MCP_PORT ?? 3003);
internalServer({
  port,
  origin: process.env.MCP_ORIGIN ?? `http://127.0.0.1:${port}`,
  token: secret('MCP_TOKEN'),
  name: 'Operations MCP',
  createServer() {
    const server = new McpServer({
      name: 'urumi-operations',
      version: '0.1.0',
    });
    server.registerTool(
      'get_status',
      {
        description: 'Read the operations service status.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ service: 'operations', status: 'ready' }),
          },
        ],
      }),
    );
    server.registerTool(
      'get_fulfillment_policy',
      {
        description:
          'Read the demo store fulfillment policy and seeded sales target. These are demonstration configuration values.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              currency: 'INR',
              daily_sales_target: '5000.00',
              dispatch_business_days: 2,
              payment_method: 'Cash on delivery',
              demo: true,
            }),
          },
        ],
      }),
    );
    return server;
  },
});
