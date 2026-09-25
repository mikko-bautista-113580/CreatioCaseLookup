/**
 * Turn a case brief into a short list of weighted search terms.
 *
 * Pure and deterministic — no model, no I/O. The terms drive two rankings:
 * which workspace files are related to the case (./caseFiles.ts) and which
 * team-wiki pages are (./wikiSelect.ts).
 *
 * SANITIZED BY CONSTRUCTION: every term is lowercased, reduced to
 * [a-z0-9 .#_-] and at most 40 characters, and there are at most MAX_TERMS of
 * them. That is what lets the case-scoped analysis receive the terms without
 * receiving case prose — a client can't smuggle an instruction through a list
 * of short keyword tokens. See the trust note in ./analyzeWorkspace.ts.
 */

import type { CaseBrief } from "./caseBrief.js";

export type TermKind = "code" | "file" | "phrase" | "word";

export interface CaseTerm {
  term: string;
  weight: number;
  kind: TermKind;
}

const MAX_TERMS = 20;
const MAX_TERM_CHARS = 40;
const TIMELINE_ENTRIES = 10;

/** Domain phrases that always count, on top of the wiki's own page titles. */
const BUILTIN_PHRASES = [
  "report card",
  "progress report",
  "transcript",
  "web form",
  "maintenance job",
  "honor roll",
  "state report",
  "gpa",
  "gradebook",
  "attendance",
  "schedule",
  "label",
  "census",
  "diocese",
  "standards",
  "logo",
  "comment",
  "signature",
  "export",
  "import",
  "integration",
  "skillset",
  "homeroom",
  "hr class",
  "final grade",
  "term columns",
  "student id",
  "color scheme",
];

const STOPWORDS = new Set(
  (
    "a an the and or but if then else of to in on at by for with from as is are was were be been being " +
    "it its this that these those there here i we you he she they me us him her them my our your their " +
    "do does did done have has had not no yes can could would should will shall may might must " +
    "please thanks thank hello hi hey dear regards best kind sincerely team support ticket case " +
    "sr issue problem help need needs want wants like just also still again any some all more most " +
    "very so too get got see seen look looks looking know let lets make made use used using work works " +
    "working new old one two three first last next time today tomorrow yesterday day week " +
    "email sent send attached attachment below above following would like able fix fixed update updated " +
    "school facts renweb client customer thing things way " +
    // File extensions and request boilerplate: everywhere in a report folder,
    // so they rank everything equally and pick nothing.
    "cfm cfc htm html sql css jpg jpeg png gif pdf doc docx xls xlsx csv txt " +
    "template templates sample samples refer required change changes pull pulls pulling display " +
    "replace remove removed section below correspond numbered items item proceed approved hours " +
    "checked check will shall into each under which what when where who whom how than"
  ).split(/\s+/)
);

/** Drop quoted reply history from an email body. */
export function trimReply(text: string): string {
  const s = String(text || "");
  const cut = s.search(
    /(^|\n)\s*(From:|-----\s*Original Message|On .{3,80} wrote:|Caution: This Message is From an External Sender)/i
  );
  return cut > 0 ? s.slice(0, cut) : s;
}

