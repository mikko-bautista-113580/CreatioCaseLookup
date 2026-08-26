/**
 * Resolve file paths that a case *names* back to real files in the index.
 *
 * Support cases routinely name the template outright — "the Term Marksheet
 * (custom/Jamaica/TermReportCardLog.cfm) pulls the wrong column". Before this
 * existed, that sentence was worth nothing: the trusted file list was built
 * purely from account-name district guesses, so a correctly-spelled path in the
 * description was never offered to triage, and the case came back as "no
 * candidate file could be verified".
 *
 * SECURITY MODEL: this reads untrusted text but never trusts it. A mention only
 * becomes a candidate by matching a path that is already in the RepoIndex —
 * i.e. a file that exists on disk. The case text can *point at* real files; it
 * can never conjure one. Nothing here reads, writes, or resolves outside the
 * index, so a hostile description can at worst point triage at the wrong
 * existing template, which the human approval step is there to catch.
 */

import { canonicalPath, normalizeRel, type RepoIndex } from "./repoIndex.js";

/** Extensions worth chasing — the ones cases actually name. */
const EXT = "cfm|cfc|htm|html|css|js|xlsx|csv";

/**
 * A file reference: an optional run of path segments, then a filename with a
 * known extension. Bounded segment count so a pathological string can't make
 * the scan quadratic.
 */
const REF_RE = new RegExp(
  String.raw`(?:[A-Za-z0-9_.\-]+[\/\\]){0,6}[A-Za-z0-9_.\-]+\.(?:${EXT})\b`,
  "gi"
);

const MAX_SCAN_CHARS = 20_000;
const MAX_MENTIONS = 12; // distinct raw references we bother resolving
const MAX_PER_MENTION = 4; // paths offered for one ambiguous reference
/** A bare filename this common ("index.cfm") identifies nothing. */
const AMBIGUITY_CEILING = 12;

export interface FileMention {
  /** The reference exactly as it appeared in the case text. */
  raw: string;
  /** Canonical repo-relative paths it resolves to, best first. */
  paths: string[];
  /**
   * exact    — the full repo-relative path was written out
   * suffix   — trailing segments matched ("Jamaica/TermReportCardLog.cfm")
   * basename — only the filename matched
   */
  how: "exact" | "suffix" | "basename";
  /** True when more than one real file fits the reference. */
  ambiguous: boolean;
}

export interface MentionResult {
  mentions: FileMention[];
  /** References that look like filenames but match nothing in the repo. */
  unresolved: string[];
}

/** How many trailing path segments `candidate` shares with `segments`. */
function suffixOverlap(candidate: string, segments: string[]): number {
  const cand = candidate.toLowerCase().split("/");
  let n = 0;
  while (
    n < segments.length &&
    n < cand.length &&
    cand[cand.length - 1 - n] === segments[segments.length - 1 - n]
  ) {
    n++;
  }
  return n;
}

/**
 * Find every file reference in `text` and resolve it against the index.
 *
 * `preferDirs` (repo-relative district folders, lowercased on the way in) only
 * breaks ties between equally-good matches — it can never promote a file the
 * reference didn't already fit.
 */
export function resolveMentions(
  ix: RepoIndex,
  text: string,
  preferDirs: Iterable<string> = []
): MentionResult {
  const prefer = new Set<string>();
  for (const d of preferDirs) prefer.add(normalizeRel(d).toLowerCase());

  const blob = String(text || "").slice(0, MAX_SCAN_CHARS);
  const mentions: FileMention[] = [];
  const unresolved: string[] = [];
  const seenRaw = new Set<string>();
  const seenPath = new Set<string>();

  for (const m of blob.matchAll(REF_RE)) {
    if (mentions.length >= MAX_MENTIONS) break;

    const raw = m[0];
    const key = raw.toLowerCase().replace(/\\/g, "/");
    if (seenRaw.has(key)) continue;
    seenRaw.add(key);

    const rel = normalizeRel(raw.replace(/\\/g, "/"));
    const segments = rel.toLowerCase().split("/").filter(Boolean);
    if (!segments.length) continue;

    // 1. The whole path, written out correctly.
    const exact = canonicalPath(ix, rel);
    if (exact) {
      if (!seenPath.has(exact.toLowerCase())) {
        seenPath.add(exact.toLowerCase());
        mentions.push({ raw, paths: [exact], how: "exact", ambiguous: false });
      }
      continue;
    }

    // 2. Otherwise every real file sharing the basename is a candidate, ranked
    //    by how much of the written path it actually matches.
    const pool = ix.byBasename.get(segments[segments.length - 1]) || [];
    if (!pool.length) {
      if (unresolved.length < MAX_MENTIONS) unresolved.push(raw);
      continue;
    }

    let best = 0;
    const scored = pool.map((p) => {
      const overlap = suffixOverlap(p, segments);
      if (overlap > best) best = overlap;
      return { path: p, overlap };
    });

    let hits = scored.filter((s) => s.overlap === best);
    if (hits.length > 1) {
      // Tie-break on the districts the account already pointed us at.
      const preferred = hits.filter((s) => {
        const parts = s.path.toLowerCase().split("/");
        return parts.length >= 3 && prefer.has(`${parts[0]}/${parts[1]}`);
      });
      if (preferred.length) hits = preferred;
    }
    if (hits.length > AMBIGUITY_CEILING) {
      // Too generic to mean anything — report it as unresolved rather than
      // burying triage in a dozen identically-named files.
      if (unresolved.length < MAX_MENTIONS) unresolved.push(raw);
      continue;
    }

    const paths = hits
      .map((s) => s.path)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_PER_MENTION)
      .filter((p) => !seenPath.has(p.toLowerCase()));
    if (!paths.length) continue;
    for (const p of paths) seenPath.add(p.toLowerCase());

    mentions.push({
      raw,
      paths,
      how: best >= 2 ? "suffix" : "basename",
      ambiguous: hits.length > 1,
    });
  }

  // Unambiguous, deeply-matched references first — that ordering carries
  // straight into the prompt's trusted file list.
  const rank = (f: FileMention): number =>
    (f.how === "exact" ? 0 : f.how === "suffix" ? 1 : 2) + (f.ambiguous ? 0.5 : 0);
  mentions.sort((a, b) => rank(a) - rank(b));

  return { mentions, unresolved };
}
