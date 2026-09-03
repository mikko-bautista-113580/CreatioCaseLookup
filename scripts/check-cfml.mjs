#!/usr/bin/env node
/**
 * check-cfml.mjs — static safety net for custom-reports edits.
 *
 * There is no build, no test suite and no CI gate in custom-reports: a CFML
 * syntax error ships straight to the NAS. This is the cheap check that runs
 * before a human ever looks at the diff.
 *
 * Usage:
 *   node scripts/check-cfml.mjs                    # every changed file in every subrepo
 *   node scripts/check-cfml.mjs <path> [<path>…]   # specific files (rel to repo root, or absolute)
 *   node scripts/check-cfml.mjs --dir ReportCardAO/EH-JAM   # every template in a folder
 *   node scripts/check-cfml.mjs --all-lines        # include pre-existing debt, not just my edits
 *   node scripts/check-cfml.mjs --json             # machine-readable output
 *
 * Exit code 0 = no errors (warnings allowed), 1 = at least one error, 2 = bad usage.
 *
 * ERRORS are things that are objectively wrong and will break at runtime or
 * violate a documented hard rule. WARNINGS need a human judgment call — they
 * are printed but never fail the run, because a checker that cries wolf gets
 * ignored, and then it protects nothing.
 *
 * SCOPING MATTERS MORE THAN THE RULES. These repos carry a decade of legacy:
 * `dbtype="ODBC"` and bare `#StudentID#` interpolation appear in almost every
 * district folder. A checker that reported all of it would fail on every file
 * anyone touched and get switched off within a day. So in the default (changed
 * files) mode, line-level findings are reported ONLY for lines the current diff
 * actually adds — "did my edit introduce this?", not "does this file have
 * debt?". File-level findings (broken pairing, unbalanced tags, a dangling
 * include) always report, because those break the file as a whole. Pass
 * `--all-lines` to audit everything.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

const REPO_ROOT = process.env.CUSTOM_REPORTS_ROOT || "C:\\neldevsrc\\custom-reports";

/** The ten independent git repos under custom-reports (mirrors src/repoIndex.ts). */
const SUBREPOS = [
  "ReportCardAO",
  "ReportCardPZ",
  "ReportCardRoot",
  "Transcripts",
  "ProgressReport",
  "ReportsCustomDL",
  "ReportsCustomMR",
  "ReportsCustomSZ",
  "ReportModules",
  "Modules",
];

/**
 * Where a `../Foo.cfm` include actually lands. On the NAS all report-card
 * repos deploy into one folder, so `../` from ReportCardAO/EH-JAM/ resolves to
 * a file that lives in the ReportCardRoot *repo*. Locally that path is a lie,
 * which is exactly why this check exists.
 */
const PARENT_FALLBACK = {
  ReportCardAO: ["ReportCardAO", "ReportCardRoot"],
  ReportCardPZ: ["ReportCardPZ", "ReportCardRoot"],
  ProgressReport: ["ProgressReport", "ReportCardRoot"],
  Transcripts: ["Transcripts"],
  ReportsCustomDL: ["ReportsCustomDL"],
  ReportsCustomMR: ["ReportsCustomMR"],
  ReportsCustomSZ: ["ReportsCustomSZ"],
  ReportModules: ["ReportModules"],
  Modules: ["Modules"],
  ReportCardRoot: ["ReportCardRoot"],
};

/**
 * Subrepos where the `.cfm` + `.htm` pairing rule actually holds — it is
 * documented in ReportCardRoot/CLAUDE.md and Transcripts/CLAUDE.md, and nowhere
 * else. Measured: ReportsCustomSZ has 441 unpaired `.cfm` against 6 paired, so
 * those repos are single-file by convention and checking them would emit
 * hundreds of false errors.
 */
const PAIRED_SUBREPOS = new Set([
  "ReportCardAO",
  "ReportCardPZ",
  "ProgressReport",
  "Transcripts",
]);

/** Frozen prior-year layouts: AA-TX-1_23-24.htm, FOO_20-21.htm. Never a live pair. */
const ARCHIVE_RE = /_\d{2}-\d{2}$/;

