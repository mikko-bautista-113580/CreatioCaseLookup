/**
 * Case text -> district code scoring.
 *
 * This runs BEFORE the model sees anything. Its job is to turn "the senior
 * report card shows the wrong GPA for Hope Christian" into a short, bounded
 * list of real district folders, so the triage agent is choosing from a handful
 * of verified options instead of free-associating over 3,700 codes.
 *
 * Every signal here is deterministic. No model, no network.
 *
 * NOTE ON ACCOUNT CODES: if Creatio's Account entity turns out to carry a
 * district/school code field, feed it in as `accountCode` — that path is exact
 * and outranks every heuristic below. It could not be verified while building
 * this (the Creatio host was unreachable), so name-based matching is the
 * default and the exact path is opportunistic.
 */

import type { RepoIndex, DistrictEntry, SubRepo } from "./repoIndex.js";

export interface DistrictGuess {
  code: string; // UPPERCASE index key
  score: number;
  why: string[];
  entries: DistrictEntry[];
}

export interface GuessInput {
  /** Creatio Account/Name — the strongest name signal. */
  accountName?: string;
  /** Exact district code, if a Creatio field ever supplies one. */
  accountCode?: string;
  subject?: string;
  descriptionText?: string;
}

/** Report-type keywords -> the subrepos they imply. */
const TYPE_HINTS: Array<{ re: RegExp; subs: SubRepo[]; label: string }> = [
  { re: /\btranscript/i, subs: ["Transcripts"], label: "mentions transcript" },
  { re: /\bprogress\s*report/i, subs: ["ProgressReport"], label: "mentions progress report" },
  {
    re: /\breport\s*card\b/i,
    subs: ["ReportCardAO", "ReportCardPZ"],
    label: "mentions report card",
  },
  { re: /\bimport\b/i, subs: ["ReportModules"], label: "mentions import" },
];

/** Words that carry no discriminating power in a school name. */
const STOP = new Set([
  "the", "of", "and", "school", "schools", "academy", "christian", "catholic",
  "high", "elementary", "middle", "junior", "senior", "saint", "st", "inc",
  "college", "preparatory", "prep", "institute", "center", "centre", "district",
]);

/** US state / province tokens -> the suffix used in district codes. */
const REGION_SUFFIX: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", jersey: "NJ",
  york: "NY", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA",
  washington: "WA", wisconsin: "WI", wyoming: "WY", guam: "GUAM",
  canada: "CAN", ontario: "CAN", manitoba: "CAN", alberta: "CAN", jamaica: "JAM",
};

function words(s: string): string[] {
  return String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w));
}

/** Initials of the significant words: "Hope Christian Academy" -> "H" (+ HCA). */
function initials(name: string): string[] {
  const all = String(name || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const sig = all.filter((w) => !STOP.has(w));
  const out = new Set<string>();
  if (all.length) out.add(all.map((w) => w[0]).join("").toUpperCase());
  if (sig.length) out.add(sig.map((w) => w[0]).join("").toUpperCase());
  return [...out].filter((s) => s.length >= 2 && s.length <= 8);
}

/**
 * Score district codes against the case text.
 * Returns the highest-scoring candidates, best first.
 */
export function guessDistricts(
  ix: RepoIndex,
  input: GuessInput,
  limit = 8
): DistrictGuess[] {
  const scores = new Map<string, { score: number; why: string[] }>();
  const bump = (code: string, n: number, why: string) => {
    const key = code.toUpperCase();
    if (!ix.districts.has(key)) return;
    const cur = scores.get(key) || { score: 0, why: [] };
    cur.score += n;
    if (!cur.why.includes(why)) cur.why.push(why);
    scores.set(key, cur);
  };

  const blob = [input.subject, input.descriptionText].filter(Boolean).join("\n");

  // --- Signal 0: an exact code from Creatio, if we ever get one. ------------
  if (input.accountCode) bump(input.accountCode, 1000, "exact account code from Creatio");

  // --- Signal 1: a literal district code appearing in the text. ------------
  // Only accept tokens that are real index keys, so this cannot invent codes.
  const tokenRe = /\b[A-Za-z][A-Za-z0-9]{1,7}(?:-[A-Za-z0-9]{2,5})+\b/g;
  for (const m of blob.matchAll(tokenRe)) {
    bump(m[0], 100, `district code "${m[0]}" appears in the case text`);
  }

  // --- Signal 2: a filename or path fragment naming a district folder. -----
  const fileRe = /\b([A-Za-z][A-Za-z0-9-]{1,20})[_\-/\\][A-Za-z0-9_\-.]*\.(?:cfm|htm|html)\b/gi;
  for (const m of blob.matchAll(fileRe)) {
    bump(m[1], 80, `filename "${m[0]}" references this district`);
  }

  // --- Signal 3: account name -> code. -------------------------------------
  if (input.accountName) {
    const nameWords = words(input.accountName);
    const region = nameWords.map((w) => REGION_SUFFIX[w]).find(Boolean);

    for (const init of initials(input.accountName)) {
      // "Hope Christian Academy" + Canada -> HCA-CAN is an exact hit.
      if (region) bump(`${init}-${region}`, 90, `initials "${init}" + region "${region}"`);
      // Otherwise any district whose prefix matches the initials.
      for (const key of ix.districts.keys()) {
        if (key.split("-")[0] === init) {
          bump(key, region ? 25 : 40, `initials "${init}" match the district prefix`);
        }
      }
    }

    // Distinctive whole words that appear in a code (e.g. "guam", "dart").
    for (const w of nameWords) {
      if (w.length < 4) continue;
      const up = w.toUpperCase();
      for (const key of ix.districts.keys()) {
        if (key.includes(up)) bump(key, 30, `"${w}" appears in the district code`);
      }
    }
  }

  // --- Signal 4: report type narrows the subrepo, it does not pick a code. --
  const typeSubs = new Set<SubRepo>();
  const typeWhy: string[] = [];
  for (const h of TYPE_HINTS) {
    if (h.re.test(blob)) {
      h.subs.forEach((s) => typeSubs.add(s));
      typeWhy.push(h.label);
    }
  }

  const out: DistrictGuess[] = [];
  for (const [code, { score, why }] of scores) {
    const entries = ix.districts.get(code) || [];
    let s = score;
    const w = [...why];
    if (typeSubs.size) {
      const hit = entries.filter((e) => typeSubs.has(e.subrepo));
      if (hit.length) {
        s += 15;
        w.push(`${typeWhy.join(", ")} — matches ${[...new Set(hit.map((h) => h.subrepo))].join("/")}`);
      }
    }
    out.push({ code, score: s, why: w, entries });
  }

  out.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
  return out.slice(0, limit);
}

/** Below this, we don't believe our own guess. */
export const CONFIDENT_SCORE = 80;

export function looksUncertain(guesses: DistrictGuess[]): boolean {
  if (!guesses.length) return true;
  if (guesses[0].score < CONFIDENT_SCORE) return true;
  // A near-tie between the top two is also uncertain.
  return guesses.length > 1 && guesses[1].score >= guesses[0].score * 0.9;
}
