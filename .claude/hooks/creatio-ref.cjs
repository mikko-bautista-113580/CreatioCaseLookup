// PreToolUse hook: injects the Creatio query reference into context the first
// time a creatio_* MCP tool is used in a session.
//
// settings.json asks for `once: true`, but this script does not rely on it —
// it keeps its own per-session marker so the 13.5 KB reference is injected
// exactly once even if the runtime ignores that flag. Re-injecting on every
// creatio_* call would quietly burn context.
const fs = require("fs");
const os = require("os");
const path = require("path");

let payload = "";
try {
  payload = fs.readFileSync(0, "utf8");
} catch (e) {
  /* no stdin available — fall through and inject */
}

let sessionId = "";
try {
  sessionId = String(JSON.parse(payload || "{}").session_id || "");
} catch (e) {
  /* unparseable payload — fall through and inject */
}

const emit = (context) =>
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: context,
      },
    })
  );

// Already injected for this session? Say nothing.
let marker = "";
if (/^[A-Za-z0-9._-]+$/.test(sessionId)) {
  marker = path.join(os.tmpdir(), "creatio-ref-" + sessionId + ".seen");
  if (fs.existsSync(marker)) {
    emit("");
    process.exit(0);
  }
}

const refPath = path.join(__dirname, "..", "..", "CASE-QUERY-REFERENCE.md");
let ref = "";
try {
  ref = fs.readFileSync(refPath, "utf8");
} catch (e) {
  ref = "(CASE-QUERY-REFERENCE.md not found at " + refPath + ")";
}

if (marker) {
  try {
    fs.writeFileSync(marker, new Date().toISOString());
  } catch (e) {
    /* best effort — a failed marker just means we may inject again */
  }
}

emit(
  "Creatio MCP query reference (follow this doc when using the creatio_* tools):\n\n" +
    ref
);
