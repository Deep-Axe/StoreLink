import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export class RegistryInputError extends Error {}
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;
const resolve: Resolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });
export function publicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export class UpstreamPolicy {
  origins: Set<string>;
  resolver: Resolver;
  constructor(origins: string[], resolver: Resolver = resolve) {
    this.origins = new Set(origins);
    this.resolver = resolver;
  }
  validate(value: string): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new RegistryInputError('Invalid upstream URL');
    }
    if (!['http:', 'https:'].includes(url.protocol))
      throw new RegistryInputError('Upstream URL must use HTTP or HTTPS');
    if (url.username || url.password)
      throw new RegistryInputError(
        'URL credentials are forbidden; use the credential field',
      );
    if (url.hash || url.search)
      throw new RegistryInputError(
        'Upstream URL must not contain a query or fragment',
      );
    if (this.origins.has(url.origin)) return url;
    if (url.protocol !== 'https:')
      throw new RegistryInputError(
        'Public upstreams require HTTPS; private HTTP origins need operator approval',
      );
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(hostname) && !publicAddress(hostname))
      throw new RegistryInputError(
        'Private and reserved upstream addresses need operator approval',
      );
    return url;
  }
  async addresses(hostname: string): Promise<LookupAddress[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const addresses = await Promise.race([
        this.resolver(hostname),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('DNS timeout')), 2000);
        }),
      ]);
      if (
        !addresses.length ||
        addresses.some((item) => !publicAddress(item.address))
      )
        throw new RegistryInputError(
          'Upstream DNS must resolve only to public addresses; private origins need operator approval',
        );
      return addresses;
    } catch (error) {
      if (error instanceof RegistryInputError) throw error;
      throw new RegistryInputError('Upstream DNS lookup failed or timed out');
    } finally {
      clearTimeout(timer);
    }
  }
  async check(value: string): Promise<URL> {
    const url = this.validate(value);
    if (!this.origins.has(url.origin))
      await this.addresses(url.hostname.replace(/^\[|\]$/g, ''));
    return url;
  }
  connectionOptions(value: string): { lookup?: LookupFunction } {
    const url = this.validate(value);
    if (this.origins.has(url.origin)) return {};
    // This resolver supplies the checked addresses directly to the socket. No second DNS lookup.
    const lookup: LookupFunction = (hostname, options, callback) => {
      void this.addresses(hostname).then(
        (addresses) => {
          const matches = options.family
            ? addresses.filter((a) => a.family === options.family)
            : addresses;
          if (!matches.length) {
            callback(new Error('No public address for requested family'), '');
            return;
          }
          if (options.all) callback(null, matches);
          else callback(null, matches[0].address, matches[0].family);
        },
        () =>
          callback(
            new Error('Upstream address rejected by network policy'),
            '',
          ),
      );
    };
    return { lookup };
  }
}
