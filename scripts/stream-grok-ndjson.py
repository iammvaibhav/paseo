#!/usr/bin/env python3
"""Render grok --output-format streaming-json as live human-readable lines.

Reads NDJSON events from stdin and writes a human-readable progress stream to
stdout (line-flushed). Optionally mirrors the raw NDJSON to a log file.

Thought/text events arrive as tiny token chunks — they are concatenated on one
line (or continuous stream), not one line per token.

Usage:
  grok -p --output-format streaming-json "..." | stream-grok-ndjson.py [log_path]
"""

from __future__ import annotations

import json
import sys


def main() -> int:
    log_path = sys.argv[1] if len(sys.argv) > 1 else None
    log = open(log_path, "w", encoding="utf-8") if log_path else None
    # "text" | "thought" | None — which stream we're currently concatenating.
    active_stream: str | None = None

    def end_stream() -> None:
        nonlocal active_stream
        if active_stream is not None:
            print(flush=True)
            active_stream = None

    def write_stream(kind: str, data: str, *, prefix: str = "") -> None:
        nonlocal active_stream
        if not data:
            return
        if active_stream != kind:
            end_stream()
            if prefix:
                print(prefix, end="", flush=True)
            active_stream = kind
        print(data, end="", flush=True)

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
                end_stream()
                print(raw, end="", flush=True)
                continue

            if not isinstance(event, dict):
                end_stream()
                print(line, flush=True)
                continue

            kind = event.get("type")
            if kind == "text":
                write_stream("text", event.get("data") or "")
                continue

            if kind == "thought":
                # Do not strip chunks — leading spaces are word separators between tokens.
                write_stream("thought", event.get("data") or "", prefix="  · ")
                continue

            end_stream()
            if kind == "error":
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

        end_stream()
    finally:
        if log is not None:
            log.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
