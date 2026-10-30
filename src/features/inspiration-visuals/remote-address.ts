import "server-only";

import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupAllOptions } from "node:dns";
import { BlockList, isIP } from "node:net";

export type AddressResolver = (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>;

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(address, prefix, "ipv4");

const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
// Conservatively reject special-purpose assignments and transition mechanisms.
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  blockedV6.addSubnet(address, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  return family === 6 && !address.includes("%") && globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
}

export function validateRemoteUrl(value: string): URL {
  if (value.length > 2048 || /[\s\u0000-\u001f\u007f\\#]/.test(value)) throw new Error("Invalid remote image URL");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid remote image URL"); }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) throw new Error("Invalid remote image URL");
  return url;
}

export async function resolvePublicAddress(hostname: string, resolve: AddressResolver = lookup): Promise<LookupAddress> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  const answers = family ? [{ address: host, family }] : await resolve(host, { all: true, verbatim: true });
  if (!answers.length || answers.some((answer) => !isPublicAddress(answer.address) || isIP(answer.address) !== answer.family)) {
    throw new Error("Remote image address is not public");
  }
  return answers[0]!;
}
