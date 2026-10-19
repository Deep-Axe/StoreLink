import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { runChat, openaiModel } from '../services/gateway/src/chat.ts';

const url =
  process.env.URUMI_GATEWAY_URL ?? 'http://dashboard.urumi.localhost/mcp';
const file = process.env.URUMI_GATEWAY_KEY_FILE;
const prompt = process.argv.slice(2).join(' ');
if (!file || !process.env.OPENAI_API_KEY || !prompt)
  throw new Error(
    'Set URUMI_GATEWAY_KEY_FILE and OPENAI_API_KEY, then provide a prompt. The file must contain only your dashboard-generated gateway key.',
  );
const key = readFileSync(file, 'utf8').trim();
const client = new Client({ name: 'urumi-external-chat', version: '0.1.0' });
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  const result = await runChat({
    // This adapter has no upstream access or user-selection parameter. The remote gateway authenticates its API key.
    gateway: {
      listTools: async () => (await client.listTools()).tools,
      call: async (_actor, name, args) =>
        CallToolResultSchema.parse(
          await client.callTool({ name, arguments: args }),
        ),
    },
    actor: {
      userId: 'remote-key-owner',
      teamId: 'remote',
      keyId: 'remote',
      role: 'member',
    },
    model: openaiModel(process.env.OPENAI_API_KEY),
    modelName: process.env.OPENAI_MODEL ?? 'gpt-6-luna',
    messages: [],
    message: prompt,
  });
  for (const activity of result.activity)
    console.log(`${activity.isError ? 'Failed' : 'Called'} ${activity.name}`);
  console.log(result.text);
  console.log(
    `Tokens: ${result.inputTokens} input / ${result.outputTokens} output`,
  );
} finally {
  await client.close();
}
