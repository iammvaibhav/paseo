"""Read-only visualiser for fleet-memory (memory.db + live /v1/search).

Run with the fleet-memory venv: it already has fastapi, uvicorn, numpy, sklearn.
Opens memory.db read-only; never writes.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import urllib.request
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse

DB = Path(os.environ.get("MV_DB", str(Path.home() / "fleet-memory-data/memory.db")))
FM_URL = os.environ.get("MV_FM_URL", "http://100.123.36.124:8895")
DIM = 256
MAP_SAMPLE = int(os.environ.get("MV_MAP_SAMPLE", "5000"))

app = FastAPI()
_map: dict = {"status": "pending", "points": []}


def db() -> sqlite3.Connection:
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


@app.get("/")
def index() -> HTMLResponse:
    return HTMLResponse((Path(__file__).parent / "index.html").read_text())


@app.get("/api/overview")
def overview() -> dict:
    c = db()
    kinds = {r[0]: r[1] for r in c.execute("SELECT kind, COUNT(*) FROM docs GROUP BY kind")}
    daily = [
        dict(r)
        for r in c.execute(
            "SELECT date(ts/1000,'unixepoch') AS day, kind, COUNT(*) AS n FROM docs "
            "WHERE ts IS NOT NULL GROUP BY day, kind ORDER BY day"
        )
    ]
    projects = [
        dict(r)
        for r in c.execute(
            "SELECT COALESCE(project,'(none)') AS project, COUNT(*) AS n FROM docs "
            "GROUP BY project ORDER BY n DESC LIMIT 15"
        )
    ]
    # Agents: label each by the title of its most recent turn.
    agents = [
        dict(r)
        for r in c.execute(
            "SELECT agent_id, COUNT(*) AS n, MAX(ts) AS last, "
            "(SELECT title FROM docs d2 WHERE d2.agent_id = d.agent_id ORDER BY ts DESC LIMIT 1) AS title "
            "FROM docs d WHERE agent_id IS NOT NULL GROUP BY agent_id ORDER BY n DESC LIMIT 15"
        )
    ]
    note_kinds = {}
    for (meta,) in c.execute("SELECT meta FROM docs WHERE kind='note'"):
        k = json.loads(meta or "{}").get("kind", "note")
        note_kinds[k] = note_kinds.get(k, 0) + 1
    vectors = c.execute("SELECT COUNT(*) FROM vectors").fetchone()[0]
    size = DB.stat().st_size + (DB.with_name(DB.name + "-wal").stat().st_size if DB.with_name(DB.name + "-wal").exists() else 0)
    return {"kinds": kinds, "daily": daily, "projects": projects, "agents": agents,
            "note_kinds": note_kinds, "vectors": vectors, "db_bytes": size, "db_path": str(DB)}


@app.get("/api/notes-graph")
def notes_graph(k: int = 3, min_sim: float = 0.55) -> dict:
    c = db()
    rows = c.execute(
        "SELECT d.rowid, d.id, d.title, d.project, d.meta, v.vec FROM docs d "
        "LEFT JOIN vectors v ON v.rowid = d.rowid WHERE d.kind IN ('note','doc')"
    ).fetchall()
    nodes, vecs, idx = [], [], []
    for i, r in enumerate(rows):
        meta = json.loads(r["meta"] or "{}")
        nodes.append({"id": r["id"], "title": r["title"], "project": r["project"] or "(none)",
                      "kind": meta.get("kind", "doc"), "tags": meta.get("tags", "")})
        if r["vec"]:
            vecs.append(np.frombuffer(r["vec"], dtype=np.float32))
            idx.append(i)
    edges = [{"source": s, "target": t, "type": "link"} for s, t in c.execute("SELECT src, dst FROM links")]
    ids = {n["id"] for n in nodes}
    edges = [e for e in edges if e["source"] in ids and e["target"] in ids]
    if vecs:
        m = np.stack(vecs)
        m /= np.linalg.norm(m, axis=1, keepdims=True) + 1e-9
        sim = m @ m.T
        np.fill_diagonal(sim, -1)
        seen = {(e["source"], e["target"]) for e in edges}
        for a in range(len(idx)):
            for b in np.argsort(-sim[a])[:k]:
                if sim[a, b] < min_sim:
                    break
                s, t = nodes[idx[a]]["id"], nodes[idx[b]]["id"]
                if (s, t) in seen or (t, s) in seen:
                    continue
                seen.add((s, t))
                edges.append({"source": s, "target": t, "type": "similar", "sim": round(float(sim[a, b]), 3)})
    return {"nodes": nodes, "edges": edges}


def _build_map() -> None:
    """2D t-SNE of every note/ticket plus a random sample of turns and runs."""
    try:
        from sklearn.manifold import TSNE

        c = db()
        keep = [r[0] for r in c.execute("SELECT rowid FROM docs WHERE kind IN ('note','doc','ticket')")]
        rest = [r[0] for r in c.execute(
            "SELECT d.rowid FROM docs d JOIN vectors v ON v.rowid=d.rowid "
            "WHERE kind NOT IN ('note','doc','ticket') ORDER BY random() LIMIT ?", (MAP_SAMPLE,))]
        want = keep + rest
        q = ",".join("?" * len(want))
        rows = c.execute(
            f"SELECT d.rowid, d.id, d.kind, d.title, d.project, d.ts, v.vec FROM docs d "
            f"JOIN vectors v ON v.rowid=d.rowid WHERE d.rowid IN ({q})", want).fetchall()
        m = np.stack([np.frombuffer(r["vec"], dtype=np.float32) for r in rows])
        m /= np.linalg.norm(m, axis=1, keepdims=True) + 1e-9
        _map["status"] = f"running t-SNE on {len(rows)} points"
        xy = TSNE(2, init="pca", perplexity=30, metric="cosine", random_state=0).fit_transform(m)
        _map["points"] = [
            {"id": r["id"], "kind": r["kind"], "title": r["title"][:140], "project": r["project"] or "(none)",
             "ts": r["ts"], "x": round(float(p[0]), 2), "y": round(float(p[1]), 2)}
            for r, p in zip(rows, xy)
        ]
        _map["status"] = "ready"
        _map["built"] = time.time()
    except Exception as e:  # surface in UI instead of dying silently
        _map["status"] = f"error: {e}"


@app.get("/api/map")
def emb_map() -> dict:
    return _map


@app.get("/api/doc/{doc_id:path}")
def doc(doc_id: str) -> dict:
    c = db()
    r = c.execute("SELECT id, kind, title, text, host, agent_id, project, ticket, url, ts, meta FROM docs WHERE id=?",
                  (doc_id,)).fetchone()
    if not r:
        raise HTTPException(404)
    d = dict(r)
    d["text"] = d["text"][:20000]
    d["links_out"] = [x[0] for x in c.execute("SELECT dst FROM links WHERE src=?", (doc_id,))]
    d["links_in"] = [x[0] for x in c.execute("SELECT src FROM links WHERE dst=?", (doc_id,))]
    return d


@app.get("/api/search")
def search(q: str, limit: int = 20) -> dict:
    req = urllib.request.Request(FM_URL + "/v1/search", data=json.dumps({"query": q, "limit": limit}).encode(),
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)


if __name__ == "__main__":
    threading.Thread(target=_build_map, daemon=True).start()
    uvicorn.run(app, host=os.environ.get("MV_BIND", "127.0.0.1"), port=int(os.environ.get("MV_PORT", "8896")))
