import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateApiKey, hashApiKey } from '../packages/shared/src/api-keys.ts';
import { DevelopmentStore } from '../services/gateway/src/store.ts';

mkdirSync('.data', { recursive: true, mode: 0o700 });
for (const [file, value] of [
  ['.data/api-key-pepper', randomBytes(32)],
  ['.data/woo-mcp-token', randomBytes(32).toString('base64url')],
] as const) {
  if (!existsSync(file))
    writeFileSync(file, value, { mode: 0o600, flag: 'wx' });
}
const store = new DevelopmentStore('.data/gateway.sqlite');
try {
  const pepper = readFileSync('.data/api-key-pepper');
  if (!existsSync('.data/dev-keys.json')) {
    const keys: Record<string, string> = {};
    for (const [user, role] of [
      ['admin-a', 'admin'],
      ['member-b', 'member'],
    ] as const) {
      store.addUser(user, 'development', role);
      const key = generateApiKey();
      store.addKey(user, hashApiKey(key, pepper));
      keys[user] = key;
    }
    writeFileSync('.data/dev-keys.json', JSON.stringify(keys, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
  } else {
    const keys = JSON.parse(
      readFileSync('.data/dev-keys.json', 'utf8'),
    ) as Record<string, string>;
    for (const [user, key] of Object.entries(keys)) {
      if (store.findKey(hashApiKey(key, pepper))?.userId !== user) {
        throw new Error(
          'Development credentials do not match the database; restore the database and pepper together',
        );
      }
    }
  }
  console.log(
    'Development users and credentials are ready under .data/ (ignored; owner-readable). Existing keys were retained.',
  );
} finally {
  store.close();
}
