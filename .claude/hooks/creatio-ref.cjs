// PreToolUse hook: injects the Creatio query reference into context the first
// time a creatio_* MCP tool is used in a session (settings.local.json uses once:true).
const fs = require("fs");
const path = require("path");
const refPath = path.join(__dirname, "..", "..", "CASE-QUERY-REFERENCE.md");
let ref = "";
try { ref = fs.readFileSync(refPath, "utf8"); }
catch (e) { ref = "(CASE-QUERY-REFERENCE.md not found at " + refPath + ")"; }
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext:
      "Creatio MCP query reference (follow this doc when using the creatio_* tools):\n\n" + ref,
  },
}));
