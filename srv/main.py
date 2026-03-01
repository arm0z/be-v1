"""
Browser extension packet viewer — receives Packet payloads from packer.ts.

Usage:
    uv run main.py

Env vars:
    PORT  — Port to listen on (default: 5000)
"""

import json
import os
import sqlite3
import uuid
from datetime import datetime

from flask import Flask, g, jsonify, redirect, request

app = Flask(__name__)


@app.after_request
def cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


DB_PATH = os.path.join(os.path.dirname(__file__), "data.db")

TW_HEAD = """<script src="https://cdn.tailwindcss.com"></script>
<script>
tailwind.config = {
  theme: {
    extend: {
      colors: {
        hg: {
          bg: '#0d1117',
          alt: '#161b22',
          text: '#c9d1d9',
          muted: '#8b949e',
          blue: '#58a6ff',
          border: '#21262d',
          red: '#da3633',
          dim: '#484f58',
          subtle: '#adbac7',
          green: '#3fb950',
          purple: '#bc8cff',
        }
      }
    }
  }
}
</script>"""


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.execute("PRAGMA journal_mode=WAL")
    return g.db


@app.teardown_appcontext
def close_db(_: BaseException | None) -> None:
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db() -> None:
    db = sqlite3.connect(DB_PATH)
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS packets (
            id TEXT PRIMARY KEY,
            packet_id TEXT NOT NULL,
            received_at TEXT NOT NULL,
            payload TEXT NOT NULL
        )
    """
    )
    db.execute("CREATE INDEX IF NOT EXISTS idx_packet_id ON packets(packet_id)")
    db.commit()
    db.close()


# ── Formatting helpers ──────────────────────────────────────────────


def fmt_ts(ms):
    if not isinstance(ms, (int, float)):
        return str(ms)
    return (
        datetime.fromtimestamp(ms / 1000).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
    )


def fmt_ts_short(ms):
    if not isinstance(ms, (int, float)):
        return str(ms)
    return datetime.fromtimestamp(ms / 1000).astimezone().strftime("%H:%M:%S")


def fmt_duration(ms):
    if not isinstance(ms, (int, float)):
        return str(ms)
    s = int(ms / 1000)
    if s < 60:
        return f"{s}s"
    m, s = divmod(s, 60)
    if m < 60:
        return f"{m}m {s}s"
    h, m = divmod(m, 60)
    return f"{h}h {m}m {s}s"


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4) if text else 0


def escape_html(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def group_id_kind(gid: str) -> tuple[str, str]:
    """Classify a group ID into (kind_label, css_color_class)."""
    if gid.startswith("singleton:"):
        return "singleton", "text-hg-red"
    if gid.startswith("hub:"):
        return "hub-chunk", "text-hg-purple"
    return "community", "text-hg-green"


def capture_type_counts(captures: list) -> dict[str, int]:
    """Count captures by type prefix (e.g. input, nav, html)."""
    counts: dict[str, int] = {}
    for c in captures:
        t = c.get("type", "unknown")
        counts[t] = counts.get(t, 0) + 1
    return counts


# ── Routes ──────────────────────────────────────────────────────────


@app.route("/api/v1/extension/sync", methods=["POST"])
def record() -> tuple:
    """Receive a Packet from packer.ts."""
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "invalid JSON"}), 400

    row_id = str(uuid.uuid4())
    packet_id = data.get("id", row_id)
    received_at = datetime.now().astimezone().isoformat()

    db = get_db()
    db.execute(
        "INSERT INTO packets (id, packet_id, received_at, payload) VALUES (?, ?, ?, ?)",
        (row_id, packet_id, received_at, json.dumps(data)),
    )
    db.commit()

    groups = data.get("groups", [])
    edges = data.get("edges", [])
    print(
        f"[record] packet {packet_id[:8]} — {len(groups)} group(s), {len(edges)} edge(s) — stored as {row_id}"
    )

    return jsonify({"status": "ok", "id": row_id}), 200


@app.route("/clear", methods=["POST"])
def clear_all() -> tuple:
    db = get_db()
    db.execute("DELETE FROM packets")
    db.commit()
    return redirect("/")  # type: ignore


@app.route("/")
def index() -> tuple:
    db = get_db()
    db.row_factory = sqlite3.Row
    rows = db.execute(
        "SELECT id, packet_id, received_at, payload FROM packets ORDER BY received_at DESC"
    ).fetchall()

    table_rows = ""
    for r in rows:
        payload = json.loads(r["payload"])
        groups = payload.get("groups", [])
        edges = payload.get("edges", [])

        bundle_count = sum(len(gr.get("bundles", [])) for gr in groups)

        starts = [
            gr.get("meta", {}).get("timeRange", {}).get("start", 0) for gr in groups
        ]
        ends = [gr.get("meta", {}).get("timeRange", {}).get("end", 0) for gr in groups]
        span_start = fmt_ts_short(min(starts)) if starts else ""
        span_end = fmt_ts_short(max(ends)) if ends else ""

        created_at = payload.get("createdAt", "")
        created_time = fmt_ts_short(created_at) if created_at else ""

        received_full = r["received_at"]
        try:
            received_time = datetime.fromisoformat(received_full).strftime("%H:%M:%S")
        except (ValueError, TypeError):
            received_time = received_full

        # Classify group IDs
        singletons = sum(
            1 for gr in groups if gr.get("id", "").startswith("singleton:")
        )
        communities = sum(
            1
            for gr in groups
            if not gr.get("id", "").startswith("singleton:")
            and not gr.get("id", "").startswith("hub:")
        )
        hubs = sum(1 for gr in groups if gr.get("id", "").startswith("hub:"))

        group_breakdown = []
        if communities:
            group_breakdown.append(f'<span class="text-hg-green">{communities}c</span>')
        if singletons:
            group_breakdown.append(f'<span class="text-hg-red">{singletons}s</span>')
        if hubs:
            group_breakdown.append(f'<span class="text-hg-purple">{hubs}h</span>')
        group_cell = " ".join(group_breakdown) if group_breakdown else str(len(groups))

        table_rows += f"""<tr class="hover:bg-hg-alt">
            <td class="hidden sm:table-cell" title="{received_full}">{received_time}</td>
            <td><a href="/{r["id"]}">{r["packet_id"][:8]}&hellip;</a></td>
            <td>{group_cell}</td>
            <td>{bundle_count}</td>
            <td>{len(edges)}</td>
            <td class="hidden md:table-cell">{created_time}</td>
            <td>{span_start} &ndash; {span_end}</td>
        </tr>"""

    html = f"""<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
{TW_HEAD}
<title>Packets :: Sink</title>
<style type="text/tailwindcss">
@layer base {{
  a {{ @apply text-hg-blue hover:underline; }}
  th {{ @apply text-left px-2 py-1.5 md:px-3 md:py-2 text-hg-muted font-normal border-b border-hg-border text-[11px] uppercase tracking-wider; }}
  td {{ @apply px-2 py-1.5 md:px-3 md:py-2 border-b border-hg-alt; }}
}}
</style>
</head><body class="font-mono text-[13px] bg-hg-bg text-hg-text p-2 sm:p-3 md:p-6">
<div class="flex items-center justify-between mb-4">
<h1 class="text-xs sm:text-sm text-hg-muted font-normal">
  <span class="text-hg-blue">sink</span> / packets &mdash; {len(rows)} record(s)
  {' <form method="POST" action="/clear" class="inline" onsubmit="return confirm(\'Delete all records?\')"><button class="ml-3 px-2.5 py-0.5 text-[11px] font-mono border border-hg-red rounded text-hg-red bg-transparent cursor-pointer hover:bg-hg-red hover:text-hg-bg">Clear all</button></form>' if rows else ""}
