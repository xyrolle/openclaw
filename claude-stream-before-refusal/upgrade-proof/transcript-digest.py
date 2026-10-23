# Digest of the stored transcript rows per session, read from a copy of the agent database.
#   python3 -I transcript-digest.py <agent.sqlite> <baseline.json> record|compare
# record: hash every row and save the row count; compare: hash the same rows again.
import hashlib
import json
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

db, baseline, mode = sys.argv[1:4]
with tempfile.TemporaryDirectory() as tmp:
    for suffix in ("", "-wal", "-shm"):
        source = Path(db + suffix)
        if source.exists():
            shutil.copy(source, Path(tmp) / f"agent.sqlite{suffix}")
    connection = sqlite3.connect(Path(tmp) / "agent.sqlite")
    sessions = connection.execute(
        "select session_id, count(*) from transcript_events group by session_id order by session_id"
    ).fetchall()
    saved = json.loads(Path(baseline).read_text()) if mode == "compare" else {}
    report = {}
    for session_id, count in sessions:
        limit = saved.get(session_id, {}).get("rows", count) if mode == "compare" else count
        if mode == "compare" and session_id not in saved:
            continue
        rows = connection.execute(
            "select seq, event_json from transcript_events where session_id = ? and seq < ? order by seq",
            (session_id, limit),
        ).fetchall()
        digest = hashlib.sha256(json.dumps(rows).encode()).hexdigest()[:16]
        report[session_id] = {"rows": len(rows), "sha256": digest, "total": count}
    connection.close()
if mode == "record":
    Path(baseline).write_text(json.dumps(report))
for session_id, entry in report.items():
    verdict = ""
    if mode == "compare":
        verdict = "identical" if entry["sha256"] == saved[session_id]["sha256"] else "CHANGED"
        verdict = f"{verdict} ({entry['total']} rows now)"
    print(f"session {session_id[:8]}: first {entry['rows']} rows sha256 {entry['sha256']} {verdict}".rstrip())
