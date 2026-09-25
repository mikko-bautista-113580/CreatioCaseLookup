/**
 * Work out a case's scope: its keywords, the related workspace files, and the
 * team-wiki pages that apply. Deterministic and model-free — this is the fast
 * step that decides what the case-scoped analysis reads.
 *
 * Shared by the web server (preview + analyze) and workspaceCli (`scope`), so
 * the app and the skills always agree on what "related to this case" means.
 */

import type { CaseBrief } from "./caseBrief.js";
import { extractCaseTerms, vocabularyFromTitles, type CaseTerm } from "./caseKeywords.js";
import { enumerateDeep, rankCaseFiles, type RankedFile } from "./caseFiles.js";
import { getWikiPage, getWikiTree, wikiConfig, WikiUnavailable, type WikiPageInfo } from "./adoWiki.js";
import { selectWikiPages } from "./wikiSelect.js";
import { fileCap } from "./workspace.js";

export interface ScopeWikiPage {
  path: string;
  url: string;
  score: number;
  why: string;
  content: string;
}

export interface CaseScope {
  caseNumber: string;
  terms: CaseTerm[];
  files: RankedFile[];
  /** How many files the recursive walk saw, and whether it stopped early. */
  searched: number;
  searchTruncated: boolean;
  cap: number;
  wiki: ScopeWikiPage[];
  /** Set when no wiki pages were used — the reason, for the UI and the report. */
  wikiSkipped?: string;
  durationMs: number;
}

export async function computeCaseScope(
  brief: CaseBrief,
  paths: string[],
  opts: { wiki?: boolean } = {}
): Promise<CaseScope> {
  const started = Date.now();

  // The wiki tree doubles as vocabulary for the keywords, so fetch it first.
  let tree: WikiPageInfo[] | null = null;
  let wikiSkipped: string | undefined;
  if (opts.wiki !== false) {
    try {
      tree = await getWikiTree();
    } catch (e) {
      wikiSkipped = e instanceof WikiUnavailable ? e.message : `Team wiki skipped: ${e instanceof Error ? e.message : String(e)}`;
    }
  } else {
    wikiSkipped = "Team wiki lookup was not requested.";
  }

  const terms = extractCaseTerms(brief, tree ? vocabularyFromTitles(tree.map((p) => p.path)) : []);
  const cap = fileCap();
  // Walk folders named after the case's school codes first.
  const deep = enumerateDeep(paths, { prefer: terms.filter((t) => t.kind === "code").map((t) => t.term) });
  const files = rankCaseFiles(deep.files, terms, cap);

  let wiki: ScopeWikiPage[] = [];
  if (tree) {
    const sel = await selectWikiPages(tree, terms, (p) => getWikiPage(p), wikiConfig().maxPages);
    wiki = sel.pages.map((p) => ({ path: p.path, url: p.url, score: p.score, why: p.why, content: p.content }));
    if (!wiki.length) wikiSkipped = sel.skipped;
  }

  return {
    caseNumber: brief.number,
    terms,
    files,
    searched: deep.files.length,
    searchTruncated: deep.truncated,
    cap,
    wiki,
    wikiSkipped,
    durationMs: Date.now() - started,
  };
}

/** The scope without page bodies — what the preview endpoint and the CLI print. */
export function scopeSummary(s: CaseScope) {
  return { ...s, wiki: s.wiki.map(({ content: _c, ...rest }) => ({ ...rest, chars: _c.length })) };
}