</h1>
<button onclick="location.reload()" class="px-2.5 py-0.5 text-[11px] font-mono border border-hg-border rounded text-hg-muted bg-transparent cursor-pointer hover:text-hg-text hover:border-hg-blue">Reload</button>
</div>
<table class="w-full border-collapse">
<tr>
  <th class="hidden sm:table-cell">Received</th><th>Packet</th><th>Groups</th><th>Bundles</th><th>Edges</th><th class="hidden md:table-cell">Created</th><th>Span</th>
</tr>
{table_rows if table_rows else '<tr><td colspan="7" class="text-hg-dim p-10 text-center">No packets yet.</td></tr>'}
</table>
</body></html>"""
    return html, 200


@app.route("/<row_id>")
def packet_detail(row_id: str) -> tuple:
    db = get_db()
    row = db.execute(
        "SELECT id, packet_id, received_at, payload FROM packets WHERE id = ?",
        (row_id,),
    ).fetchone()
    if not row:
        return "<h1>404</h1>", 404

    payload = json.loads(row[3])
    row_id = row[0]
    packet_id = row[1]
    received_at = row[2]

    groups = payload.get("groups", [])
    edges = payload.get("edges", [])
    created_at = payload.get("createdAt", "")

    bundle_count = sum(len(gr.get("bundles", [])) for gr in groups)
    all_sources = sorted(
        {s for gr in groups for s in gr.get("meta", {}).get("sources", [])}
    )
    all_tabs = sorted({t for gr in groups for t in gr.get("meta", {}).get("tabs", [])})

    # ── Packet header ───────────────────────────────────────────────
    meta_rows = f"""
        <tr><td>Row ID</td><td class="text-hg-muted break-all">{row_id}</td></tr>
        <tr><td>Packet ID</td><td class="text-hg-muted break-all">{packet_id}</td></tr>
        <tr><td>Received</td><td>{received_at}</td></tr>
        <tr><td>Created At</td><td>{fmt_ts(created_at)}</td></tr>
        <tr><td>Groups</td><td>{len(groups)}</td></tr>
        <tr><td>Bundles</td><td>{bundle_count}</td></tr>
        <tr><td>Edges</td><td>{len(edges)}</td></tr>
        <tr><td>Sources</td><td class="break-all">{", ".join(all_sources)}</td></tr>
        <tr><td>Tabs</td><td class="break-all">{", ".join(all_tabs)}</td></tr>
    """

    # ── Edge table ──────────────────────────────────────────────────
    edge_section = ""
    if edges:
        edge_rows = ""
        for e in sorted(edges, key=lambda e: e.get("weight", 0), reverse=True):
            edge_rows += (
                f'<tr><td class="text-hg-subtle">{escape_html(e.get("from", ""))}</td>'
                f'<td class="text-hg-muted">&rarr;</td>'
                f'<td class="text-hg-subtle">{escape_html(e.get("to", ""))}</td>'
                f'<td class="text-hg-blue">{e.get("weight", 0)}</td></tr>'
            )
        edge_section = f"""
        <details class="mb-6 border border-hg-border rounded-md overflow-hidden">
            <summary class="px-4 py-2 cursor-pointer text-[11px] uppercase tracking-wider text-hg-muted hover:text-hg-text bg-hg-alt">
                Edges <span class="text-hg-blue ml-2">{len(edges)}</span>
            </summary>
            <table class="w-full border-collapse">
                <tr><th>From</th><th></th><th>To</th><th>Weight</th></tr>
                {edge_rows}
            </table>
        </details>"""

    # ── Group cards ─────────────────────────────────────────────────
    group_cards = ""
    for gi, group in enumerate(groups):
        meta = group.get("meta", {})
        sources = meta.get("sources", [])
        tabs = meta.get("tabs", [])
        time_range = meta.get("timeRange", {})
        t_start = time_range.get("start", 0)
        t_end = time_range.get("end", 0)
        duration_ms = (
            t_end - t_start
            if isinstance(t_start, (int, float)) and isinstance(t_end, (int, float))
            else 0
        )

        bundles = group.get("bundles", [])
        group_text = group.get("text", "")
        group_id = group.get("id", "")
        gid_kind, gid_color = group_id_kind(group_id)

        # Bundle list
        bundle_items = ""
        for bi, b in enumerate(bundles):
            b_source = b.get("source", "")
            b_started = fmt_ts_short(b.get("startedAt", 0))
            b_ended = fmt_ts_short(b.get("endedAt", 0)) if b.get("endedAt") else "open"
            b_text = b.get("text", "") or ""
            b_captures_list = b.get("captures", [])
            b_captures = len(b_captures_list)
            b_tokens = estimate_tokens(b_text)
            b_dwell_ms = (
                (b.get("endedAt", 0) or 0) - b.get("startedAt", 0)
                if b.get("startedAt")
                else 0
            )

            type_counts = capture_type_counts(b_captures_list)
            type_tags = " ".join(
                f'<span class="text-hg-dim">{t}:{n}</span>'
                for t, n in sorted(type_counts.items())
            )

            bundle_body = ""
            if b_text.strip():
                bundle_body = f'<pre class="whitespace-pre-wrap break-words text-xs text-hg-subtle max-h-[300px] overflow-y-auto px-4 py-2">{escape_html(b_text)}</pre>'

            type_strip = (
                f'<div class="px-4 py-1.5 text-[11px] flex flex-wrap gap-2 border-b border-hg-alt">{type_tags}</div>'
                if type_tags
                else ""
            )

            bundle_items += (
                f'<details class="border border-hg-border rounded mb-2">'
                f'<summary class="px-3 py-1.5 cursor-pointer text-xs text-hg-muted hover:text-hg-text bg-hg-alt">'
                f'<span class="text-hg-subtle">#{bi}</span> '
                f'<span class="text-hg-purple">{escape_html(b_source)}</span> '
                f"{b_started} &ndash; {b_ended} "
                f'<span class="text-hg-dim">({fmt_duration(b_dwell_ms)})</span> '
                f'<span class="text-hg-dim">{b_captures} captures</span> '
                f'<span class="text-hg-blue">~{b_tokens} tokens</span>'
                f"</summary>"
                f"{type_strip}"
                f"{bundle_body}"
                f"</details>"
            )

        bundles_section = ""
        if bundles:
            bundles_section = (
                f'<details class="border-t border-hg-border">'
                f'<summary class="px-4 py-2 cursor-pointer text-[11px] uppercase tracking-wider text-hg-muted hover:text-hg-text">'
                f'Bundles <span class="text-hg-blue ml-2">{len(bundles)}</span></summary>'
                f'<div class="px-4 py-2">{bundle_items}</div>'
                f"</details>"
            )

        # Group text (merged from bundles)
        text_section = ""
        if group_text.strip():
            tokens = estimate_tokens(group_text)
            text_section = (
                '<div class="flex flex-wrap items-center gap-2 px-4 pt-2 pb-1 text-hg-muted text-[11px] uppercase tracking-wider border-t border-hg-border">'
                f'Text <span class="text-hg-blue ml-2">~{tokens} tokens</span>'
                ' <button class="copy-btn ml-auto" onclick="copyText(this)">Copy</button></div>'
                f'<pre class="group-text whitespace-pre-wrap break-words text-xs text-hg-subtle max-h-[400px] overflow-y-auto px-4 py-2">{escape_html(group_text)}</pre>'
            )

        group_cards += f"""
        <div class="group border border-hg-border rounded-md mb-5 overflow-hidden" id="group-{gi}">
            <div class="bg-hg-alt px-4 py-2.5 flex flex-wrap gap-4 items-center">
                <span class="font-bold text-hg-green">Group {gi}</span>
                <span class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-hg-border {gid_color}">{gid_kind}</span>
                <span class="text-hg-muted text-xs break-all" title="{escape_html(group_id)}">{escape_html(group_id[:32])}</span>
                <span class="text-hg-muted text-xs">{len(bundles)} bundle(s) &middot; {len(tabs)} tab(s)</span>
                <span class="text-hg-muted text-xs ml-auto">{fmt_duration(duration_ms)} &middot; {fmt_ts_short(t_start)} &ndash; {fmt_ts_short(t_end)}</span>
            </div>
            <table class="gmeta w-full border-collapse">
                <tr><td>Sources</td><td class="break-all">{", ".join(escape_html(s) for s in sources)}</td></tr>
                <tr><td>Tabs</td><td class="break-all">{", ".join(escape_html(t) for t in tabs)}</td></tr>
                <tr><td>Span</td><td>{fmt_ts(t_start)} &ndash; {fmt_ts(t_end)}</td></tr>
                <tr><td>Duration</td><td>{fmt_duration(duration_ms)}</td></tr>
            </table>
            {text_section}
            {bundles_section}
        </div>
        """

    html = f"""<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
{TW_HEAD}
<title>{packet_id[:8]} :: Packet</title>
<style type="text/tailwindcss">
@layer base {{
  a {{ @apply text-hg-blue hover:underline; }}
}}
@layer components {{
  .copy-btn {{ @apply inline-block ml-2 px-2.5 py-0.5 text-[11px] border border-hg-border rounded text-hg-muted bg-transparent cursor-pointer font-mono hover:text-hg-text hover:border-hg-blue; }}
  .meta tr {{ @apply block sm:table-row border-b border-hg-alt sm:border-0 py-1 sm:py-0; }}
  .meta td {{ @apply block sm:table-cell py-0 sm:py-1 align-top; }}
  .meta td:first-child {{ @apply text-hg-muted whitespace-nowrap sm:pr-4; }}
  .gmeta td {{ @apply px-4 py-1 border-t border-hg-alt break-words; }}
  .gmeta td:first-child {{ @apply text-hg-muted whitespace-nowrap; }}
}}
</style>
</head><body class="font-mono text-[13px] bg-hg-bg text-hg-text p-2 sm:p-3 md:p-6 max-w-[1100px]">
<div class="text-sm text-hg-muted mb-5"><a href="/">packets</a> / <span class="text-hg-blue">{packet_id}</span> <a href="/{row_id}/json" class="copy-btn hover:no-underline">JSON</a></div>