/** `.cfm` files that are includes by nature and legitimately have no `.htm` pair. */
const INCLUDE_NAME_RE = /(?:-Get|_DefaultVals|-Determine|Translate|English|Common|Values)/i;

/** Block-level CFML tags that must balance. */
const PAIRED_TAGS = ["cfif", "cfloop", "cfoutput", "cfquery", "cfsavecontent", "cftry", "cfswitch"];

const findings = [];
const add = (level, file, line, rule, message) =>
  findings.push({ level, file, line, rule, message });

// ---------------------------------------------------------------- input

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const allLines = argv.includes("--all-lines");
const args = argv.filter((a) => a !== "--json" && a !== "--all-lines");

/**
 * repo-relative path -> Set of line numbers this diff ADDS, or null meaning
 * "score every line". Populated only in changed-files mode.
 */
let addedLines = null;

/** Strip CFML (`<!--- --->`) and HTML comments so they don't trip the tag counter. */
function decomment(src) {
  return src.replace(/<!---[\s\S]*?--->/g, "").replace(/<!--[\s\S]*?-->/g, "");
}

/** Absolute path -> repo-relative, forward-slashed. */
function toRel(abs) {
  const root = resolve(REPO_ROOT) + sep;
  const full = resolve(abs);
  if (!full.toLowerCase().startsWith(root.toLowerCase())) return null;
  return full.slice(root.length).split(sep).join("/");
}

