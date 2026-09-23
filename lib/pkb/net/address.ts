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

/**
 * The eight 16-bit groups of an IPv6 address, whatever way it is spelled.
 *
 * `::ffff:127.0.0.1`, `::ffff:7f00:1` and `0:0:0:0:0:ffff:127.0.0.1` are the
 * same address written three ways, and a check that only recognises the
 * compressed spellings is a check an attacker writes around. Expanding first
 * means the rules below are applied to the address rather than to its
 * punctuation.
 *
 * Returns null for anything that is not a well-formed IPv6 address, which the
 * caller treats as "not public".
 */
function hextets(address: string): number[] | null {
  let text = address.toLowerCase();

  // A zone index ("%eth0") names an interface, which only exists locally.
  if (text.includes("%")) return null;

  // A trailing dotted quad is the last two groups.
  const tail: number[] = [];
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const octets = dotted[1].split(".").map(Number);
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    tail.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    text = text.slice(0, dotted.index + 1);
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const parse = (part: string): number[] | null => {
    if (part === "" || part === ":") return [];
    const groups = part.replace(/^:|:$/g, "").split(":");
    if (groups.length === 1 && groups[0] === "") return [];
    const values: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      values.push(parseInt(group, 16));
    }
    return values;
  };

  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !rest) return null;

  const explicit = [...head, ...rest, ...tail];
  if (halves.length === 1) return explicit.length === 8 ? explicit : null;
  if (explicit.length >= 8) return null;
  return [...head, ...Array(8 - explicit.length).fill(0), ...rest, ...tail];
}

/**
 * The IPv4 address inside an IPv6 one, in any spelling, or null.
 *
 * Covers both embeddings: IPv4-mapped (`::ffff:a.b.c.d`) and the deprecated
 * IPv4-compatible form (`::a.b.c.d`). Both reach an IPv4 destination, so both
 * are judged by the IPv4 rules rather than the IPv6 ones — `::ffff:127.0.0.1`
 * is loopback however it is written.
 */
function embeddedIpv4(address: string): string | null {
  const groups = hextets(address);
  if (!groups) return null;
  if (groups.slice(0, 5).some((group) => group !== 0)) return null;

  const marker = groups[5];
  // ::ffff:a.b.c.d (mapped) or ::a.b.c.d (compatible). `::` and `::1` have a
  // zero low half and are already refused as the unspecified and loopback
  // addresses, so they are left to the IPv6 rules.
  if (marker !== 0xffff && marker !== 0) return null;
  if (marker === 0 && groups[6] === 0 && groups[7] <= 1) return null;

  return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
}

/** Whether an IP address is a public unicast address a retrieval may connect to. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    // An IPv6 address that embeds an IPv4 one reaches an IPv4 destination, so
    // it is judged by the IPv4 rules. `::ffff:0:0/96` cannot be a BlockList
    // entry, because BlockList would then apply it to every plain IPv4 address
    // as well.
    const inner = embeddedIpv4(address);
    if (inner) return isIP(inner) === 4 && !blocked.check(inner, "ipv4");
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
