#!/usr/bin/env python3
"""Render grok --output-format streaming-json as live human-readable lines.

Reads NDJSON events from stdin and writes a human-readable progress stream to
stdout (line-flushed). Optionally mirrors the raw NDJSON to a log file.

Usage:
  grok -p --output-format streaming-json "..." | stream-grok-ndjson.py [log_path]
"""

from __future__ import annotations

import json
import sys


def main() -> int:
    log_path = sys.argv[1] if len(sys.argv) > 1 else None
    log = open(log_path, "w", encoding="utf-8") if log_path else None
    in_text = False

    def end_text_run() -> None:
        nonlocal in_text
        if in_text:
            print(flush=True)
            in_text = False

    try:
        for raw in sys.stdin:
            if log is not None:
                log.write(raw)
                log.flush()

            line = raw.strip()
            if not line:
                continue

            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                end_text_run()
                print(raw, end="", flush=True)
                continue

            if not isinstance(event, dict):
                end_text_run()
                print(line, flush=True)
                continue

            kind = event.get("type")
            if kind == "text":
                print(event.get("data") or "", end="", flush=True)
                in_text = True
                continue

            end_text_run()
            if kind == "thought":
                data = (event.get("data") or "").strip()
                if data:
                    preview = " ".join(data.split())
                    if len(preview) > 200:
                        preview = preview[:197] + "..."
                    print(f"  · {preview}", flush=True)
            elif kind == "error":
                print(f"error: {event.get('message') or event}", flush=True)
            elif kind == "end":
                turns = event.get("num_turns")
                stop = event.get("stopReason")
                extra = []
                if stop:
                    extra.append(f"stop={stop}")
                if turns is not None:
                    extra.append(f"turns={turns}")
                suffix = f" ({', '.join(extra)})" if extra else ""
                print(f"[grok done]{suffix}", flush=True)
            else:
                # Non-exhaustive event types (tool activity, compact, max-turns, …).
                label = (
                    event.get("name")
                    or event.get("tool")
                    or event.get("toolName")
                    or event.get("path")
                    or event.get("message")
                    or ""
                )
                if label:
                    print(f"  [{kind}] {label}", flush=True)
                elif kind:
                    print(f"  [{kind}]", flush=True)

        end_text_run()
    finally:
        if log is not None:
            log.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
