import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { generateApiKey } from '../packages/shared/src/api-keys.ts';
import { parseEnv } from 'node:util';
import { join } from 'node:path';
import { kubectlCommand } from './lib/kubectl.ts';

const kubectl = kubectlCommand();
const namespace = process.env.STORELINK_NAMESPACE ?? 'storelink';
const secretName = process.env.STORELINK_SECRET_NAME ?? 'storelink-credentials';
const run = (args: string[], input?: string) =>
  execFileSync(kubectl, args, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
const stateDir = process.env.STORELINK_STATE_DIR ?? '.data';
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
run(
  ['apply', '-f', '-'],
  JSON.stringify({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: namespace },
  }),
);
const file = join(stateDir, 'cluster-secrets.json');
let data: Record<string, string>;
if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8'));
else {
  const existing = JSON.parse(
    run([
      '-n',
      namespace,
      'get',
      'secret',
      secretName,
      '--ignore-not-found',
      '-o',
      'json',
    ]) || 'null',
  );
  if (existing?.data) data = existing.data;
  else {
    const random = () => randomBytes(32).toString('base64url');
    const postgresPassword = random();
    const raw: Record<string, Buffer | string> = {
      'postgres-password': postgresPassword,
      'database-url': `postgresql://storelink:${postgresPassword}@storelink-postgres:5432/storelink`,
      'mariadb-root-password': random(),
      'wordpress-db-password': random(),
      'wordpress-admin-password': random(),
      'woo-consumer-key': `ck_${randomBytes(20).toString('hex')}`,
      'woo-consumer-secret': `cs_${randomBytes(20).toString('hex')}`,
      'woo-mcp-token': random(),
      'api-key-pepper': randomBytes(32),
      'gateway-keys': JSON.stringify({
        'admin-a': generateApiKey(),
        'member-b': generateApiKey(),
      }),
    };
    data = Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [
        key,
        Buffer.from(value).toString('base64'),
      ]),
    );
  }
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
}
for (const key of [
  'time-mcp-token',
  'operations-mcp-token',
  'dashboard-admin-password',
  'dashboard-member-password',
]) {
  data[key] ??= Buffer.from(randomBytes(24).toString('base64url')).toString(
    'base64',
  );
}
const openaiKey =
  process.env.OPENAI_API_KEY ||
  (existsSync('.env')
    ? parseEnv(readFileSync('.env', 'utf8')).OPENAI_API_KEY
    : undefined);
if (openaiKey?.trim())
  data['openai-api-key'] = Buffer.from(openaiKey.trim()).toString('base64');
writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
run(
  ['-n', namespace, 'apply', '-f', '-'],
  JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: secretName },
    type: 'Opaque',
    data,
  }),
);
const upstreamName =
  process.env.STORELINK_UPSTREAM_SECRET_NAME ??
  'storelink-upstream-credentials';
const upstream = JSON.parse(
  run([
    '-n',
    namespace,
    'get',
    'secret',
    upstreamName,
    '--ignore-not-found',
    '-o',
    'json',
  ]) || 'null',
);
const upstreamData = upstream?.data ?? {};
for (const [id, key] of [
  ['woo', 'woo-mcp-token'],
  ['time', 'time-mcp-token'],
  ['ops', 'operations-mcp-token'],
]) {
  upstreamData[id] ??= Buffer.from(
    JSON.stringify({
      header: 'authorization',
      value: `Bearer ${Buffer.from(data[key], 'base64').toString('utf8')}`,
    }),
  ).toString('base64');
}
run(
  ['-n', namespace, 'apply', '-f', '-'],
  JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: upstreamName },
    type: 'Opaque',
    data: upstreamData,
  }),
);
console.log(
  `Credentials prepared in ${namespace}/${secretName}; local recovery copy: ${file}. No credentials printed.`,
);
