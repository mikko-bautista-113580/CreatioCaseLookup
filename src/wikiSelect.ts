/**
 * Pick the team-wiki pages that match a case.
 *
 * Two stages, both deterministic:
 *   1. score every page PATH against the case terms (titles are short and the
 *      team names pages well, so this alone usually finds the right section);
 *   2. fetch the best ~12 and re-score on their CONTENT, which separates, say,
 *      "Custom Report Card Workflow" from "Report Card Testing Email".
 *
 * Only pages scoring above MIN_SCORE are kept — returning nothing is better
 * than handing the analysis an irrelevant page to anchor on.
 */

import type { CaseTerm } from "./caseKeywords.js";
import { normalizeText } from "./caseKeywords.js";
import type { WikiPage, WikiPageInfo } from "./adoWiki.js";

const STAGE2_CANDIDATES = 12;
const MIN_SCORE = 4;
/** How much of a page goes into a prompt. */
export const MAX_PAGE_CHARS = 6_000;
export const MAX_WIKI_CHARS = 20_000;

export interface ScoredPage {
  path: string;
  id?: number;
  score: number;
  why: string;
}

function hits(hay: string, term: string): number {
  if (!term) return 0;
  const re = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^a-z0-9])`, "g");
  return (hay.match(re) || []).length;
}

/**
 * How distinctive a term is across a collection: ~1 when it appears almost
 * nowhere, falling towards 0 as it appears everywhere. "report" in a wiki full
 * of report pages, or in a folder full of report cards, picks nothing out.
 */
export function idf(df: number, n: number): number {
  if (n <= 1) return 1;
  return Math.log(1 + n / (1 + df)) / Math.log(1 + n);
}

/** Stage 1: score by path. Exported for tests. */
export function scoreByPath(pages: WikiPageInfo[], terms: CaseTerm[]): ScoredPage[] {
  const parsed = pages.map((p) => {
    const segs = p.path.split("/").filter(Boolean);
    return {
      p,
      title: normalizeText((segs.at(-1) || "").replace(/[-_]/g, " ")),
      parents: normalizeText(segs.slice(0, -1).join(" ").replace(/[-_]/g, " ")),
    };
  });
  const factor = new Map(
    terms.map((t) => [t.term, idf(parsed.filter((x) => hits(x.title, t.term)).length, parsed.length)])
  );
  return parsed
    .map(({ p, title, parents }) => {
      let score = 0;
      const matched: string[] = [];
      for (const t of terms) {
        const inTitle = hits(title, t.term);
        const inParent = hits(parents, t.term);
        if (inTitle || inParent) {
          score += t.weight * (inTitle ? 1 : 0.4) * (factor.get(t.term) ?? 1);
          matched.push(t.term);
        }
      }
      // A leaf is a page about one thing; a section root is a table of contents.
      if (p.section) score *= 0.6;
      return { path: p.path, id: p.id, score, why: matched.length ? `title matches ${matched.slice(0, 4).join(", ")}` : "" };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

/** Stage 2: add content hits. Exported for tests. */
export function rescoreByContent(candidates: ScoredPage[], contents: Map<string, string>, terms: CaseTerm[]): ScoredPage[] {
  return candidates
    .map((c) => {
      const body = normalizeText((contents.get(c.path) || "").replace(/[-_]/g, " "));
      let add = 0;
      const matched: string[] = [];
      for (const t of terms) {
        const n = hits(body, t.term);
        if (n) {
          // Diminishing returns: a page that says "gpa" 40 times isn't 40x better.
          add += t.weight * Math.min(3, Math.log2(1 + n));
          matched.push(t.term);
        }
      }
      // An empty page (a pure folder) can't teach the analysis anything.
      const empty = body.length < 40;
      const score = empty ? 0 : c.score + add * 0.5;
      const why = [c.why, matched.length ? `mentions ${matched.slice(0, 4).join(", ")}` : ""].filter(Boolean).join("; ");
      return { ...c, score: Math.round(score * 10) / 10, why };
    })
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

export interface WikiSelection {
  pages: (ScoredPage & { url: string; content: string })[];
  /** Why no pages were used, when none were. */
  skipped?: string;
}

/**
 * Run both stages. `fetchPage` failures for individual pages are tolerated —
 * the page is simply dropped.
 */
export async function selectWikiPages(
  tree: WikiPageInfo[],
  terms: CaseTerm[],
  fetchPage: (path: string) => Promise<WikiPage>,
  maxPages: number
): Promise<WikiSelection> {
  const stage1 = scoreByPath(tree, terms).slice(0, STAGE2_CANDIDATES);
  if (!stage1.length) return { pages: [], skipped: "No wiki page title matched this case's keywords." };

  const fetched = await Promise.all(
    stage1.map(async (c) => {
      try {
        return await fetchPage(c.path);
      } catch {
        return null;
      }
    })
  );
  const byPath = new Map<string, WikiPage>();
  for (const p of fetched) if (p) byPath.set(p.path, p);
  const contents = new Map([...byPath].map(([k, v]) => [k, v.content]));

  const ranked = rescoreByContent(stage1, contents, terms).slice(0, maxPages);
  if (!ranked.length) return { pages: [], skipped: "No wiki page was relevant enough to this case." };
  return {
    pages: ranked.map((r) => {
      const page = byPath.get(r.path)!;
      return { ...r, url: page.url, content: page.content };
    }),
  };
}

/** Clip the chosen pages to the prompt budget: per page, then in total. */
export function clipWikiPages<T extends { content: string }>(pages: T[]): T[] {
  let left = MAX_WIKI_CHARS;
  const out: T[] = [];
  for (const p of pages) {
    if (left <= 500) break;
    const n = Math.min(MAX_PAGE_CHARS, left);
    const content = p.content.length > n ? p.content.slice(0, n) + "\n… [page clipped]" : p.content;
    left -= content.length;
    out.push({ ...p, content });
  }
  return out;
}
