import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  bearer,
  checkServiceToken,
  expressMcpApp,
  mcpHttpHandler,
} from './mcp-http.ts';

export function internalServer(options: {
  origin: string;
  port: number;
  token: string;
  createServer: () => McpServer;
  name: string;
}) {
  const handler = mcpHttpHandler({
    hosts: [new URL(options.origin).host],
    authorize(request) {
      if (!checkServiceToken(bearer(request), options.token))
        throw new Error('Unauthorized');
    },
    createServer: options.createServer,
  });
  const app = expressMcpApp(handler, options.origin);
  const server = app.listen(
    options.port,
    process.env.BIND_ADDRESS ?? '127.0.0.1',
    () => console.log(`${options.name} listening`),
  );
  server.on('error', () => {
    console.error('Unable to bind internal MCP listener');
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => server.close());
}
