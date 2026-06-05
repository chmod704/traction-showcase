/**
 * SSRF URL GUARD — the one place the system decides "is this URL safe to fetch /
 * navigate to from our server?". Used by every code path that hits a
 * caller/DB/model-supplied URL:
 *   - the outbox CRM-webhook deliverer (a contractor-supplied URL),
 *   - JARVIS's browser hand (browser_open — a model/page-supplied URL).
 *
 * A server-side request to an attacker-influenced URL is the SSRF surface: it can
 * reach loopback, RFC-1918 private ranges, link-local, and the cloud metadata
 * endpoint (169.254.169.254) to steal instance credentials. We allow only
 * http(s) to a PUBLIC host. Pure, total, no I/O, never throws.
 *
 * NOTE: this is a hostname/scheme guard, not full DNS-rebinding protection (that
 * needs resolve-then-pin at fetch time). It blocks the overwhelming-majority
 * literal-target SSRF cases; DNS-rebinding hardening is a documented follow-up.
 */

/** Block-listed exact hostnames + suffixes (loopback / unspecified). */
const BLOCKED_HOSTS = new Set(["localhost", "0.0.0.0", "::1", "[::1]", "ip6-localhost", "ip6-loopback"]);

/**
 * Is this a usable http(s) URL pointing at a PUBLIC host? Returns false for any
 * non-http(s) scheme (file:, data:, about:, javascript:, gopher:, ftp:, …),
 * loopback, RFC-1918 private ranges, link-local / metadata, and malformed input.
 */
export function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;

  const host = u.hostname.toLowerCase();
  if (!host) return false;
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost")) return false;

  // IPv4 literal → block loopback / private / link-local ranges.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false; // not a valid IPv4
    if (a === 0 || a === 127 || a === 10) return false; // unspecified / loopback / private
    if (a === 169 && b === 254) return false; // link-local incl. 169.254.169.254 metadata
    if (a === 192 && b === 168) return false; // private
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT (carrier-grade NAT)
  }

  // IPv6 literal → block loopback / unique-local (fc00::/7) / link-local (fe80::/10).
  if (host.includes(":") || (host.startsWith("[") && host.endsWith("]"))) {
    const h6 = host.replace(/^\[|\]$/g, "");
    if (h6 === "::1" || h6 === "::") return false;
    if (/^f[cd][0-9a-f]{2}:/i.test(h6)) return false; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/i.test(h6)) return false; // fe80::/10 link-local
  }

  return true;
}
