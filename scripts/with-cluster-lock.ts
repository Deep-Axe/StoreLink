import { runWithClusterLock } from './lib/cluster-lock.ts';
const separator = process.argv.indexOf('--');
const args = process.argv.slice(separator + 1);
if (separator === -1 || !args.length)
  throw new Error(
    'Usage: node scripts/with-cluster-lock.ts -- <command> [arguments]',
  );
runWithClusterLock(args[0], args.slice(1));