/** Every changed / untracked file across all subrepos, as repo-relative paths. */
function changedFiles() {
  const out = [];
  for (const sub of SUBREPOS) {
    const dir = join(REPO_ROOT, sub);
    if (!existsSync(join(dir, ".git"))) continue;
    let porcelain = "";
    try {
      porcelain = execFileSync("git", ["-C", dir, "status", "--porcelain"], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch {
      continue;
    }
    for (const raw of porcelain.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const status = raw.slice(0, 2);
      let p = raw.slice(3).trim();
      if (status.includes("D")) continue; // deleted — nothing left to lint
      if (p.includes(" -> ")) p = p.split(" -> ")[1]; // rename
      p = p.replace(/^"|"$/g, "");
      out.push(`${sub}/${p}`);
    }
    collectAddedLines(dir, sub);
  }
  return out;
}

/**
 * Record which lines the working-tree diff adds, per file. Untracked files get
 * `null` (score everything — the whole file is new, so all of it is mine).
 */
function collectAddedLines(dir, sub) {
  addedLines ??= new Map();
  let diff = "";
  try {
    // HEAD, not the index — otherwise a staged edit looks unchanged.
    diff = execFileSync("git", ["-C", dir, "diff", "HEAD", "-U0", "--no-color", "--", "."], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return;
  }
  let current = null;
  for (const line of diff.split(/\r?\n/)) {
    const fileM = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fileM) {
      current = `${sub}/${fileM[1]}`;
      if (!addedLines.has(current)) addedLines.set(current, new Set());
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const set = addedLines.get(current);
      for (let i = 0; i < count; i++) set.add(start + i);
    }
  }
}

/** Should a finding on this file/line be reported? */
function inScope(file, line) {
  if (allLines || addedLines === null) return true;
  if (!line) return true; // file-level finding — always report
  const set = addedLines.get(file);
  if (set === undefined) return true; // untracked / unknown — all of it is new
  return set.has(line);
}

/** Every .cfm/.htm directly under a folder. */
function filesInDir(rel) {
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return [];
  return readdirSync(abs)
    .filter((f) => /\.(cfm|htm|html)$/i.test(f))
    .map((f) => `${rel.split(sep).join("/")}/${f}`);
}

function collectTargets() {
  if (args.length === 0) return changedFiles();
  if (args[0] === "--dir") {
    if (!args[1]) {
      console.error("usage: check-cfml.mjs --dir <subrepo>/<district>");
      process.exit(2);
    }
    return args.slice(1).flatMap((d) => filesInDir(d));
  }
  return args
    .map((a) => (a.includes(":") || a.startsWith("/") ? toRel(a) : a.split(sep).join("/")))
    .filter(Boolean);
}

// ---------------------------------------------------------------- checks

/** Case-insensitive existence — the repos are inconsistent about casing. */
const dirCache = new Map();
function existsCI(relPath) {
  const dir = dirname(relPath);
  const name = basename(relPath).toLowerCase();
  let entries = dirCache.get(dir);
  if (!entries) {
    const abs = join(REPO_ROOT, dir);
    try {
      entries = new Set(readdirSync(abs).map((e) => e.toLowerCase()));
    } catch {
      entries = new Set();
    }
    dirCache.set(dir, entries);
  }
  return entries.has(name);
}

/** ERROR: a shipped hard rule from every CLAUDE.md in the tree. */
function checkOdbc(rel, src) {
  src.split(/\r?\n/).forEach((line, i) => {
    if (/dbtype\s*=\s*["']odbc["']/i.test(line)) {
      add("error", rel, i + 1, "odbc", 'dbtype="ODBC" must be removed — omit the attribute entirely');
    }
  });
}

/** ERROR: an include that resolves nowhere is a runtime crash. */
function checkIncludes(rel, src) {
  const sub = rel.split("/")[0];
  const dir = dirname(rel);
  const re = /<cfinclude\s+[^>]*template\s*=\s*["']([^"']+)["']/gi;
  const lines = src.split(/\r?\n/);

  let m;
  while ((m = re.exec(src)) !== null) {
    const target = m[1].trim();
    const line = src.slice(0, m.index).split(/\r?\n/).length;

    if (target.includes("#")) {
      add("warn", rel, line, "dynamic-include", `dynamic <cfinclude> "${target}" — cannot resolve statically; must never be built from user input`);
      continue;
    }

    const candidates = [];
    const tail = target.replace(/^(\.\.\/)+/, "");
    if (target.startsWith("../")) {
      // `../Foo.cfm` — sibling of the district folder after deploy.
      for (const home of PARENT_FALLBACK[sub] || [sub]) candidates.push(`${home}/${tail}`);
      candidates.push(join(dir, target).split(sep).join("/"));
    } else {
      candidates.push(join(dir, target).split(sep).join("/"));
      // Dispatcher templates are stored in a district folder but deploy to the
      // subrepo root, so a bare `Foo.cfm` resolves against the root at runtime.
      for (const home of PARENT_FALLBACK[sub] || [sub]) candidates.push(`${home}/${tail}`);
    }

    if (candidates.some((c) => existsCI(c))) continue;

    // Last resort: the file may exist in a sibling district folder. On the NAS
    // every district folder in a subrepo is a sibling of every other, so this
    // genuinely resolves at runtime even though the literal path does not
    // resolve locally. Report it, but as a warning — an error here would be a
    // false alarm, and false alarms are how a checker gets ignored.
    const found = findByBasename(sub, basename(tail));
    if (found) {
      add("warn", rel, line, "include-layout", `<cfinclude template="${target}"> does not resolve locally, but ${found} exists — relies on the flattened NAS layout; verify by hand`);
    } else {
      add("error", rel, line, "dangling-include", `<cfinclude template="${target}"> resolves to nothing, and no file named ${basename(tail)} exists anywhere in ${sub}`);
    }
  }

  void lines;
}

/** Case-insensitive basename search across one subrepo. Cached per subrepo. */
const basenameIndex = new Map();
function findByBasename(sub, name) {
  let idx = basenameIndex.get(sub);
  if (!idx) {
    idx = new Map();
    const walk = (relDir, depth) => {
      if (depth > 4) return;
      let entries = [];
      try {
        entries = readdirSync(join(REPO_ROOT, relDir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        const child = `${relDir}/${e.name}`;
        if (e.isDirectory()) walk(child, depth + 1);
        else if (!idx.has(e.name.toLowerCase())) idx.set(e.name.toLowerCase(), child);
      }
    };
    walk(sub, 0);
    basenameIndex.set(sub, idx);
  }
  return idx.get(name.toLowerCase()) || null;
}

/**
 * Unbalanced block tags — the classic Excel-export edit casualty.
 *
 * Counted twice, and that is not paranoia. Legacy files are full of commented-out
 * blocks whose `<!---` opens inside one tag and closes inside another
 * (`<!---<cfif Termid is 1>` … `</cfif>--->`), so stripping comments can *create*
 * an imbalance in a file that is actually fine. Central-RC.cfm is exactly this:
 * 30 `<cfif>` and 30 `</cfif>` raw, apparently off-by-one once stripped.
 *
 * So: ERROR only when raw AND stripped both disagree — that is a real broken
 * file. If only one view disagrees, comments are asymmetric and the count proves
 * nothing; say so as a warning rather than crying wolf.
 */
function checkBalance(rel, src) {
  const clean = decomment(src);
  for (const tag of PAIRED_TAGS) {
    const openRe = new RegExp(`<${tag}\\b(?![^>]*/>)`, "gi");
    const closeRe = new RegExp(`</${tag}\\s*>`, "gi");
    const rawOpen = (src.match(openRe) || []).length;
    const rawClose = (src.match(closeRe) || []).length;
    const clnOpen = (clean.match(openRe) || []).length;
    const clnClose = (clean.match(closeRe) || []).length;
    const rawOff = rawOpen !== rawClose;
    const clnOff = clnOpen !== clnClose;

    if (rawOff && clnOff) {
      add("error", rel, 0, "unbalanced", `<${tag}> opened ${rawOpen}× but closed ${rawClose}× (also unbalanced ignoring comments: ${clnOpen}/${clnClose})`);
    } else if (rawOff || clnOff) {
      add("warn", rel, 0, "unbalanced-comments", `<${tag}> counts differ between raw (${rawOpen}/${rawClose}) and comment-stripped (${clnOpen}/${clnClose}) — a commented-out block straddles a tag; check by eye if you edited near one`);
    }
  }
}

/** WARN: interpolation inside a query body that is not a <cfqueryparam>. */
function checkQueryParams(rel, src) {
  const clean = decomment(src);
  const re = /<cfquery\b[^>]*>([\s\S]*?)<\/cfquery\s*>/gi;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const body = m[1];
    const bodyStart = m.index + m[0].indexOf(body);
    // blank out every cfqueryparam tag — anything left is raw interpolation
    const bare = body.replace(/<cfqueryparam\b[^>]*>/gi, (t) => " ".repeat(t.length));
    const hashRe = /#([A-Za-z_][\w.\[\]'"$]*)#/g;
    let h;
    while ((h = hashRe.exec(bare)) !== null) {
      const line = clean.slice(0, bodyStart + h.index).split(/\r?\n/).length;
      add("warn", rel, line, "cfqueryparam", `#${h[1]}# is interpolated into SQL without <cfqueryparam>`);
    }
  }
}

/** WARN: url./form. read without a <cfparam> default above it. */
function checkCfparam(rel, src) {
  const clean = decomment(src);
  const declared = new Set();
  const pRe = /<cfparam\b[^>]*name\s*=\s*["'](url|form)\.([\w]+)["']/gi;
  let p;
  while ((p = pRe.exec(clean)) !== null) declared.add(`${p[1].toLowerCase()}.${p[2].toLowerCase()}`);

  const uRe = /\b(url|form)\.([\w]+)/gi;
  const seen = new Set();
  let u;
  while ((u = uRe.exec(clean)) !== null) {
    const key = `${u[1].toLowerCase()}.${u[2].toLowerCase()}`;
    if (declared.has(key) || seen.has(key)) continue;
    seen.add(key);
    const line = clean.slice(0, u.index).split(/\r?\n/).length;
    add("warn", rel, line, "cfparam", `${u[1]}.${u[2]} is used with no <cfparam> default declared`);
  }
}

/**
 * ERROR: broken .cfm/.htm pairing.
 *
 * Only main templates pair. A `CODE-GetGrades.cfm` include has no `.htm` and
 * never should, and a `FOO_23-24.htm` is a frozen prior-year archive.
 */
function checkPairing(rel) {
  const ext = extname(rel).toLowerCase();
  const stem = rel.slice(0, -ext.length);
  const name = basename(stem);

  if (!PAIRED_SUBREPOS.has(rel.split("/")[0])) return;

  if (ARCHIVE_RE.test(name)) {
    add("warn", rel, 0, "archive", "looks like a frozen prior-year layout (_YY-YY suffix) — these are normally never edited");
    return;
  }

  if (ext === ".cfm") {
    if (INCLUDE_NAME_RE.test(name)) return; // an include, not a template
    if (isIncludedLocally(rel)) return; // pulled in by a sibling — also an include
    if (!existsCI(`${stem}.htm`) && !existsCI(`${stem}.html`)) {
      add("error", rel, 0, "pairing", `no paired .htm — every main template needs both halves`);
    }
  } else if (ext === ".htm" || ext === ".html") {
    if (!existsCI(`${stem}.cfm`)) {
      add("error", rel, 0, "pairing", `no paired .cfm — this .htm is an orphan (archive? wrong file?)`);
    }
  }
}

/** Is this .cfm <cfinclude>d by a sibling in the same folder? */
const includeCache = new Map();
function isIncludedLocally(rel) {
  const dir = dirname(rel);
  const me = basename(rel).toLowerCase();
  let included = includeCache.get(dir);
  if (!included) {
    included = new Set();
    const abs = join(REPO_ROOT, dir);
    let entries = [];
    try {
      entries = readdirSync(abs).filter((f) => /\.(cfm|htm|html)$/i.test(f));
    } catch {
      /* unreadable dir */
    }
    for (const f of entries) {
      let src = "";
      try {
        src = readFileSync(join(abs, f), "utf8");
      } catch {
        continue;
      }
      const re = /<cfinclude\s+[^>]*template\s*=\s*["']([^"']+)["']/gi;
      let m;
      while ((m = re.exec(src)) !== null) included.add(basename(m[1]).toLowerCase());
    }
    includeCache.set(dir, included);
  }
  return included.has(me);
}

// ---------------------------------------------------------------- run

const targets = collectTargets().filter((t) => /\.(cfm|htm|html)$/i.test(t));

if (targets.length === 0) {
  const msg = "No .cfm/.htm files to check.";
  console.log(asJson ? JSON.stringify({ ok: true, checked: 0, findings: [] }, null, 2) : msg);
  process.exit(0);
}

for (const rel of targets) {
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs)) {
    add("error", rel, 0, "missing", "file does not exist under CUSTOM_REPORTS_ROOT");
    continue;
  }
  let src = "";
  try {
    src = readFileSync(abs, "utf8");
  } catch (e) {
    add("error", rel, 0, "unreadable", String(e.message || e));
    continue;
  }
  checkPairing(rel);
  checkOdbc(rel, src);
  checkIncludes(rel, src);
  checkBalance(rel, src);
  checkQueryParams(rel, src);
  checkCfparam(rel, src);
}

const scoped = findings.filter((f) => inScope(f.file, f.line));
const suppressed = findings.length - scoped.length;
const errors = scoped.filter((f) => f.level === "error");
const warns = scoped.filter((f) => f.level === "warn");

if (asJson) {
  console.log(
    JSON.stringify(
      { ok: errors.length === 0, checked: targets.length, suppressed, findings: scoped },
      null,
      2
    )
  );
} else {
  const mode = allLines || addedLines === null ? "whole file" : "changed lines only";
  console.log(`Checked ${targets.length} file(s) under ${REPO_ROOT}  (${mode})\n`);
  for (const f of [...errors, ...warns]) {
    const tag = f.level === "error" ? "ERROR" : "warn ";
    const where = f.line ? `${f.file}:${f.line}` : f.file;
    console.log(`${tag}  ${where}  [${f.rule}]  ${f.message}`);
  }
  if (scoped.length === 0) console.log("No problems found.");
  else console.log(`\n${errors.length} error(s), ${warns.length} warning(s).`);
  if (suppressed > 0) {
    console.log(
      `${suppressed} pre-existing finding(s) on lines this diff did not touch — run with --all-lines to see them.`
    );
  }
}

process.exit(errors.length > 0 ? 1 : 0);
