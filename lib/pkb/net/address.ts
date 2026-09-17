import { BlockList, isIP } from "node:net";

/**
 * Which network destinations a source retrieval may reach (D-073, SSRF).
 *
 * Only public unicast addresses. Everything else — loopback, private and
 * carrier-grade NAT ranges, link-local (which includes cloud metadata at
 * 169.254.169.254), multicast, documentation and benchmarking ranges, IPv6
 * unique-local and link-local, and the IPv6 forms that embed an IPv4 address
 * (mapped, NAT64, 6to4, Teredo) — is refused. Hostnames that only make sense
 * inside a network are refused before any lookup.
 */

const blocked = new BlockList();

const IPV4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

const IPV6_BLOCKED: [string, number][] = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  // IPv4-mapped (::ffff:0:0/96) is refused by `mappedIpv4` below, not here:
  // BlockList applies a mapped-range rule to every plain IPv4 address too.
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local NAT64
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments, including Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
];

for (const [network, prefix] of IPV4_BLOCKED) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of IPV6_BLOCKED) blocked.addSubnet(network, prefix, "ipv6");

/** The IPv4 address inside an IPv4-mapped IPv6 address, in either notation. */
function mappedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return null;
}

/** Whether an IP address is a public unicast address a retrieval may connect to. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    const inner = mappedIpv4(address);
    if (inner) return false;
    return !blocked.check(address, "ipv6");
  }
  return false;
}

const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".localdomain", ".home.arpa"];
const INTERNAL_NAMES = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data"]);

/**
 * Whether a hostname may be looked up at all. IP literals are refused outright:
 * a manufacturer's page has a name, and a literal is how SSRF usually arrives.
 */
export function hostnameProblem(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return "no host";
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0) return "an IP address instead of a host name";
  if (!host.includes(".")) return "a single-label host name";
  if (INTERNAL_NAMES.has(host) || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return "an internal host name";
  }
  if (!/^[a-z0-9.-]+$/.test(host)) return "a host name with unexpected characters";
  return null;
}
