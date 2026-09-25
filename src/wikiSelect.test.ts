import { test } from "node:test";
import assert from "node:assert/strict";

import { clipWikiPages, MAX_PAGE_CHARS, rescoreByContent, scoreByPath, selectWikiPages } from "./wikiSelect.js";
import type { CaseTerm } from "./caseKeywords.js";

const tree = [
  { path: "/Training Resources", section: true },
  { path: "/Training Resources/Report Card Variables", section: false },
  { path: "/Training Resources/Custom Transcripts", section: true },
  { path: "/Training Resources/Custom Transcripts/GPA Calculator", section: false },
  { path: "/Policies and Procedures/Report Card Testing Email", section: false },
  { path: "/Training Resources/Integrations/Canvas/Canvas Sync Errors", section: false },
];

const terms: CaseTerm[] = [
  { term: "gpa", weight: 6, kind: "phrase" },
  { term: "transcript", weight: 4, kind: "phrase" },
];

test("stage 1 ranks leaf titles above sections and ignores unrelated pages", () => {
  const r = scoreByPath(tree, terms);
  assert.equal(r[0].path, "/Training Resources/Custom Transcripts/GPA Calculator");
  assert.ok(!r.some((p) => p.path.includes("Canvas")));
});

test("stage 2 drops empty folder pages and keeps content matches", () => {
  const c = scoreByPath(tree, terms);
  const contents = new Map([
    ["/Training Resources/Custom Transcripts/GPA Calculator", "How the GPA is computed for a transcript. gpa gpa weighting rules and more text here."],
    ["/Training Resources/Custom Transcripts", ""],
  ]);
  const r = rescoreByContent(c, contents, terms);
  assert.equal(r[0].path, "/Training Resources/Custom Transcripts/GPA Calculator");
  assert.ok(!r.some((p) => p.path === "/Training Resources/Custom Transcripts"));
});

test("nothing is returned when no title matches", async () => {
  const sel = await selectWikiPages(tree, [{ term: "cafeteria", weight: 9, kind: "word" }], async () => {
    throw new Error("should not fetch");
  }, 4);
  assert.equal(sel.pages.length, 0);
  assert.ok(sel.skipped);
});

test("page fetch failures are tolerated", async () => {
  const sel = await selectWikiPages(tree, terms, async (p) => {
    if (p.includes("GPA")) return { path: p, url: "u", content: "GPA and transcript details. ".repeat(5) };
    throw new Error("boom");
  }, 4);
  assert.deepEqual(sel.pages.map((p) => p.path), ["/Training Resources/Custom Transcripts/GPA Calculator"]);
});

test("clipping bounds each page and the total", () => {
  const big = { content: "x".repeat(50_000) };
  const out = clipWikiPages([big, big, big, big, big]);
  assert.ok(out[0].content.length <= MAX_PAGE_CHARS + 30);
  assert.ok(out.reduce((n, p) => n + p.content.length, 0) <= 20_000 + 100);
});
