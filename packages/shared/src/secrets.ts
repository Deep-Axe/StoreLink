import { readFileSync } from 'node:fs';

export function secret(name: string): string {
  const file = process.env[`${name}_FILE`];
  const value = file ? readFileSync(file, 'utf8').trim() : process.env[name];
  if (!value) throw new Error(`Supply ${name} or ${name}_FILE`);
  return value;
}

export function apiKeyPepper(): Buffer {
  const file = process.env.API_KEY_PEPPER_FILE;
  const value = file
    ? readFileSync(file)
    : Buffer.from(process.env.API_KEY_PEPPER ?? '', 'base64');
  if (value.length < 32)
    throw new Error(
      'Supply a random API_KEY_PEPPER_FILE or base64 API_KEY_PEPPER',
    );
  return value;
}
