"""Stand-in for the `claude` CLI used by tests/test_claude_run.py.

Behaviour is picked by the FAKE_CLAUDE_MODE environment variable. It always
reads stdin to EOF first (like the real CLI) so the runner's stdin handling is
exercised.
"""

import json
import sys
import time

# The real CLI writes UTF-8; do the same regardless of the console code page.
sys.stdout.reconfigure(encoding="utf-8")


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def delta(text):
    emit({"type": "stream_event", "event": {"type": "content_block_delta",
          "delta": {"type": "text_delta", "text": text}}})


def main():
    import os
    mode = os.environ.get("FAKE_CLAUDE_MODE", "ok")
    data = sys.stdin.buffer.read().decode("utf-8")

    if mode == "ok":
        sys.stdout.write("not json noise\n")
        emit({"type": "system", "subtype": "init"})
        delta("Hello ")
        delta("wörld")
        emit({"type": "assistant", "message": {"content": [
            {"type": "text", "text": "x"},
            {"type": "tool_use", "name": "Read", "input": {"file_path": "a.txt"}},
        ]}})
        emit({"type": "result", "subtype": "success", "result": "Hello wörld",
              "total_cost_usd": 0.0123, "usage": {"input_tokens": 10, "output_tokens": 5},
              "duration_ms": 42})
    elif mode == "echo":
        delta("STDIN:" + data)
        emit({"type": "result", "subtype": "success", "result": "done"})
    elif mode == "argv":
        delta(json.dumps(sys.argv[1:]))
        emit({"type": "result", "subtype": "success", "result": "done"})
    elif mode == "result_only":
        # No trailing newline on the last line: exercises the close-time flush.
        sys.stdout.write(json.dumps({"type": "result", "subtype": "success",
                                     "result": "whole answer", "usage": {"total_tokens": 7}}))
    elif mode == "json":
        sys.stdout.write(json.dumps([
            {"type": "system"},
            {"type": "result", "subtype": "success", "result": "json answer", "duration_ms": 5},
        ], indent=2))
    elif mode == "not_logged_in":
        emit({"type": "result", "subtype": "success", "is_error": True,
              "result": "Not logged in · Please run /login"})
    elif mode == "rate_limit":
        sys.stderr.write("API Error: 429 Too Many Requests\n")
        sys.exit(1)
    elif mode == "silent_fail":
        sys.exit(3)
    elif mode == "hang":
        delta("started")
        time.sleep(60)


if __name__ == "__main__":
    main()
