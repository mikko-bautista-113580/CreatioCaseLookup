import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkEdit } from "./fixPlan.js";
import { withCaseFiles } from "./caseFiles.js";
import { enumerateWorkspaces } from "./workspace.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "fixplan-"));
  mkdirSync(join(root, "EP-JAM"));
  writeFileSync(join(root, "top.cfm"), "alpha beta");
  writeFileSync(join(root, "EP-JAM", "ReportCard.cfm"), "<td>GPA</td>\n<td>Rank</td>\n");
  writeFileSync(join(root, "EP-JAM", "Other.cfm"), "not selected");
  const en = withCaseFiles(
    enumerateWorkspaces([root]),
    [{ rel: "EP-JAM/ReportCard.cfm", folder: root, score: 1, reason: "" }],
    [root]
  );
  return { root, en };
}

const edit = (file: string, folder: string, oldStr = "<td>GPA</td>") => ({
  file,
  folder,
  oldStr,
  newStr: "<td>Weighted GPA</td>",
  why: "",
});

test("a selected subfolder file is editable by its relative path", () => {
  const { root, en } = setup();
  const r = checkEdit(edit("EP-JAM/ReportCard.cfm", root), en, [root]);
  assert.equal(r.ok, true, r.problem);
  assert.equal(r.line, 1);
});

test("a Windows-style relative path is folded to the census name", () => {
  const { root, en } = setup();
  const r = checkEdit(edit("EP-JAM\\ReportCard.cfm", root), en, [root]);
  assert.equal(r.ok, true, r.problem);
  assert.equal(r.file, "EP-JAM/ReportCard.cfm");
});

test("traversal, absolute paths and unselected files are refused", () => {
  const { root, en } = setup();
  for (const f of ["../ReportCard.cfm", "EP-JAM/../top.cfm", join(root, "EP-JAM", "ReportCard.cfm"), "EP-JAM/Other.cfm"]) {
    const r = checkEdit(edit(f, root, "not selected"), en, [root]);
    assert.equal(r.ok, false, `${f} should be refused`);
  }
});

test("top-level files still work", () => {
  const { root, en } = setup();
  assert.equal(checkEdit(edit("top.cfm", root, "alpha"), en, [root]).ok, true);
});
