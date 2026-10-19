import { internalServer } from '../../../packages/shared/src/internal-server.ts';
import { secret } from '../../../packages/shared/src/secrets.ts';
import { timeServer } from './server.ts';
const port = Number(process.env.MCP_PORT ?? 3002);
internalServer({
  port,
  origin: process.env.MCP_ORIGIN ?? `http://127.0.0.1:${port}`,
  token: secret('MCP_TOKEN'),
  createServer: () => timeServer(process.env.STORE_TIMEZONE ?? 'Asia/Kolkata'),
  name: 'Time MCP',
});
