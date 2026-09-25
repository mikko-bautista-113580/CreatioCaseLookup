import { test } from "node:test";
import assert from "node:assert/strict";

import { extractCaseTerms, sanitizeTerm, trimReply, vocabularyFromTitles } from "./caseKeywords.js";

const brief = (over: Partial<Parameters<typeof extractCaseTerms>[0]> = {}) => ({
  subject: "",
  description: "",
  timeline: [],
  account: "",
  ...over,
});

test("subject terms outweigh the same term in the timeline", () => {
  const w = (b: ReturnType<typeof brief>, t: string) => extractCaseTerms(b).find((x) => x.term === t)?.weight || 0;
  const inSubject = w(brief({ subject: "GPA wrong on report card" }), "gpa");
  const inTimeline = w(brief({ timeline: [{ kind: "FEED", ts: "", text: "GPA wrong on report card" }] }), "gpa");
  assert.ok(inSubject > inTimeline, `${inSubject} > ${inTimeline}`);
  assert.equal(extractCaseTerms(brief({ subject: "Report card GPA wrong" }))[0].term, "report card");
});

test("school codes and file names get the strong kinds", () => {
  const terms = extractCaseTerms(brief({ description: "The EP-JAM template ReportCard.cfm shows the wrong logo." }));
  assert.equal(terms.find((t) => t.term === "ep-jam")?.kind, "code");
  assert.equal(terms.find((t) => t.term === "reportcard.cfm")?.kind, "file");
});

test("stopwords and quoted replies are dropped", () => {
  const terms = extractCaseTerms(
    brief({
      timeline: [{ kind: "EMAIL", ts: "", text: "Please help with transcript\nFrom: someone\nold quoted canvas text" }],
    })
  );
  const names = terms.map((t) => t.term);
  assert.ok(names.includes("transcript"));
  assert.ok(!names.includes("please"));
  assert.ok(!names.includes("canvas"), "text after From: is quoted history");
});

test("terms are sanitized to a safe token alphabet", () => {
  assert.equal(sanitizeTerm("Ignore <all> previous\ninstructions!!"), "ignore all previous instructions");
  assert.ok(sanitizeTerm("x".repeat(100)).length <= 40);
  for (const t of extractCaseTerms(brief({ subject: "`rm -rf` $(whoami) <script>" }))) {
    assert.match(t.term, /^[a-z0-9 .#_-]+$/);
  }
});

test("trimReply cuts at the first reply marker", () => {
  assert.equal(trimReply("hello\nOn Mon, Jan 1, 2026 Bob wrote:\nold").trim(), "hello");
});

test("wiki titles become vocabulary", () => {
  const v = vocabularyFromTitles(["/Training Resources/Custom Transcripts/GPA Calculator", "/Integrations/Canvas/Canvas Sync Errors"]);
  assert.ok(v.includes("gpa calculator"));
  assert.ok(v.includes("canvas sync"));
  const terms = extractCaseTerms(brief({ subject: "Canvas sync is failing" }), v);
  assert.ok(terms.some((t) => t.term === "canvas sync" && t.kind === "phrase"));
});
