"""PreToolUse hook: inject the Creatio query reference into context the first
time a creatio_* MCP tool is used in a session (settings.local.json uses once:true)."""

import json
import sys
from pathlib import Path

ref_path = Path(__file__).resolve().parents[2] / "CASE-QUERY-REFERENCE.md"
try:
    ref = ref_path.read_text(encoding="utf-8")
except OSError:
    ref = f"(CASE-QUERY-REFERENCE.md not found at {ref_path})"

# The reference contains emoji; the Windows console default would choke on them.
sys.stdout.reconfigure(encoding="utf-8")
sys.stdout.write(
    json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "additionalContext": "Creatio MCP query reference (follow this doc when using the creatio_* tools):\n\n" + ref,
            }
        },
        ensure_ascii=False,
    )
)
