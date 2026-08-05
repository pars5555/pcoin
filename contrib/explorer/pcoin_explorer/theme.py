"""The stylesheet and the page shell.

Design constraints, in the order they mattered:

* **It has to work with JavaScript switched off.** There is none on any page.
  Search is a GET form, paging is links, the two address views are a query
  parameter. Nothing here degrades; there is nothing to degrade.
* **Plain and fast.** One stylesheet, served from memory with an ETag, no web
  fonts, no images, no third-party anything. A page is one request plus one
  cached stylesheet.
* **Dark, PCoin purple.** ``#8b5cf6`` is the tray app's accent
  (``contrib/windows-tray/MinerWindow.cs:159``) and the website's ``--violet``
  (``site/index.html``); the teal ``#2dd4bf`` and the near-black ``#0a0b10``
  come from the same palette, so the explorer looks like the rest of PCoin
  rather than like a generic explorer.
* **Readable on a phone.** Tables scroll inside their own container so the page
  body never scrolls sideways, and the stat grid collapses.
"""

CSS = """
:root{
  --bg:#0a0b10; --bg-alt:#0d0f17; --panel:#11131d; --panel-2:#151827;
  --line:rgba(255,255,255,.09); --line-soft:rgba(255,255,255,.06);
  --text:#e9ebf4; --muted:#9aa2b8; --dim:#6b7288;
  --violet:#8b5cf6; --violet-soft:rgba(139,92,246,.14);
  --teal:#2dd4bf; --amber:#f5b544; --red:#f87171; --green:#4ade80;
  --grad:linear-gradient(135deg,#8b5cf6,#2dd4bf);
  --radius:14px;
  --mono:ui-monospace,"Cascadia Code",Menlo,Consolas,"Liberation Mono",monospace;
}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-size:15.5px;line-height:1.6;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  -webkit-font-smoothing:antialiased}
a{color:var(--teal);text-decoration:none}
a:hover{text-decoration:underline}
code,.mono{font-family:var(--mono);font-size:.92em}
.wrap{max-width:1180px;margin:0 auto;padding:0 18px}
.dim{color:var(--dim)}
.muted{color:var(--muted)}
.nowrap{white-space:nowrap}
.right{text-align:right}
.center{text-align:center}
hr{border:0;border-top:1px solid var(--line-soft);margin:22px 0}

/* header ---------------------------------------------------------------- */
header.top{position:sticky;top:0;z-index:30;background:rgba(10,11,16,.93);
  backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.topbar{display:flex;align-items:center;gap:18px;padding:12px 0;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:1.06rem;
  color:var(--text);letter-spacing:.2px}
.brand:hover{text-decoration:none}
.brand .mark{width:26px;height:26px;border-radius:99px;background:var(--grad);
  display:inline-block;flex:0 0 auto}
.brand .sub{color:var(--dim);font-weight:500;font-size:.82rem}
nav.main{display:flex;gap:16px;flex-wrap:wrap;margin-left:auto}
nav.main a{color:var(--muted);font-size:.93rem}
nav.main a.on{color:var(--text);border-bottom:2px solid var(--violet)}
form.search{flex:1 1 320px;display:flex;gap:8px;min-width:240px;order:3}
form.search input{flex:1;background:var(--panel);border:1px solid var(--line);
  color:var(--text);border-radius:10px;padding:9px 12px;font-family:var(--mono);
  font-size:.9rem;min-width:0}
form.search input:focus{outline:none;border-color:var(--violet);
  box-shadow:0 0 0 3px var(--violet-soft)}
form.search button{background:var(--violet);color:#0a0b10;border:0;border-radius:10px;
  padding:9px 16px;font-weight:700;cursor:pointer;font-size:.9rem}
form.search button:hover{filter:brightness(1.1)}

/* banners --------------------------------------------------------------- */
.banner{border-radius:12px;padding:11px 15px;margin:16px 0;font-size:.92rem;
  border:1px solid var(--line)}
.banner b{font-weight:700}
.banner ul{margin:6px 0 0 18px}
.banner-warn{background:rgba(245,181,68,.10);border-color:rgba(245,181,68,.42);color:#f3ddb0}
.banner-err{background:rgba(248,113,113,.10);border-color:rgba(248,113,113,.42);color:#f6cccc}
.banner-info{background:var(--violet-soft);border-color:rgba(139,92,246,.34)}

/* headings -------------------------------------------------------------- */
main{padding:8px 0 60px}
h1{font-size:1.55rem;line-height:1.25;margin:18px 0 4px;font-weight:750}
h1 .kind{color:var(--dim);font-weight:600;font-size:.62em;display:block;
  text-transform:uppercase;letter-spacing:.16em;margin-bottom:4px}
h2{font-size:1.06rem;margin:26px 0 10px;font-weight:700;
  display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
h2 .note{font-size:.78rem;color:var(--dim);font-weight:500}
.subhead{color:var(--muted);font-size:.92rem;margin-bottom:6px;
  word-break:break-all;font-family:var(--mono)}

/* tiles ----------------------------------------------------------------- */
.tiles{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(178px,1fr));
  margin:16px 0}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  padding:13px 15px}
.tile .label{color:var(--dim);font-size:.74rem;text-transform:uppercase;
  letter-spacing:.1em;font-weight:600}
.tile .value{font-size:1.24rem;font-weight:700;margin-top:3px;
  font-family:var(--mono);word-break:break-word}
.tile .value.sm{font-size:1.0rem}
.tile .foot{color:var(--muted);font-size:.79rem;margin-top:3px}
.tile.accent{border-color:rgba(139,92,246,.42);background:
  linear-gradient(180deg,var(--violet-soft),var(--panel))}

/* panels and tables ------------------------------------------------------ */
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  overflow:hidden}
.panel .pad{padding:14px 16px}
.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th{text-align:left;color:var(--dim);font-weight:600;font-size:.74rem;
  text-transform:uppercase;letter-spacing:.09em;padding:10px 14px;
  border-bottom:1px solid var(--line);white-space:nowrap;background:var(--bg-alt)}
td{padding:9px 14px;border-bottom:1px solid var(--line-soft);vertical-align:top}
tr:last-child td{border-bottom:0}
tbody tr:hover td{background:rgba(255,255,255,.022)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.amt{font-family:var(--mono);white-space:nowrap}
.amt-f{color:var(--dim)}
.amt .unit{color:var(--dim);font-size:.86em}
.amt.pos{color:var(--green)}
.amt.neg{color:var(--red)}
.t{font-family:var(--mono);font-size:.86rem;white-space:nowrap}
.t-rel{display:block;color:var(--dim);font-size:.78rem}
.empty{padding:26px 16px;color:var(--muted);text-align:center}

/* key/value ------------------------------------------------------------- */
table.kv td,table.kv th{border-bottom:1px solid var(--line-soft)}
table.kv th{width:210px;text-transform:none;letter-spacing:0;font-size:.86rem;
  color:var(--muted);background:transparent;font-weight:500;vertical-align:top}
table.kv td{font-family:var(--mono);font-size:.88rem;word-break:break-all}
table.kv td .note{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  color:var(--dim);font-size:.82rem;display:block;word-break:normal}

/* badges ---------------------------------------------------------------- */
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:.72rem;
  font-weight:700;letter-spacing:.03em;white-space:nowrap;border:1px solid transparent;
  vertical-align:middle}
.badge-ok{background:rgba(74,222,128,.13);border-color:rgba(74,222,128,.34);color:#a5eec0}
.badge-soft{background:rgba(255,255,255,.06);border-color:var(--line);color:var(--muted)}
.badge-warn{background:rgba(245,181,68,.13);border-color:rgba(245,181,68,.36);color:#f0cf95}
.badge-err{background:rgba(248,113,113,.13);border-color:rgba(248,113,113,.36);color:#f3b8b8}
.badge-unknown{background:rgba(255,255,255,.05);border-color:var(--line);color:var(--dim)}
.badge-cb{background:var(--violet-soft);border-color:rgba(139,92,246,.42);color:#cbb6fb}

/* io (tx inputs/outputs) ------------------------------------------------- */
.io{display:grid;gap:14px;grid-template-columns:1fr 1fr}
.io .side{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  overflow:hidden}
.io .side h3{font-size:.78rem;text-transform:uppercase;letter-spacing:.1em;
  color:var(--dim);padding:11px 15px;border-bottom:1px solid var(--line);
  background:var(--bg-alt);font-weight:600}
.io .row{padding:10px 15px;border-bottom:1px solid var(--line-soft);
  display:flex;gap:10px;align-items:flex-start}
.io .row:last-child{border-bottom:0}
.io .idx{color:var(--dim);font-family:var(--mono);font-size:.78rem;
  min-width:22px;padding-top:2px}
.io .body{flex:1;min-width:0}
.io .addr{font-family:var(--mono);font-size:.85rem;word-break:break-all}
.io .meta{color:var(--dim);font-size:.78rem;margin-top:2px}
.io .val{text-align:right;white-space:nowrap;padding-top:1px}
.arrowcol{display:flex;align-items:center;justify-content:center;color:var(--dim)}

/* pager ----------------------------------------------------------------- */
.pager{display:flex;gap:8px;align-items:center;margin:14px 0;flex-wrap:wrap;
  font-size:.88rem;color:var(--muted)}
.pager a,.pager span.cur,.pager span.off{padding:5px 11px;border-radius:9px;
  border:1px solid var(--line);background:var(--panel)}
.pager span.cur{border-color:var(--violet);color:var(--text);font-weight:700}
.pager span.off{color:var(--dim);opacity:.55}
.pager .spacer{flex:1}
.tabs{display:flex;gap:8px;margin:14px 0 0;flex-wrap:wrap}
.tabs a{padding:6px 13px;border-radius:10px;border:1px solid var(--line);
  background:var(--panel);color:var(--muted);font-size:.88rem}
.tabs a.on{border-color:var(--violet);color:var(--text);background:var(--violet-soft);
  font-weight:600}

/* footer ---------------------------------------------------------------- */
footer{border-top:1px solid var(--line);padding:20px 0 40px;color:var(--dim);
  font-size:.82rem}
footer .cols{display:flex;gap:26px;flex-wrap:wrap;justify-content:space-between}
footer a{color:var(--muted)}
footer .warn{color:var(--amber)}

.prose{max-width:74ch}
.prose p{margin:10px 0;color:var(--muted)}
.prose li{margin:5px 0 5px 20px;color:var(--muted)}
.prose h2{margin-top:26px}
.prose code{background:var(--panel-2);padding:1px 5px;border-radius:5px;color:var(--text)}
pre{background:var(--panel-2);border:1px solid var(--line);border-radius:10px;
  padding:12px 14px;overflow-x:auto;font-family:var(--mono);font-size:.84rem;
  color:var(--text)}

@media (max-width:820px){
  .io{grid-template-columns:1fr}
  .arrowcol{display:none}
}
@media (max-width:700px){
  body{font-size:15px}
  nav.main{order:2;width:100%;margin-left:0;gap:14px}
  form.search{order:3;flex-basis:100%}
  table.kv th{width:auto;display:block;padding-bottom:0;border:0}
  table.kv td{display:block;padding-top:2px}
  table.kv tr{display:block;border-bottom:1px solid var(--line-soft);padding:6px 0}
  .tiles{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
  .tile .value{font-size:1.06rem}
}
"""

FAVICON = (
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'"
    "%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop"
    " offset='0' stop-color='%238b5cf6'/%3E%3Cstop offset='1' stop-color='%232dd4bf'/"
    "%3E%3C/linearGradient%3E%3C/defs%3E%3Ccircle cx='32' cy='32' r='31' fill='%230a0b10'"
    "/%3E%3Ccircle cx='32' cy='32' r='28' fill='url(%23g)'/%3E%3Cpath d='M25 47V17h11a10"
    " 10 0 0 1 0 20h-8' fill='none' stroke='%230a0b10' stroke-width='6' stroke-linecap="
    "'round' stroke-linejoin='round'/%3E%3C/svg%3E")
