"""memviz: read-only viewer for fleet-memory, served at https://memory.thevm.space.

Reads fleet-memory's SQLite database (opened read-only, query_only) and its vault
git repo (git log only), and forwards searches to fleet-memory's own /v1/search so
results match memory_search exactly. It never writes to either. See
docs/fleet-memory.md for the architecture and how this is deployed.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, PlainTextResponse, RedirectResponse

HERE = Path(__file__).parent
DB = Path(os.environ.get("MV_DB", "~/fleet-memory-data/memory.db")).expanduser()
VAULT = Path(os.environ.get("MV_VAULT", "~/fleet-ops")).expanduser()
FM_URL = os.environ.get("MV_FM_URL", "http://100.123.36.124:8895").rstrip("/")
ARCHITECTURE = Path(os.environ.get("MV_ARCHITECTURE", str(HERE / "architecture.md")))
DIM = 256
MAP_SAMPLE = int(os.environ.get("MV_MAP_SAMPLE", "5000"))
MAP_REBUILD_S = 6 * 3600
KINDS = ("turn", "run", "ticket", "ticket_comment", "note", "doc")
NONE = "(none)"
# Who wrote an item: a note's frontmatter `source` (agent name, or the MCP client
# for bots), else the agent name the daemon attached to a turn or run record.
WRITER_SQL = "COALESCE(json_extract(meta, '$.source'), json_extract(meta, '$.agent_name'))"
LIST_COLS = f"id, kind, title, substr(text, 1, 280) AS snippet, host, agent_id, project, ticket, url, ts, {WRITER_SQL} AS writer"

app = FastAPI(title="memviz", docs_url=None, redoc_url=None, openapi_url=None)


@contextmanager
def db():
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    try:
        yield conn
    finally:
        conn.close()


def _list(value: str | None) -> list[str]:
    """Vault frontmatter keeps lists as text: "[a, b]"."""
    if not value:
        return []
    return [v.strip() for v in str(value).strip("[]").split(",") if v.strip()]


def _row(r: sqlite3.Row) -> dict:
    d = dict(r)
    if "snippet" in d and d["snippet"]:
        d["snippet"] = " ".join(d["snippet"].split())
    return d


# --- cached lookups ---------------------------------------------------------------

_cache: dict[str, tuple[float, object]] = {}


def cached(key: str, ttl: float, build):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    value = build()
    _cache[key] = (time.time(), value)
    return value


def _agents() -> dict[str, dict]:
    """agent_id -> {title, name, host, project, n, last}; title and name of its latest item."""
    def build():
        with db() as c:
            rows = c.execute(
                "SELECT agent_id, COUNT(*) AS n, MAX(ts) AS last, title, host, project, "
                "json_extract(meta, '$.agent_name') AS name FROM docs "
                "WHERE agent_id IS NOT NULL AND kind IN ('turn', 'run') GROUP BY agent_id"
            ).fetchall()
        return {r["agent_id"]: {k: r[k] for k in ("title", "name", "host", "project", "n", "last")} for r in rows}
    return cached("agents", 300, build)


def _agents_by_name() -> dict[str, list[str]]:
    def build():
        out: dict[str, list[str]] = {}
        for aid, a in _agents().items():
            if a["name"]:
                out.setdefault(a["name"], []).append(aid)
        return out
    return cached("agents_by_name", 300, build)


# --- pages --------------------------------------------------------------------------


@app.get("/")
def index() -> FileResponse:
    return FileResponse(HERE / "index.html", headers={"cache-control": "no-cache"})


@app.get("/architecture")
def architecture_page() -> RedirectResponse:
    return RedirectResponse("/#architecture")


@app.get("/api/architecture", response_class=PlainTextResponse)
def architecture() -> str:
    return ARCHITECTURE.read_text(encoding="utf-8")


# --- overview -----------------------------------------------------------------------


@app.get("/api/status")
def status() -> dict:
    """fleet-memory's own status (GET, read-only) plus the database files' size."""
    size = sum(p.stat().st_size for p in (DB, DB.with_name(DB.name + "-wal")) if p.exists())
    try:
        with urllib.request.urlopen(FM_URL + "/v1/status", timeout=5) as resp:
            service = json.load(resp)
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        service = {"error": str(error)}
    return {"service": service, "db_path": str(DB), "db_bytes": size, "fm_url": FM_URL}


@app.get("/api/overview")
def overview() -> dict:
    with db() as c:
        kinds = {r[0]: r[1] for r in c.execute("SELECT kind, COUNT(*) FROM docs GROUP BY kind")}
        daily = [dict(r) for r in c.execute(
            "SELECT date(ts / 1000, 'unixepoch') AS day, kind, COUNT(*) AS n FROM docs "
            "WHERE ts IS NOT NULL GROUP BY day, kind ORDER BY day"
        )]
        hosts = [dict(r) for r in c.execute(
            f"SELECT COALESCE(host, '{NONE}') AS host, kind, COUNT(*) AS n FROM docs GROUP BY host, kind"
        )]
        projects = [dict(r) for r in c.execute(
            f"SELECT COALESCE(project, '{NONE}') AS project, COUNT(*) AS n FROM docs "
            "GROUP BY project ORDER BY n DESC LIMIT 15"
        )]
        note_kinds = [dict(r) for r in c.execute(
            "SELECT COALESCE(json_extract(meta, '$.kind'), 'note') AS kind, COUNT(*) AS n FROM docs "
            "WHERE kind = 'note' GROUP BY 1 ORDER BY n DESC"
        )]
        writers = [dict(r) for r in c.execute(
            f"SELECT COALESCE(json_extract(meta, '$.source'), 'unknown') AS writer, COUNT(*) AS n "
            "FROM docs WHERE kind = 'note' GROUP BY 1 ORDER BY n DESC LIMIT 20"
        )]
        recent_notes = [_row(r) for r in c.execute(
            f"SELECT {LIST_COLS}, json_extract(meta, '$.kind') AS note_kind, json_extract(meta, '$.created') AS created "
            "FROM docs WHERE kind IN ('note', 'doc') ORDER BY ts DESC LIMIT 12"
        )]
        counts = c.execute(
            "SELECT (SELECT COUNT(*) FROM vectors) AS vectors, (SELECT COUNT(*) FROM links) AS links, "
            "(SELECT COUNT(DISTINCT agent_id) FROM docs) AS n_agents, "
            "(SELECT COUNT(DISTINCT project) FROM docs) AS n_projects, "
            "(SELECT MIN(ts) FROM docs) AS first_ts, (SELECT MAX(ts) FROM docs) AS last_ts"
        ).fetchone()
    agents = sorted(_agents().items(), key=lambda kv: -kv[1]["n"])[:15]
    return {
        "kinds": kinds, "daily": daily, "hosts": hosts, "projects": projects,
        "note_kinds": note_kinds, "writers": writers, "recent_notes": recent_notes,
        "agents": [{"agent_id": aid, **a} for aid, a in agents], **dict(counts),
    }


@app.get("/api/facets")
def facets() -> dict:
    """Values for the filter controls."""
    def build():
        with db() as c:
            hosts = [dict(r) for r in c.execute(
                f"SELECT COALESCE(host, '{NONE}') AS value, COUNT(*) AS n FROM docs GROUP BY 1 ORDER BY n DESC"
            )]
            projects = [dict(r) for r in c.execute(
                f"SELECT COALESCE(project, '{NONE}') AS value, COUNT(*) AS n FROM docs GROUP BY 1 ORDER BY n DESC"
            )]
            writers = [dict(r) for r in c.execute(
                f"SELECT {WRITER_SQL} AS value, COUNT(*) AS n FROM docs WHERE {WRITER_SQL} IS NOT NULL "
                "GROUP BY 1 ORDER BY n DESC"
            )]
        agents = sorted(
            ({"value": aid, **a} for aid, a in _agents().items()), key=lambda a: -(a["last"] or 0)
        )
        return {"kinds": list(KINDS), "hosts": hosts, "projects": projects, "writers": writers, "agents": agents}
    return cached("facets", 120, build)


# --- browse and search --------------------------------------------------------------


def _where(kinds, host, project, agent, ticket, writer, since, until) -> tuple[str, list]:
    clauses, args = [], []
    if kinds:
        clauses.append(f"kind IN ({','.join('?' * len(kinds))})")
        args += kinds
    for col, value in (("host", host), ("project", project)):
        if value == NONE:
            clauses.append(f"{col} IS NULL")
        elif value:
            clauses.append(f"{col} = ?")
            args.append(value)
    for col, value in (("agent_id", agent), ("ticket", ticket)):
        if value:
            clauses.append(f"{col} = ?")
            args.append(value)
    if writer:
        clauses.append(f"{WRITER_SQL} = ?")
        args.append(writer)
    if since:
        clauses.append("ts >= ?")
        args.append(since)
    if until:
        clauses.append("ts < ?")
        args.append(until)
    return ("WHERE " + " AND ".join(clauses)) if clauses else "", args


@app.get("/api/items")
def items(
    kind: list[str] = Query(default=[]), host: str | None = None, project: str | None = None,
    agent: str | None = None, ticket: str | None = None, writer: str | None = None,
    since: int | None = None, until: int | None = None, offset: int = 0, limit: int = 50,
) -> dict:
    """Browse: every item matching the filters, newest first."""
    where, args = _where(kind, host, project, agent, ticket, writer, since, until)
    limit = max(1, min(limit, 200))
    with db() as c:
        total = c.execute(f"SELECT COUNT(*) FROM docs {where}", args).fetchone()[0]
        rows = c.execute(
            f"SELECT {LIST_COLS} FROM docs {where} ORDER BY ts IS NULL, ts DESC LIMIT ? OFFSET ?",
            [*args, limit, max(0, offset)],
        ).fetchall()
    return {"total": total, "items": [_row(r) for r in rows]}


@app.get("/api/search")
def search(
    q: str, kind: list[str] = Query(default=[]), host: str | None = None, project: str | None = None,
    agent: str | None = None, ticket: str | None = None, since: int | None = None,
    until: int | None = None, limit: int = 8, by_agent: bool = False,
) -> dict:
    """fleet-memory's /v1/search with the body memory_search sends, so the ranking is
    identical. `until` has no server-side filter; it is applied to the returned hits."""
    body: dict = {"query": q, "limit": max(1, min(limit, 50)), "group_by_agent": by_agent}
    if kind:
        body["kinds"] = kind
    for key, value in (("host", host), ("project", project), ("agent", agent), ("ticket", ticket), ("since", since)):
        if value:
            body[key] = value
    req = urllib.request.Request(
        FM_URL + "/v1/search", data=json.dumps(body).encode(), headers={"content-type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            found = json.load(resp)
    except urllib.error.URLError as error:
        raise HTTPException(502, f"fleet-memory search failed: {error}") from error
    hits = [h for h in found.get("hits", []) if not until or (h.get("ts") or 0) < until]
    if hits:
        with db() as c:
            ids = [h["id"] for h in hits]
            writers = dict(c.execute(
                f"SELECT id, {WRITER_SQL} FROM docs WHERE id IN ({','.join('?' * len(ids))})", ids
            ).fetchall())
        for h in hits:
            h["writer"] = writers.get(h["id"])
    found["hits"] = hits
    found["request"] = body
    return found


# --- item detail --------------------------------------------------------------------


def _titles(c: sqlite3.Connection, ids: list[str]) -> dict[str, dict]:
    if not ids:
        return {}
    rows = c.execute(
        f"SELECT id, kind, title, ts FROM docs WHERE id IN ({','.join('?' * len(ids))})", ids
    ).fetchall()
    return {r["id"]: dict(r) for r in rows}


def _vault_history(rel: str) -> list[dict]:
    """The note's commits in the vault repo (read-only git log)."""
    try:
        out = subprocess.run(
            ["git", "-C", str(VAULT), "log", "--follow", "--format=%h%x1f%aI%x1f%s", "--", rel],
            check=True, capture_output=True, text=True, timeout=10,
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return []
    history = []
    for line in out.splitlines():
        sha, when, subject = line.split("\x1f", 2)
        m = re.search(r"\(by (.+)\)$", subject)
        history.append({"sha": sha, "ts": when, "subject": subject, "by": m.group(1) if m else None})
    return history


@app.get("/api/doc/{doc_id:path}")
def doc(doc_id: str) -> dict:
    with db() as c:
        r = c.execute(
            f"SELECT rowid, id, kind, title, text, host, agent_id, project, ticket, url, ts, meta, updated_at, "
            f"{WRITER_SQL} AS writer, (SELECT 1 FROM vectors v WHERE v.rowid = docs.rowid) AS embedded "
            "FROM docs WHERE id = ?", (doc_id,)
        ).fetchone()
        if not r:
            raise HTTPException(404, f"no item {doc_id}")
        d = dict(r)
        d.pop("rowid")
        d["meta"] = json.loads(d["meta"] or "{}")
        out_ids = [x[0] for x in c.execute("SELECT dst FROM links WHERE src = ? ORDER BY dst", (doc_id,))]
        in_ids = [x[0] for x in c.execute("SELECT src FROM links WHERE dst = ? ORDER BY src", (doc_id,))]
        titles = _titles(c, out_ids + in_ids)
        d["links_out"] = [titles.get(i) or {"id": i, "missing": True} for i in out_ids]
        d["links_in"] = [titles.get(i) or {"id": i, "missing": True} for i in in_ids]
        related = {}
        if d["agent_id"]:
            related["agent"] = {
                "total": c.execute("SELECT COUNT(*) FROM docs WHERE agent_id = ?", (d["agent_id"],)).fetchone()[0],
                "items": [_row(x) for x in c.execute(
                    f"SELECT {LIST_COLS} FROM docs WHERE agent_id = ? AND id != ? ORDER BY ts DESC LIMIT 15",
                    (d["agent_id"], doc_id),
                )],
            }
        if d["ticket"]:
            related["ticket"] = {
                "total": c.execute("SELECT COUNT(*) FROM docs WHERE ticket = ?", (d["ticket"],)).fetchone()[0],
                "items": [_row(x) for x in c.execute(
                    f"SELECT {LIST_COLS} FROM docs WHERE ticket = ? AND id != ? ORDER BY ts LIMIT 40",
                    (d["ticket"], doc_id),
                )],
            }
        if d["kind"] in ("note", "doc") and d["writer"]:
            related["writer"] = {
                "total": c.execute(f"SELECT COUNT(*) FROM docs WHERE kind = 'note' AND {WRITER_SQL} = ?",
                                   (d["writer"],)).fetchone()[0],
                "items": [_row(x) for x in c.execute(
                    f"SELECT {LIST_COLS} FROM docs WHERE kind = 'note' AND {WRITER_SQL} = ? AND id != ? "
                    "ORDER BY ts DESC LIMIT 15", (d["writer"], doc_id),
                )],
            }
    d["related"] = related
    agents = _agents()
    if d["agent_id"]:
        d["agent"] = {"agent_id": d["agent_id"], **agents.get(d["agent_id"], {})}
    # A note's writer is an agent name (or a bot's MCP client name): the agents that
    # carry that name, so "written by" links to their work.
    d["writer_agents"] = [
        {"agent_id": aid, **agents[aid]} for aid in _agents_by_name().get(d["writer"] or "", [])
    ][:10]
    if d["kind"] in ("note", "doc"):
        meta = d["meta"]
        d["note"] = {
            "path": meta.get("path"), "kind": meta.get("kind"), "tags": _list(meta.get("tags")),
            "about_agents": _list(meta.get("agents")), "tickets": _list(meta.get("tickets")),
            "refs": _list(meta.get("refs")), "created": meta.get("created"),
            "updates": [
                {"ts": m.group(1), "by": m.group(2)}
                for m in re.finditer(r"^## Update (\S+) \((.+)\)$", d["text"], re.M)
            ],
            "history": _vault_history(meta["path"]) if meta.get("path") else [],
        }
    return d


# --- notes graph --------------------------------------------------------------------


@app.get("/api/notes-graph")
def notes_graph(k: int = 2, min_sim: float = 0.72, mutual: bool = True) -> dict:
    """Vault notes with their [[links]], plus similarity edges between notes that are
    each other's nearest neighbours (mutual k-NN above min_sim). Mutual k-NN keeps a
    hub note from collecting an edge from every note that is vaguely about it."""
    with db() as c:
        rows = c.execute(
            f"SELECT d.id, d.title, d.project, d.ts, d.meta, {WRITER_SQL} AS writer, v.vec "
            "FROM docs d LEFT JOIN vectors v ON v.rowid = d.rowid WHERE d.kind IN ('note', 'doc')"
        ).fetchall()
        links = c.execute("SELECT src, dst FROM links").fetchall()
    nodes, vecs, idx = [], [], []
    for i, r in enumerate(rows):
        meta = json.loads(r["meta"] or "{}")
        nodes.append({
            "id": r["id"], "title": r["title"], "project": r["project"] or NONE,
            "kind": meta.get("kind") or "doc", "writer": r["writer"] or "unknown", "ts": r["ts"],
            "tags": _list(meta.get("tags")),
        })
        if r["vec"]:
            vecs.append(np.frombuffer(r["vec"], dtype=np.float32))
            idx.append(i)
    ids = {n["id"] for n in nodes}
    edges = [{"source": s, "target": t, "type": "link"} for s, t in links if s in ids and t in ids]
    seen = {frozenset((e["source"], e["target"])) for e in edges}
    if vecs:
        m = np.stack(vecs)
        m /= np.linalg.norm(m, axis=1, keepdims=True) + 1e-9
        sim = m @ m.T
        np.fill_diagonal(sim, -1)
        k = max(1, min(k, 10))
        top = np.argsort(-sim, axis=1)[:, :k]
        neighbours = [set(row.tolist()) for row in top]
        for a in range(len(idx)):
            for b in top[a]:
                b = int(b)
                if sim[a, b] < min_sim or (mutual and a not in neighbours[b]):
                    continue
                s, t = nodes[idx[a]]["id"], nodes[idx[b]]["id"]
                if frozenset((s, t)) in seen:
                    continue
                seen.add(frozenset((s, t)))
                edges.append({"source": s, "target": t, "type": "similar", "sim": round(float(sim[a, b]), 3)})
    return {"nodes": nodes, "edges": edges}


# --- meaning map --------------------------------------------------------------------

_map: dict = {"status": "pending", "points": []}


def _build_map() -> None:
    """2D t-SNE of every note, doc and ticket plus a random sample of the rest."""
    from sklearn.manifold import TSNE

    with db() as c:
        keep = [r[0] for r in c.execute(
            "SELECT d.rowid FROM docs d JOIN vectors v ON v.rowid = d.rowid WHERE kind IN ('note', 'doc', 'ticket')"
        )]
        rest = [r[0] for r in c.execute(
            "SELECT d.rowid FROM docs d JOIN vectors v ON v.rowid = d.rowid "
            "WHERE kind NOT IN ('note', 'doc', 'ticket') ORDER BY random() LIMIT ?", (MAP_SAMPLE,)
        )]
        want = keep + rest
        rows = c.execute(
            f"SELECT d.id, d.kind, d.title, d.project, d.host, d.ts, v.vec FROM docs d "
            f"JOIN vectors v ON v.rowid = d.rowid WHERE d.rowid IN ({','.join('?' * len(want))})", want
        ).fetchall()
    m = np.stack([np.frombuffer(r["vec"], dtype=np.float32) for r in rows])
    m /= np.linalg.norm(m, axis=1, keepdims=True) + 1e-9
    _map["status"] = f"running t-SNE on {len(rows)} points"
    xy = TSNE(2, init="pca", perplexity=30, metric="cosine", random_state=0).fit_transform(m)
    _map.update(
        points=[
            {"id": r["id"], "kind": r["kind"], "title": (r["title"] or "")[:140], "project": r["project"] or NONE,
             "host": r["host"] or NONE, "ts": r["ts"], "x": round(float(p[0]), 2), "y": round(float(p[1]), 2)}
            for r, p in zip(rows, xy)
        ],
        status="ready", built=int(time.time() * 1000),
    )


def _map_loop() -> None:
    while True:
        try:
            _build_map()
        except Exception as error:  # noqa: BLE001 - shown in the UI; the next round retries
            _map["status"] = f"error: {error}"
        time.sleep(MAP_REBUILD_S)


@app.get("/api/map")
def emb_map() -> dict:
    return _map


@app.on_event("startup")
def start_map() -> None:
    threading.Thread(target=_map_loop, name="map", daemon=True).start()


def main() -> None:
    uvicorn.run(app, host=os.environ.get("MV_BIND", "127.0.0.1"), port=int(os.environ.get("MV_PORT", "8896")))


if __name__ == "__main__":
    main()
