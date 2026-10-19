import { accessSync, constants } from 'node:fs';

export function kubectlCommand(
  environment: NodeJS.ProcessEnv = process.env,
  localPath = '.tools/bin/kubectl',
): string {
  if (environment.URUMI_KUBECTL) return environment.URUMI_KUBECTL;
  try {
    accessSync(localPath, constants.X_OK);
    return localPath;
  } catch {
    return 'kubectl';
  }
}
