import { execFileSync } from 'node:child_process';
import { acquireClusterLock } from './lib/cluster-lock.ts';
import { kubectlCommand } from './lib/kubectl.ts';

acquireClusterLock();
const apply = process.argv.includes('--apply');
if (process.argv.slice(2).some((arg) => arg !== '--apply'))
  throw new Error('Usage: node scripts/cleanup-qa.ts [--apply]');
const kubectl = kubectlCommand();
const env = {
  ...process.env,
  KUBECONFIG: process.env.KUBECONFIG ?? `${process.cwd()}/.data/kubeconfig`,
};
const run = (args: string[], input?: string) =>
  execFileSync(kubectl, ['-n', 'storelink', ...args], {
    env,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
// Narrowly target QA members and disabled invitation-smoke accounts.
// Keep user/key tombstones so historical audits retain their attribution.
const databaseScript = `
import pg from 'pg';
import {readFileSync} from 'node:fs';
const pool=new pg.Pool({connectionString:readFileSync(process.env.DATABASE_URL_FILE,'utf8').trim()});
const client=await pool.connect();
try {
 await client.query('BEGIN');
 const users=(await client.query("SELECT id,email,disabled_at FROM users WHERE role='member' AND (email ~ $1 OR (email ~ $2 AND disabled_at IS NOT NULL)) ORDER BY email FOR UPDATE",['^qa-[0-9]+@storelink[.]test$','^invite-[0-9]+@storelink[.]test$'])).rows;
 const ids=users.map(u=>u.id);
 const keys=(await client.query("SELECT k.id,k.label,k.revoked_at FROM api_keys k WHERE k.user_id=ANY($1::text[]) OR (k.revoked_at IS NOT NULL AND k.label=ANY($2::text[]))",[ids,['Temporary smoke-check key','Invitation check','Live chat acceptance key']])).rows;
 const conversations=(await client.query("SELECT count(*)::int AS count FROM conversations WHERE user_id=ANY($1::text[]) OR (jsonb_array_length(messages)=0 AND input_tokens=0 AND output_tokens=0)",[ids])).rows[0].count;
 console.log(JSON.stringify({mode:${JSON.stringify(apply ? 'apply' : 'preview')},qaAccounts:users.map(u=>({id:u.id,email:u.email})),testKeyCount:keys.length,conversations}));
 if(${apply}) {
  await client.query('UPDATE users SET disabled_at=coalesce(disabled_at,now()),password_hash=NULL WHERE id=ANY($1::text[])',[ids]);
  await client.query('DELETE FROM sessions WHERE user_id=ANY($1::text[])',[ids]);
  await client.query("DELETE FROM invitations WHERE email ~ $1 OR email ~ $2",['^qa-[0-9]+@storelink[.]test$','^invite-[0-9]+@storelink[.]test$']);
  await client.query('UPDATE api_keys SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=ANY($1::text[])',[ids]);
  await client.query('DELETE FROM conversations WHERE user_id=ANY($1::text[]) OR (jsonb_array_length(messages)=0 AND input_tokens=0 AND output_tokens=0)',[ids]);
 }
 await client.query(${JSON.stringify(apply ? 'COMMIT' : 'ROLLBACK')});
} catch {await client.query('ROLLBACK');throw new Error('QA cleanup transaction failed');}
finally{client.release();await pool.end();}
`;
process.stdout.write(
  run(
    [
      'exec',
      '-i',
      'deployment/storelink-gateway',
      '--',
      'node',
      '--input-type=module',
      '-',
    ],
    databaseScript,
  ),
);
// Use WooCommerce CRUD, preserving restore capability and refusing a changed ID/name.
const productScript = `$product=wc_get_product(23); if (!$product) {echo "QA product absent\\n"; return;} if (!preg_match('/^QA Lantern(?: [0-9]+)?$/', $product->get_name())) {throw new Exception('Product 23 no longer matches the QA fixture');} if (${apply ? 'true' : 'false'}) {$product->delete(false); echo "QA product 23 moved to trash\\n";} else {echo "QA product 23 matches; will move to trash\\n";}`;
process.stdout.write(
  run([
    'exec',
    'deployment/storelink-wordpress',
    '--',
    'wp',
    '--allow-root',
    '--path=/var/www/html',
    'eval',
    productScript,
  ]),
);
console.log(
  'Bootstrap users, live integration/OpenAI secrets, store orders and audit history are retained.',
);
