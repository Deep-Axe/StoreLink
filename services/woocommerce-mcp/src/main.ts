import { expressMcpApp } from '../../../packages/shared/src/mcp-http.ts';
import { secret } from '../../../packages/shared/src/secrets.ts';
import { WooStoreClient } from './store-client.ts';
import { wooHttpHandler } from './server.ts';

const store = new WooStoreClient({
  publicUrl: process.env.STORE_PUBLIC_URL ?? 'http://store.urumi.test',
  connectService:
    process.env.STORE_CONNECT_SERVICE ?? 'wordpress.urumi.svc.cluster.local',
  consumerKey: secret('WOO_CONSUMER_KEY'),
  consumerSecret: secret('WOO_CONSUMER_SECRET'),
});
const port = Number(process.env.WOO_MCP_PORT ?? 3001);
const origin = process.env.WOO_MCP_ORIGIN ?? `http://127.0.0.1:${port}`;
const app = expressMcpApp(
  wooHttpHandler(store, secret('WOO_MCP_TOKEN'), origin),
  origin,
);
const server = app.listen(port, process.env.BIND_ADDRESS ?? '127.0.0.1', () =>
  console.log(`Woo MCP listening at ${origin}/mcp`),
);
server.on('error', () => {
  console.error('Unable to bind Woo MCP listener');
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => server.close());
