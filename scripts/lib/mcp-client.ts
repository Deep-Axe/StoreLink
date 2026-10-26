import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

// Client.close() only drops the connection. Ending the session as well keeps
// repeated checks within the gateway's per-user session limit.
export async function closeClient(client: Client): Promise<void> {
  const transport = client.transport as
    | { terminateSession?: () => Promise<void> }
    | undefined;
  await transport?.terminateSession?.().catch(() => {});
  await client.close();
}
