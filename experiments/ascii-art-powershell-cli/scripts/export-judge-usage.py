#!/usr/bin/env python3
import argparse
import hashlib
import json
import sqlite3
import tempfile
from datetime import datetime, timezone
from pathlib import Path

PROTOCOL_ID = "ascii-art-powershell-cli-v1"
SESSIONS = [
    (1, "d2663e20-96c5-46bf-b09d-ef521b994d0c"),
    (2, "2a61a1d3-62fe-4ba1-b2ac-83e1db1886cb"),
    (3, "9648435b-5b13-4dad-a703-f1f6aeccd11b"),
    (4, "312c3232-6246-43a8-bb1e-d27876a67011"),
    (5, "61f2a399-901b-4496-b426-fada12803468"),
    (6, "088841aa-27bd-4eb8-a807-f065867c5c50"),
]
QUERY = """SELECT
  id,
  session_id,
  turn_index,
  model,
  input_tokens,
  output_tokens,
  cache_read_tokens,
  cache_write_tokens,
  total_nano_aiu,
  duration_ms,
  created_at
FROM assistant_usage_events
WHERE session_id = ?
ORDER BY id"""


def sha256_file(file_path):
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def metric(value, unit, source):
    if value is None:
        return {
            "status": "unavailable",
            "value": None,
            "unit": unit,
            "source": source,
            "reason": "local_usage_field_null",
        }
    return {
        "status": "available",
        "value": value,
        "unit": unit,
        "source": source,
        "reason": None,
    }


def cached_metric(cache_read, cache_write):
    if cache_read is None and cache_write is None:
        return metric(None, "tokens", "cache_read_tokens + cache_write_tokens")
    return metric(
        (cache_read or 0) + (cache_write or 0),
        "tokens",
        "cache_read_tokens + cache_write_tokens",
    )


def aggregate(completions, name, unit):
    values = [
        completion[name]["value"]
        for completion in completions
        if completion[name]["status"] == "available"
    ]
    return {
        "status": "available" if values else "unavailable",
        "value": sum(values) if values else None,
        "unit": unit,
        "availableCompletions": len(values),
        "unavailableCompletions": len(completions) - len(values),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--database",
        type=Path,
        default=Path.home() / ".copilot" / "session-store.db",
    )
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    captured_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as temporary:
        snapshot_path = Path(temporary.name)

    source = sqlite3.connect(args.database)
    snapshot = sqlite3.connect(snapshot_path)
    try:
        source.backup(snapshot)
    finally:
        snapshot.close()
        source.close()

    snapshot_sha256 = sha256_file(snapshot_path)
    snapshot_bytes = snapshot_path.stat().st_size
    database = sqlite3.connect(f"file:{snapshot_path.as_posix()}?mode=ro", uri=True)
    database.row_factory = sqlite3.Row
    exported_sessions = []
    try:
        for judge_block, session_id in SESSIONS:
            rows = database.execute(QUERY, (session_id,)).fetchall()
            completions = []
            for row in rows:
                completions.append(
                    {
                        "completionId": row["id"],
                        "turnIndex": row["turn_index"],
                        "model": row["model"],
                        "inputTokens": metric(
                            row["input_tokens"], "tokens", "input_tokens"
                        ),
                        "outputTokens": metric(
                            row["output_tokens"], "tokens", "output_tokens"
                        ),
                        "cacheReadTokens": metric(
                            row["cache_read_tokens"], "tokens", "cache_read_tokens"
                        ),
                        "cacheWriteTokens": metric(
                            row["cache_write_tokens"], "tokens", "cache_write_tokens"
                        ),
                        "cachedTokens": cached_metric(
                            row["cache_read_tokens"], row["cache_write_tokens"]
                        ),
                        "nanoAiu": metric(
                            row["total_nano_aiu"], "nano_aiu", "total_nano_aiu"
                        ),
                        "durationMs": metric(
                            row["duration_ms"], "milliseconds", "duration_ms"
                        ),
                        "createdAt": row["created_at"],
                    }
                )
            if not completions:
                raise RuntimeError(f"No usage rows found for judge session {session_id}")
            models = sorted({completion["model"] for completion in completions})
            if models != ["gpt-5.6-sol"]:
                raise RuntimeError(
                    f"Judge session {session_id} has unexpected models: {models}"
                )
            exported_sessions.append(
                {
                    "judgeBlock": judge_block,
                    "judgeSessionId": session_id,
                    "models": models,
                    "completionCount": len(completions),
                    "totals": {
                        name: aggregate(completions, name, unit)
                        for name, unit in [
                            ("inputTokens", "tokens"),
                            ("outputTokens", "tokens"),
                            ("cacheReadTokens", "tokens"),
                            ("cacheWriteTokens", "tokens"),
                            ("cachedTokens", "tokens"),
                            ("nanoAiu", "nano_aiu"),
                            ("durationMs", "milliseconds"),
                        ]
                    },
                    "completions": completions,
                }
            )
    finally:
        database.close()
        snapshot_path.unlink(missing_ok=True)

    output = {
        "protocolId": PROTOCOL_ID,
        "generatedAt": captured_at,
        "usagePurpose": "blinded_judging",
        "excludedFromTreatmentControlEfficiency": True,
        "provenance": {
            "source": "copilot_cli_local_session_store",
            "sourceDatabase": "~/.copilot/session-store.db",
            "sourceDatabaseSnapshot": {
                "capturedAt": captured_at,
                "sha256": snapshot_sha256,
                "bytes": snapshot_bytes,
                "walIncludedBySqliteBackup": True,
                "retention": "deleted_after_export",
            },
            "query": {
                "dialect": "sqlite",
                "sql": QUERY,
                "parameterBySession": "judgeSessionId",
            },
        },
        "sessions": exported_sessions,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(f"WROTE: {args.out}")


if __name__ == "__main__":
    main()
