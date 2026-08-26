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

import { districtForPath, type RepoIndex, type DistrictEntry, type SubRepo } from "./repoIndex.js";
import { resolveMentions, type FileMention } from "./fileMentions.js";

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
  /** Files the case text names, already resolved against the index. */
  mentions?: FileMention[];
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

/**
 * The folder each report type implies for one district code, best first.
 * The tree routes deterministically:
 *   report card     -> ReportCardAO/<code> for codes starting A–O,
 *                      ReportCardPZ/<code> for P–Z
 *   transcript      -> Transcripts/<code>
 *   progress report -> ProgressReport/<code>
 * A few folders sit in the "wrong" half (MadisonDiocese lives in PZ), so this
 * orders candidates; the index remains the authority on where a code exists.
 */
export function subreposForReportType(reportType: string, code: string): SubRepo[] {
  switch (reportType) {
    case "report-card": {
      const first = (code[0] || "").toUpperCase();
      return first && first <= "O"
        ? ["ReportCardAO", "ReportCardPZ"]
        : ["ReportCardPZ", "ReportCardAO"];
    }
    case "transcript":
      return ["Transcripts"];
    case "progress-report":
      return ["ProgressReport"];
    case "custom": {
      // Custom reports split by the district code's FIRST LETTER, one folder per
      // range: ReportsCustomDL/<code> holds D–L (e.g. ReportsCustomDL/DA-NJ),
      // ReportsCustomMR/<code> holds M–R, ReportsCustomSZ/<code> holds S–Z.
      // Verified against the tree, and unlike the report-card halves these
      // ranges are strict — no folder is filed outside its own range.
      //
      // Codes starting A–C (and anything non-alphabetic) have NO custom-report
      // folder anywhere in this tree, so express no preference: the index is
      // the authority, and triage will correctly find no candidate and escalate
      // rather than being pointed at the wrong range.
      const first = (code[0] || "").toUpperCase();
      if (first >= "D" && first <= "L")
        return ["ReportsCustomDL", "ReportsCustomMR", "ReportsCustomSZ"];
      if (first >= "M" && first <= "R")
        return ["ReportsCustomMR", "ReportsCustomSZ", "ReportsCustomDL"];
      if (first >= "S" && first <= "Z")
        return ["ReportsCustomSZ", "ReportsCustomMR", "ReportsCustomDL"];
      return [];
    }
    case "honor-roll":
      // The ranking pairs live under Modules/HonorRoll/CUSTOM/<DSN>/, which is
      // deeper than the <subrepo>/<code> shape the district index tracks — so
      // this only orders any Modules folder that does match, and triage raises
      // an escalation pointing at the honorrollrank skill.
      return ["Modules", "ReportModules"];
    default:
      return [];
  }
}

/**
 * Every subrepo a report type is allowed to live in, regardless of district
 * code. This is the FENCE for the edit scope — "a transcript case may only
 * touch Transcripts" — whereas subreposForReportType() above answers the
 * narrower "which one first for this code". They differ for custom reports: the
 * family is all three letter ranges, while the per-code answer is the one range
 * that code belongs to (and nothing at all for A–C, which has no folder).
 * An empty result means the type has no opinion, so nothing gets fenced off.
 */
export function subreposForTypeFamily(reportType: string): SubRepo[] {
  switch (reportType) {
    case "report-card":
      return ["ReportCardAO", "ReportCardPZ"];
    case "transcript":
      return ["Transcripts"];
    case "progress-report":
      return ["ProgressReport"];
    case "custom":
      return ["ReportsCustomDL", "ReportsCustomMR", "ReportsCustomSZ"];
    case "honor-roll":
      return ["Modules", "ReportModules"];
    default:
      return []; // "module" / "unknown" — no opinion
  }
}

