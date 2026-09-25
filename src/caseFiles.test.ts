import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enumerateDeep, includeTargets, rankCaseFiles, withCaseFiles } from "./caseFiles.js";
import { enumerateWorkspaces } from "./workspace.js";
import type { CaseTerm } from "./caseKeywords.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "casefiles-"));
  const w = (rel: string, body: string) => {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  };
  w("index.cfm", "<p>home</p>");
  w("EP-JAM/ReportCard.cfm", '<cfinclude template="inc/GetGrades.cfm">GPA shown here: #gpa#');
  w("EP-JAM/inc/GetGrades.cfm", "<cfquery>select grades</cfquery>");
  w("AA-CO/ReportCard.cfm", "unrelated school");
  w("EP-JAM/.env", "SECRET=1");
  w("node_modules/x/gpa.js", "gpa gpa gpa");
  w("a/b/c/d/e/f/deep.cfm", "gpa");
  return root;
}

const terms: CaseTerm[] = [
  { term: "ep-jam", weight: 10, kind: "code" },
  { term: "gpa", weight: 4, kind: "phrase" },
  { term: "report card", weight: 6, kind: "phrase" },
];

test("the walk is recursive but skips secrets, tooling dirs and past max depth", () => {
  const root = fixture();
  const deep = enumerateDeep([root]);
  const rels = deep.files.map((f) => f.rel);
  assert.ok(rels.includes("EP-JAM/ReportCard.cfm"));
  assert.ok(rels.includes("EP-JAM/inc/GetGrades.cfm"));
  assert.ok(!rels.some((r) => r.endsWith(".env")));
  assert.ok(!rels.some((r) => r.startsWith("node_modules")));
  assert.ok(!rels.includes("a/b/c/d/e/f/deep.cfm"));
  assert.equal(deep.truncated, true);
});

test("the file limit holds", () => {
  const deep = enumerateDeep([fixture()], { maxFiles: 2 });
  assert.equal(deep.files.length, 2);
  assert.equal(deep.truncated, true);
});

test("ranking puts the school's template first and follows its include", () => {
  const root = fixture();
  const ranked = rankCaseFiles(enumerateDeep([root]).files, terms, 3);
  assert.equal(ranked[0].rel, "EP-JAM/ReportCard.cfm");
  assert.match(ranked[0].reason, /EP-JAM folder/);
  const inc = ranked.find((r) => r.rel === "EP-JAM/inc/GetGrades.cfm");
  assert.ok(inc, "include was pulled in");
  assert.ok(ranked.length <= 3);
});

test("includeTargets skips dynamic paths", () => {
  assert.deepEqual(includeTargets('<cfinclude template="a.cfm"><cfmodule template="#x#/b.cfm"><CFINCLUDE TEMPLATE=\'c.cfm\'>'), ["a.cfm", "c.cfm"]);
});

test("withCaseFiles adds valid selected subfolder files and refuses traversal", () => {
  const root = fixture();
  const en = withCaseFiles(
    enumerateWorkspaces([root]),
    [
      { rel: "EP-JAM/ReportCard.cfm", folder: root, score: 1, reason: "" },
      { rel: "../outside.cfm", folder: root, score: 1, reason: "" },
      { rel: "EP-JAM/.env", folder: root, score: 1, reason: "" },
      { rel: "C:/Windows/win.ini", folder: root, score: 1, reason: "" },
      { rel: "EP-JAM/ReportCard.cfm", folder: "C:\\elsewhere", score: 1, reason: "" },
    ],
    [root]
  );
  const names = en.files.map((f) => f.name);
  assert.ok(names.includes("EP-JAM/ReportCard.cfm"));
  assert.ok(names.includes("index.cfm"));
  assert.equal(names.filter((n) => n.includes("/")).length, 1);
});