<table class="meta border-collapse mb-8 w-full">
{meta_rows}
</table>

{edge_section}

<div class="text-hg-muted text-[11px] uppercase tracking-wider mb-3">
  {len(groups)} Group(s)
</div>

{group_cards if group_cards else '<div class="text-hg-dim py-5">No groups.</div>'}

<script>
function copyText(btn) {{
  var pre = btn.closest('.group').querySelector('.group-text');
  if (!pre) return;
  navigator.clipboard.writeText(pre.textContent);
  btn.textContent = 'Copied';
  setTimeout(function() {{ btn.textContent = 'Copy'; }}, 1500);
}}
</script>
</body></html>"""
    return html, 200


@app.route("/<row_id>/json")
def packet_detail_json(row_id: str) -> tuple:
    db = get_db()
    row = db.execute(
        "SELECT id, packet_id, received_at, payload FROM packets WHERE id = ?",
        (row_id,),
    ).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    return (
        jsonify(
            {
                "id": row[0],
                "packetId": row[1],
                "receivedAt": row[2],
                "payload": json.loads(row[3]),
            }
        ),
        200,
    )


def run():
    init_db()
    port = int(os.environ.get("PORT", 5000))
    print(f"Sink packet server on http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=True)


if __name__ == "__main__":
    run()
