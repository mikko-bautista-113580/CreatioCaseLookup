/**
 * Trust the OS certificate store for outbound TLS — at runtime, in-process.
 *
 * WHY THIS EXISTS
 *  Node 26 ships its own bundled CA list and does NOT consult the Windows
 *  certificate store. Behind a TLS-inspecting corporate proxy (Nelnet's), the
 *  proxy re-signs every HTTPS response with an internal CA. Windows trusts that
 *  CA; Node's bundled list does not. The handshake to Creatio therefore fails
 *  with SELF_SIGNED_CERT_IN_CHAIN / UNABLE_TO_VERIFY_LEAF_SIGNATURE, which
 *  undici reports as the maddeningly generic `TypeError: fetch failed` — with no
 *  request ever reaching Creatio, so session cookies are irrelevant to it.
 *
 *  The `--use-system-ca` CLI flag fixes it, but only for processes launched
 *  through our own npm scripts. MCP clients launch dist/index.js directly, and a
 *  flag in package.json is easy to drop in a merge (it has been dropped once
 *  already). Doing it here means every entry point — web app, MCP server,
 *  test-auth — gets the same trust store no matter how it was started.
 *
 * SAFETY
 *  This only ADDS the certificates the OS already trusts to Node's default
 *  verification set. It never disables verification (no NODE_TLS_REJECT_
 *  UNAUTHORIZED=0), so an actually-bad certificate is still rejected.
 *
 *  Import this module for its side effect BEFORE the first outbound request;
 *  Node applies the default CA list per new TLS connection.
 */

import tls from "node:tls";

export type TrustStatus = {
  applied: boolean;
  /** Human-readable note for diagnostics (surfaced by test-auth). */
  detail: string;
};

/**
 * Merge the OS trust store into Node's default CA list.
 *
 * Feature-detected: tls.getCACertificates / setDefaultCACertificates only exist
 * on newer Node lines. On an older runtime this is a no-op and callers fall back
 * to the --use-system-ca flag (still set in package.json) or NODE_EXTRA_CA_CERTS.
 */
function applySystemTrust(): TrustStatus {
  const get = (tls as unknown as { getCACertificates?: (t: string) => string[] })
    .getCACertificates;
  const set = (tls as unknown as { setDefaultCACertificates?: (c: string[]) => void })
    .setDefaultCACertificates;

  if (typeof get !== "function" || typeof set !== "function") {
    return {
      applied: false,
      detail:
        `Node ${process.versions.node} has no runtime CA API; ` +
        `relying on --use-system-ca / NODE_EXTRA_CA_CERTS.`,
    };
  }

  const read = (type: string): string[] => {
    try {
      return get.call(tls, type) ?? [];
    } catch {
      return []; // unsupported store type on this platform — skip it
    }
  };

  try {
    // 'default' is whatever Node is already using (bundled, plus the system
    // store if --use-system-ca was passed, plus NODE_EXTRA_CA_CERTS). Keeping it
    // means we only ever widen trust, never narrow it.
    const merged = new Set<string>([...read("default"), ...read("extra")]);
    const before = merged.size;
    for (const pem of read("system")) merged.add(pem);
    const added = merged.size - before;

    if (added === 0) {
      return {
        applied: true,
        detail: `System CA store already trusted (${before} certificates).`,
      };
    }

    set.call(tls, [...merged]);
    return {
      applied: true,
      detail: `Added ${added} certificate(s) from the OS trust store (${merged.size} total).`,
    };
  } catch (e) {
    // Never let trust setup break startup — a TLS failure downstream is reported
    // with a clear, actionable message by describeFetchError().
    return {
      applied: false,
      detail: `Could not load the OS trust store: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Result of the one-time trust merge performed at import. */
export const TRUST_STATUS: TrustStatus = applySystemTrust();
