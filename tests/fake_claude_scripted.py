"""Scripted stand-in for the `claude` CLI, used by test_analyze_workspace.py
and test_fix_plan.py.

Reads stdin to EOF, then follows the JSON script named by FAKE_SCRIPT:
  {"chunks": [str], "tools": [{"name", "input"}], "result": {...} | null,
   "hang": bool, "argv_out": path | null, "stdin_out": path | null}
`argv_out` / `stdin_out` record what the child received, for assertions.
"""

import json
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    data = sys.stdin.buffer.read().decode("utf-8")
    with open(os.environ["FAKE_SCRIPT"], encoding="utf-8") as f:
        script = json.load(f)
    if script.get("argv_out"):
        with open(script["argv_out"], "w", encoding="utf-8") as f:
            json.dump({"argv": sys.argv[1:], "cwd": os.getcwd()}, f)
    if script.get("stdin_out"):
        with open(script["stdin_out"], "w", encoding="utf-8", newline="") as f:
            f.write(data)
    for t in script.get("tools") or []:
        emit({"type": "assistant", "message": {"content": [{"type": "tool_use", **t}]}})
    for c in script.get("chunks") or []:
        emit({"type": "stream_event", "event": {"type": "content_block_delta",
              "delta": {"type": "text_delta", "text": c}}})
    if script.get("hang"):
        time.sleep(60)
    if script.get("result") is not None:
        emit({"type": "result", "subtype": "success", **script["result"]})


if __name__ == "__main__":
    main()