/** Lowercase and reduce to the term alphabet, keeping the full length — for matching text. */
export function normalizeText(t: string): string {
  return String(t || "")
    .toLowerCase()
    .replace(/[^a-z0-9 .#_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A single term: normalized AND bounded to MAX_TERM_CHARS. */
export function sanitizeTerm(t: string): string {
  return normalizeText(t).slice(0, MAX_TERM_CHARS).trim();
}

/**
 * Vocabulary taken from the wiki's page titles: every one- and two-word run in
 * a leaf title. Keeps the phrase list in step with what the team documents
 * (Canvas, Clever, OneRoster, GPA Calculator…) without a hard-coded list.
 */
export function vocabularyFromTitles(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const title = p.split("/").pop() || "";
    const words = sanitizeTerm(title.replace(/[-_]/g, " "))
      .split(" ")
      .filter((w) => w.length > 2 && !STOPWORDS.has(w));
    for (let i = 0; i < words.length; i++) {
      out.add(words[i]);
      if (i + 1 < words.length) out.add(`${words[i]} ${words[i + 1]}`);
    }
  }
  return [...out];
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  const re = new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^a-z0-9])`, "g");
  return (hay.match(re) || []).length;
}

/**
 * Extract weighted terms from a brief.
 *
 * Sources and weights: subject ×3, description ×2, the latest timeline entries
 * ×1 (quoted replies trimmed). School codes ("EP-JAM") and file names
 * ("ReportCard.cfm") are the strongest signals a case carries, so they get a
 * fixed high weight whenever they appear anywhere.
 */
export function extractCaseTerms(brief: Pick<CaseBrief, "subject" | "description" | "timeline" | "account">, vocabulary: string[] = []): CaseTerm[] {
  const tl = (brief.timeline || []).slice(-TIMELINE_ENTRIES).map((t) => trimReply(t.text));
  const sources: { text: string; w: number }[] = [
    { text: brief.subject || "", w: 3 },
    { text: brief.description || "", w: 2 },
    ...tl.map((text) => ({ text, w: 1 })),
  ];
  const rawAll = sources.map((s) => s.text).join("\n");

  const scores = new Map<string, { weight: number; kind: TermKind }>();
  const add = (term: string, weight: number, kind: TermKind) => {
    const t = sanitizeTerm(term);
    if (!t || t.length < 2) return;
    const cur = scores.get(t);
    if (cur) {
      cur.weight += weight;
      // Keep the strongest kind a term was seen as.
      const rank: TermKind[] = ["code", "file", "phrase", "word"];
      if (rank.indexOf(kind) < rank.indexOf(cur.kind)) cur.kind = kind;
    } else scores.set(t, { weight, kind });
  };

  // School codes: two uppercase groups joined by a hyphen, as the report folders use.
  // Their pieces ("ep", "jam") are fragments, not words worth searching for.
  const fragments = new Set<string>();
  for (const m of rawAll.matchAll(/\b([A-Z]{2,6}-[A-Z]{2,6})\b/g)) {
    add(m[1], 10, "code");
    for (const part of m[1].toLowerCase().split("-")) fragments.add(part);
  }
  // File names mentioned outright — the bare name, without any folder prefix.
  for (const m of rawAll.matchAll(/\b([\w-]{2,60}\.(?:cfm|cfc|htm|html|sql|js|css|xml))\b/gi)) {
    add(m[1], 10, "file");
    for (const part of m[1].toLowerCase().split(/[-_.]/)) fragments.add(part);
  }

  // Phrases: built-ins plus the wiki vocabulary.
  const phrases = [...new Set([...BUILTIN_PHRASES, ...vocabulary.map(sanitizeTerm)])].filter(
    (p) => p.length > 2
  );
  // A one-word phrase is already scored as a phrase — don't count it again as a word.
  const phraseWords = new Set(phrases.filter((p) => !p.includes(" ")));
  for (const s of sources) {
    const hay = normalizeText(s.text.replace(/[-_]/g, " "));
    if (!hay) continue;
    for (const p of phrases) {
      const n = countOccurrences(hay, p);
      if (n) add(p, n * s.w * (p.includes(" ") ? 2 : 1.5), "phrase");
    }
    // Plain words, weighted by source.
    for (const w of hay.split(" ")) {
      if (w.length < 3 || STOPWORDS.has(w) || phraseWords.has(w) || fragments.has(w) || /^[\d.]+$/.test(w)) continue;
      // "rc.cfm" and similar: a word carrying a dot is a file fragment.
      if (w.includes(".")) continue;
      add(w, s.w * 0.5, "word");
    }
  }

  // The account name can be the only pointer to the school's folder.
  for (const w of normalizeText(brief.account || "").split(" ")) {
    if (w.length > 3 && !STOPWORDS.has(w)) add(w, 1, "word");
  }

  return [...scores.entries()]
    .map(([term, v]) => ({ term, weight: Math.round(v.weight * 10) / 10, kind: v.kind }))
    // A word that's already part of a kept phrase adds nothing but noise.
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    .filter((t, _i, all) => t.kind !== "word" || !all.some((o) => o.kind === "phrase" && o.term.includes(" ") && o.term.split(" ").includes(t.term) && o.weight >= t.weight))
    .slice(0, MAX_TERMS);
}