/** Order the hinted subrepos for `code`, expected report-card half first. */
function orderTypeSubs(code: string, typeSubs: ReadonlySet<SubRepo>): SubRepo[] {
  const subs = [...typeSubs];
  if (typeSubs.has("ReportCardAO") && typeSubs.has("ReportCardPZ")) {
    const [first] = subreposForReportType("report-card", code);
    subs.sort((a, b) => (a === first ? -1 : b === first ? 1 : 0));
  }
  return subs;
}

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

  // --- Signal 2: a file the case names, already resolved to a real path. ---
  // Strongest evidence short of an exact account code: the case pointed at a
  // file that demonstrably exists, and that file lives in exactly one folder.
  for (const mention of input.mentions || []) {
    const weight = mention.how === "basename" || mention.ambiguous ? 60 : 120;
    for (const p of mention.paths) {
      const d = districtForPath(ix, p);
      if (d) bump(d.code, weight, `the case names "${mention.raw}" → ${p}`);
    }
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
    let entries = ix.districts.get(code) || [];
    let s = score;
    const w = [...why];
    if (typeSubs.size) {
      // Entries in the type-implied folder lead: they feed the triage prompt's
      // file list and the fix agent's edit scope in this order.
      const preferred = orderTypeSubs(code, typeSubs);
      const rank = (e: DistrictEntry): number => {
        const i = preferred.indexOf(e.subrepo);
        return i === -1 ? preferred.length : i;
      };
      entries = [...entries].sort((a, b) => rank(a) - rank(b));

      const hit = entries.filter((e) => typeSubs.has(e.subrepo));
      if (hit.length) {
        s += hit.some((e) => e.subrepo === preferred[0]) ? 25 : 15;
        w.push(`${typeWhy.join(", ")} — matches ${[...new Set(hit.map((h) => h.subrepo))].join("/")}`);
      }
    }
    out.push({ code, score: s, why: w, entries });
  }

  // Among equal scores, a canonically-coded folder (AA-CA) beats an ad-hoc one
  // (JAMAICA, BrooklynDioc). A pure tiebreak — it never crosses score bands.
  const adHoc = (g: DistrictGuess): number => (g.entries.some((e) => e.strict) ? 0 : 1);
  out.sort((a, b) => b.score - a.score || adHoc(a) - adHoc(b) || a.code.localeCompare(b.code));
  return out.slice(0, limit);
}

/**
 * The full deterministic read of one case: which files it names, and which
 * districts those files plus the account name point at.
 *
 * Two passes, because the signals feed each other. Name-based guesses come
 * first and are used only to break ties between identically-named files
 * ("ExamGradeLog.cfm" exists in 12 Jamaican districts); the resolved files then
 * re-score the districts, where they outweigh every name heuristic.
 */
export interface CaseSignals {
  guesses: DistrictGuess[];
  mentions: FileMention[];
  /** Filenames the case names that exist nowhere in the repo. */
  unresolvedMentions: string[];
}

export function analyzeCaseSignals(ix: RepoIndex, input: GuessInput, limit = 8): CaseSignals {
  const blob = [input.subject, input.descriptionText].filter(Boolean).join("\n");
  const seed = guessDistricts(ix, { ...input, mentions: [] }, limit);
  const preferDirs = seed.flatMap((g) => g.entries.map((e) => e.relDir));
  const { mentions, unresolved } = resolveMentions(ix, blob, preferDirs);

  return {
    guesses: mentions.length ? guessDistricts(ix, { ...input, mentions }, limit) : seed,
    mentions,
    unresolvedMentions: unresolved,
  };
}

/** Below this, we don't believe our own guess. */
export const CONFIDENT_SCORE = 80;

export function looksUncertain(guesses: DistrictGuess[]): boolean {
  if (!guesses.length) return true;
  if (guesses[0].score < CONFIDENT_SCORE) return true;
  // A near-tie between the top two is also uncertain.
  return guesses.length > 1 && guesses[1].score >= guesses[0].score * 0.9;
}
