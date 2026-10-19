import { readFileSync } from 'node:fs';
import { PostgresStore } from '../services/gateway/src/postgres-store.ts';
import { apiKeyPepper, secret } from '../packages/shared/src/secrets.ts';
import { hashApiKey } from '../packages/shared/src/api-keys.ts';
import { hashPassword } from '../services/gateway/src/dashboard-api.ts';

const store = new PostgresStore(secret('DATABASE_URL'));
try {
  await store.migrate();
  const keys = JSON.parse(
    readFileSync(
      process.env.BOOTSTRAP_KEYS_FILE ?? '/secrets/gateway-keys',
      'utf8',
    ),
  ) as Record<string, string>;
  for (const [id, role] of [
    ['admin-a', 'admin'],
    ['member-b', 'member'],
  ] as const) {
    if (!keys[id]) throw new Error('Bootstrap key is missing');
    await store.addUser(id, process.env.TEAM_ID ?? 'development', role);
    await store.addKey(id, hashApiKey(keys[id], apiKeyPepper()));
    const password = readFileSync(
      `/secrets/dashboard-${role === 'admin' ? 'admin' : 'member'}-password`,
      'utf8',
    ).trim();
    await store.pool.query(
      'UPDATE users SET email=$1,password_hash=$2 WHERE id=$3 AND password_hash IS NULL',
      [
        role === 'admin' ? 'admin@urumi.local' : 'member@urumi.local',
        await hashPassword(password),
        id,
      ],
    );
  }
  console.log(
    'Application schema and two bootstrap users are ready; existing revocations were retained.',
  );
} finally {
  await store.close();
}
