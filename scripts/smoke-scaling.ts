import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { acquireClusterLock } from './lib/cluster-lock.ts';
import { kubectlCommand } from './lib/kubectl.ts';

// Sends each request to a chosen gateway pod through its own port-forward, so
// the check proves cross-replica behaviour instead of relying on load balancing.
acquireClusterLock();
const kubectl = kubectlCommand();
const env = { ...process.env, KUBECONFIG: `${process.cwd()}/.data/kubeconfig` };
const host = 'dashboard.storelink.localhost';
const material = JSON.parse(readFileSync('.data/cluster-secrets.json', 'utf8'));
const key = JSON.parse(
  Buffer.from(material['gateway-keys'], 'base64').toString(),
)['member-b'];

const pods = execFileSync(
  kubectl,
  [
    '-n',
    'storelink',
    'get',
    'pods',
    '-l',
    'storelink/component=gateway',
    '--field-selector=status.phase=Running',
    '-o',
    'jsonpath={.items[*].metadata.name}',
  ],
  { env, encoding: 'utf8' },
)
  .split(' ')
  .filter(Boolean)
  .sort();
assert.ok(pods.length >= 2, `Expected two gateway pods, found ${pods.length}`);

const forwards: ChildProcess[] = [];
async function forward(pod: string): Promise<number> {
  const child = spawn(
    kubectl,
    ['-n', 'storelink', 'port-forward', `pod/${pod}`, ':3000'],
    { env, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  forwards.push(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('port-forward timed out')),
      15000,
    );
    child.stdout!.on('data', (chunk: Buffer) => {
      const match = /127\.0\.0\.1:(\d+)/.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
}

type Reply = { status: number; headers: Record<string, string>; body: string };
function send(
  port: number,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method,
        headers: {
          host,
          authorization: `Bearer ${key}`,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          ...headers,
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            body: data,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

try {
  const [a, b] = await Promise.all(pods.slice(0, 2).map(forward));
  const init = await send(
    a,
    'POST',
    {},
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'storelink-scaling-check', version: '1' },
      },
    },
  );
  assert.equal(init.status, 200, init.body);
  const session = {
    'mcp-session-id': init.headers['mcp-session-id'],
    'mcp-protocol-version': JSON.parse(init.body).result.protocolVersion,
  };
  const initialized = await send(b, 'POST', session, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  assert.equal(initialized.status, 202, initialized.body);

  const list = await send(b, 'POST', session, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  });
  assert.equal(list.status, 200, list.body);
  const tools = JSON.parse(list.body).result.tools.map(
    (tool: { name: string }) => tool.name,
  );
  assert.ok(tools.includes('time__get_status'), tools.join(' '));
  for (const [port, id] of [
    [a, 3],
    [b, 4],
  ]) {
    const call = await send(port, 'POST', session, {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'time__get_status', arguments: {} },
    });
    assert.equal(call.status, 200, call.body);
    assert.notEqual(JSON.parse(call.body).result.isError, true, call.body);
  }
  console.log(
    `Session started on ${pods[0]} served tools/list and tools/call on ${pods[1]} and back.`,
  );

  const closed = await send(a, 'DELETE', session);
  assert.equal(closed.status, 200);
  const after = await send(b, 'POST', session, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/list',
  });
  assert.equal(after.status, 404, after.body);
  console.log('Session deleted on one pod is gone on the other.');
} finally {
  for (const child of forwards) child.kill();
}
