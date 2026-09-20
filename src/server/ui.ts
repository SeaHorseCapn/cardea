/**
 * Single-file dashboard UI, embedded so tsc needs no asset pipeline.
 * NOTE: this is a TS template literal — client JS below deliberately avoids
 * backticks and "$" + "{" sequences.
 */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cardea</title>
<style>
  :root {
    --bg: #101418; --panel: #171d24; --panel2: #1e2630; --border: #2a3441;
    --text: #d7dee8; --dim: #7d8a99;
    --claude: #4cc2ff; --codex: #3fb950; --grok: #d47eff; --local: #e3b341;
    --err: #ff6b6b; --accent: #4cc2ff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 14px/1.5 "SF Mono", ui-monospace, Menlo, monospace; }
  header { display: flex; align-items: center; gap: 10px; padding: 12px 20px;
           border-bottom: 1px solid var(--border); background: var(--panel); }
  header h1 { font-size: 16px; margin: 0; letter-spacing: 1px; }
  #conn { width: 9px; height: 9px; border-radius: 50%; background: var(--err); }
  #conn.ok { background: var(--codex); }
  main { display: grid; grid-template-columns: 260px 1fr; gap: 0; min-height: calc(100vh - 50px); }
  @media (max-width: 800px) { main { grid-template-columns: 1fr; } #history { display: none; } }
  #history { border-right: 1px solid var(--border); background: var(--panel); padding: 12px; overflow-y: auto; }
  #history h2, #composer h2 { font-size: 11px; text-transform: uppercase; color: var(--dim); margin: 4px 0 8px; }
  .hist-item { padding: 8px; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 8px;
               cursor: pointer; font-size: 12px; }
  .hist-item:hover { background: var(--panel2); }
  .hist-item .when { color: var(--dim); font-size: 10px; }
  #content { padding: 16px 20px; overflow-y: auto; }
  #composer { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px; margin-bottom: 18px; }
  #prompt { width: 100%; min-height: 64px; background: var(--bg); color: var(--text); border: 1px solid var(--border);
            border-radius: 6px; padding: 8px; font: inherit; resize: vertical; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; align-items: center; }
  input[type=text], select { background: var(--bg); color: var(--text); border: 1px solid var(--border);
            border-radius: 6px; padding: 6px 8px; font: inherit; font-size: 12px; }
  #cwd { flex: 1; min-width: 220px; }
  label.chk { color: var(--dim); font-size: 12px; display: flex; gap: 5px; align-items: center; }
  button { background: var(--accent); color: #06121a; border: 0; border-radius: 6px; padding: 8px 18px;
           font: inherit; font-weight: 700; cursor: pointer; }
  button:disabled { opacity: .4; cursor: default; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 16px; overflow: hidden; }
  .card-head { display: flex; gap: 10px; align-items: baseline; padding: 10px 14px; background: var(--panel2);
               border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .badge { font-size: 10px; text-transform: uppercase; padding: 2px 8px; border-radius: 10px;
           background: var(--bg); border: 1px solid var(--border); color: var(--dim); }
  .badge.running { color: var(--claude); border-color: var(--claude); }
  .badge.done { color: var(--codex); border-color: var(--codex); }
  .badge.failed { color: var(--err); border-color: var(--err); }
  .card-prompt { flex: 1; min-width: 200px; }
  .card-meta { color: var(--dim); font-size: 11px; }
  .log { padding: 10px 14px; max-height: 420px; overflow-y: auto; font-size: 12px; }
  .log div { white-space: pre-wrap; word-break: break-word; margin: 1px 0; }
  .w-claude { color: var(--claude); } .w-codex { color: var(--codex); } .w-grok { color: var(--grok); } .w-local { color: var(--local); }
  .dim { color: var(--dim); } .err { color: var(--err); }
  .ctext { color: var(--text); background: var(--panel2); border-left: 3px solid var(--claude);
           padding: 6px 8px; border-radius: 0 4px 4px 0; margin: 4px 0; }
  .result { border-top: 1px solid var(--border); padding: 12px 14px; white-space: pre-wrap;
            word-break: break-word; background: #131a21; }
  .result h3 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; color: var(--codex); }
  details.dlg { margin: 3px 0; }
  details.dlg summary { cursor: pointer; }
  details.dlg pre { white-space: pre-wrap; word-break: break-word; color: var(--dim); margin: 4px 0 4px 16px; }
  #resume-banner { font-size: 12px; color: var(--dim); margin-bottom: 8px; padding: 6px 8px;
                   background: var(--panel2); border-radius: 6px; }
  header nav { margin-left: auto; }
  .tab { background: transparent; color: var(--dim); border: 1px solid var(--border); border-radius: 6px;
         padding: 4px 12px; font: inherit; font-size: 12px; cursor: pointer; margin-left: 6px; }
  .tab.on { color: var(--accent); border-color: var(--accent); }
  #sessions-view { grid-template-rows: auto 1fr; height: calc(100vh - 50px); }
  #sess-bar { display: flex; gap: 10px; padding: 12px 20px; border-bottom: 1px solid var(--border);
              background: var(--panel); align-items: center; flex-wrap: wrap; }
  #sess-q { flex: 1; min-width: 200px; }
  #sess-main { display: grid; grid-template-columns: minmax(280px, 400px) 1fr; min-height: 0; }
  #sess-list { overflow-y: auto; border-right: 1px solid var(--border); }
  #sess-detail { overflow-y: auto; padding: 16px 20px; }
  .sess-row { padding: 10px 14px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .sess-row:hover, .sess-row.sel { background: var(--panel2); }
  .sess-row .t { font-size: 13px; margin-bottom: 3px; }
  .sess-row .m { font-size: 11px; color: var(--dim); word-break: break-word; }
  .pill { font-size: 10px; text-transform: uppercase; padding: 1px 6px; border-radius: 8px;
          border: 1px solid var(--border); margin-right: 6px; }
  .pill.w-claude { border-color: var(--claude); } .pill.w-codex { border-color: var(--codex); } .pill.w-grok { border-color: var(--grok); }
  .msg { margin: 0 0 14px; white-space: pre-wrap; word-break: break-word; font-size: 13px; }
  .msg .who { font-size: 10px; text-transform: uppercase; color: var(--dim); margin-bottom: 3px; }
  .msg.user .who { color: var(--claude); } .msg.assistant .who { color: var(--codex); }
  @media (max-width: 800px) { #sess-main { grid-template-columns: 1fr; } #sess-list { border-right: 0; max-height: 40vh; } }
</style>
</head>
<body>
<header><h1>cardea</h1><div id="conn" title="websocket"></div>
  <span class="dim" style="font-size:11px">coordinate · panel · single worker</span>
  <nav><button id="tab-console" class="tab on">Console</button><button id="tab-sessions" class="tab">Sessions</button></nav>
</header>
<main>
  <aside id="history"><h2>Runs</h2><div id="hist-list" class="dim">loading…</div></aside>
  <section id="content">
    <div id="composer">
      <h2>New task</h2>
      <div id="resume-banner" style="display:none"></div>
      <textarea id="prompt" placeholder="What should the team work on?"></textarea>
      <div class="row">
        <select id="mode">
          <option value="coordinate">coordinate — claude decides</option>
          <option value="panel">panel — enabled workers + synthesis</option>
        </select>
        <select id="tier" title="cost/capability tier for single &amp; panel workers">
          <option value="">tier: auto</option>
          <option value="fast">tier: fast (cheapest)</option>
          <option value="standard">tier: standard</option>
          <option value="deep">tier: deep (most capable)</option>
        </select>
        <input type="text" id="cwd" placeholder="working directory">
        <label class="chk"><input type="checkbox" id="writes"> allow writes</label>
        <label class="chk"><input type="checkbox" id="safe"> safe (plan mode)</label>
        <button id="run">Run</button>
      </div>
    </div>
    <div id="runs"></div>
  </section>
</main>
<section id="sessions-view" style="display:none">
  <div id="sess-bar">
    <input type="text" id="sess-q" placeholder="search title or folder… (Enter)">
    <select id="sess-provider">
      <option value="">all providers</option>
      <option value="claude">claude</option>
      <option value="codex">codex</option>
      <option value="grok">grok</option>
    </select>
    <span class="dim" style="font-size:11px">every local session across your CLIs</span>
  </div>
  <div id="sess-main">
    <div id="sess-list" class="dim">loading…</div>
    <div id="sess-detail" class="dim">select a session to read its transcript</div>
  </div>
</section>
<script>
(function () {
  "use strict";
  var ws = null;
  var cards = {};           // taskId -> {el, log, status, startTs}
  var pendingRef = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function fmtDur(ms) { return (ms / 1000).toFixed(1) + "s"; }

  function populateWorkers(workers) {
    var mode = document.getElementById("mode");
    Array.prototype.slice.call(mode.querySelectorAll("option")).forEach(function (opt) {
      if (opt.value.indexOf("single:") === 0) opt.remove();
    });
    (workers || []).forEach(function (name) {
      var opt = document.createElement("option");
      opt.value = "single:" + name;
      opt.textContent = "single — " + name;
      mode.appendChild(opt);
    });
  }

  function newCard(taskId, prompt, mode, ts) {
    var card = el("div", "card");
    var head = el("div", "card-head");
    var badge = el("span", "badge running", mode || "run");
    var p = el("span", "card-prompt", prompt || "(other session)");
    var meta = el("span", "card-meta", new Date(ts || Date.now()).toLocaleTimeString());
    head.appendChild(badge); head.appendChild(p); head.appendChild(meta);
    var log = el("div", "log");
    card.appendChild(head); card.appendChild(log);
    var runs = document.getElementById("runs");
    runs.insertBefore(card, runs.firstChild);
    cards[taskId] = { el: card, log: log, badge: badge, startTs: ts || Date.now() };
    return cards[taskId];
  }

  function getCard(ev) {
    return cards[ev.taskId] || newCard(ev.taskId, ev.prompt, ev.mode, ev.ts);
  }

  function addLine(card, cls, text) {
    card.log.appendChild(el("div", cls, text));
    card.log.scrollTop = card.log.scrollHeight;
  }

  function handle(ev) {
    if (ev.type === "task_started") { getCard(ev); return; }
    var card = getCard(ev);
    if (ev.type === "coordinator_text") {
      card.log.appendChild(el("div", "ctext", ev.text));
    } else if (ev.type === "coordinator_tool_use") {
      var inp = "";
      try { inp = JSON.stringify(ev.input).slice(0, 110); } catch (e) { inp = ""; }
      addLine(card, "dim", "⚙ " + ev.tool + " " + inp);
    } else if (ev.type === "delegation_started") {
      addLine(card, "w-" + ev.worker, "▶ " + ev.worker + " started: " +
        ev.prompt.replace(/\\s+/g, " ").slice(0, 120));
    } else if (ev.type === "worker_output_chunk") {
      if (ev.chunk.charAt(0) === "{") return;
      addLine(card, "dim w-" + ev.worker, "[" + ev.worker + "] " + ev.chunk.slice(0, 200));
    } else if (ev.type === "delegation_finished") {
      var d = el("details", "dlg");
      var s = el("summary", "w-" + ev.worker,
        "■ " + ev.worker + " finished in " + fmtDur(ev.durationMs) + " (exit " + ev.exitCode + ") — click for output");
      var pre = el("pre", "", ev.output);
      d.appendChild(s); d.appendChild(pre);
      card.log.appendChild(d);
      card.log.scrollTop = card.log.scrollHeight;
    } else if (ev.type === "task_finished") {
      card.badge.className = "badge done"; card.badge.textContent = "done " + fmtDur(ev.durationMs);
      var res = el("div", "result");
      var h = el("h3", "", "Result");
      var body = el("div", "", ev.result);
      res.appendChild(h); res.appendChild(body);
      card.el.appendChild(res);
      loadHistory();
    } else if (ev.type === "error") {
      addLine(card, "err", (ev.fatal ? "✘ fatal " : "⚠ ") + "[" + ev.scope + "] " + ev.message);
      if (ev.fatal) { card.badge.className = "badge failed"; card.badge.textContent = "failed"; }
    }
  }

  function connect() {
    // wss:// when the page is served over HTTPS (e.g. behind Tailscale Serve),
    // ws:// for plain local http — otherwise browsers block the mixed content.
    var wsProto = location.protocol === "https:" ? "wss://" : "ws://";
    ws = new WebSocket(wsProto + location.host);
    ws.onopen = function () { document.getElementById("conn").className = "ok"; };
    ws.onclose = function () {
      document.getElementById("conn").className = "";
      setTimeout(connect, 1500);
    };
    ws.onmessage = function (m) {
      var ev;
      try { ev = JSON.parse(m.data); } catch (e) { return; }
      if (ev.type === "hello") {
        var cwdBox = document.getElementById("cwd");
        if (!cwdBox.value) cwdBox.value = ev.defaultCwd || "";
        populateWorkers(ev.workers || []);
        return;
      }
      if (ev.type === "run_accepted") {
        document.getElementById("run").disabled = false;
        return;
      }
      handle(ev);
    };
  }

  document.getElementById("run").addEventListener("click", function () {
    var prompt = document.getElementById("prompt").value.trim();
    if (!prompt || !ws || ws.readyState !== 1) return;
    var modeSel = document.getElementById("mode").value.split(":");
    var msg = {
      type: "run",
      clientRef: String(Date.now()),
      prompt: prompt,
      mode: modeSel[0],
      worker: modeSel[1],
      cwd: document.getElementById("cwd").value.trim(),
      allowWrites: document.getElementById("writes").checked,
      posture: document.getElementById("safe").checked ? "safe" : "default",
      tier: document.getElementById("tier").value || undefined
    };
    if (resumeState) {
      // resume forces single-worker mode for the session's own provider
      msg.mode = "single";
      msg.worker = resumeState.provider;
      msg.resumeId = resumeState.id;
      cancelResume();
    }
    ws.send(JSON.stringify(msg));
    var btn = document.getElementById("run");
    btn.disabled = true;
    setTimeout(function () { btn.disabled = false; }, 4000);
  });

  function loadHistory() {
    fetch("/api/runs").then(function (r) { return r.json(); }).then(function (runs) {
      var list = document.getElementById("hist-list");
      list.textContent = runs.length ? "" : "no runs yet";
      runs.forEach(function (r) {
        var item = el("div", "hist-item");
        item.appendChild(el("div", r.finished ? "" : "w-claude", r.prompt));
        item.appendChild(el("div", "when", r.mode + " · " + new Date(r.startedAt).toLocaleString()));
        item.addEventListener("click", function () { replay(r.id); });
        list.appendChild(item);
      });
    }).catch(function () {});
  }

  function replay(id) {
    fetch("/api/runs/" + encodeURIComponent(id)).then(function (r) { return r.text(); }).then(function (body) {
      body.trim().split("\\n").forEach(function (line) {
        var ev;
        try { ev = JSON.parse(line); } catch (e) { return; }
        // replay into a fresh card namespace so live runs aren't disturbed
        if (ev.type === "task_started" && cards[ev.taskId]) delete cards[ev.taskId];
        handle(ev);
      });
      document.getElementById("content").scrollTop = 0;
    }).catch(function () {});
  }

  // ---- Sessions tab: cross-provider history browser ----
  var sessLoaded = false, sessSel = null, resumeState = null;

  function startResume(s) {
    resumeState = { id: s.id, provider: s.provider, cwd: s.cwd, title: s.title };
    document.getElementById("cwd").value = s.cwd || "";
    var m = document.getElementById("mode");
    m.value = "single:" + s.provider;
    var b = document.getElementById("resume-banner");
    b.style.display = "block";
    b.textContent = "";
    b.appendChild(el("span", "pill w-" + s.provider, s.provider));
    b.appendChild(document.createTextNode(" resuming " + (s.title || s.id).slice(0, 60) + " — "));
    var x = el("a", "", "cancel");
    x.href = "#"; x.style.color = "var(--err)";
    x.addEventListener("click", function (e) { e.preventDefault(); cancelResume(); });
    b.appendChild(x);
    showTab("console");
    document.getElementById("prompt").placeholder = "Continue this " + s.provider + " session…";
    document.getElementById("prompt").focus();
  }
  function cancelResume() {
    resumeState = null;
    var b = document.getElementById("resume-banner");
    b.style.display = "none"; b.textContent = "";
    document.getElementById("prompt").placeholder = "What should the team work on?";
  }

  function showTab(name) {
    var on = name === "sessions";
    document.querySelector("main").style.display = on ? "none" : "grid";
    document.getElementById("sessions-view").style.display = on ? "grid" : "none";
    document.getElementById("tab-console").className = "tab" + (on ? "" : " on");
    document.getElementById("tab-sessions").className = "tab" + (on ? " on" : "");
    if (on && !sessLoaded) { loadSessions(); sessLoaded = true; }
  }
  document.getElementById("tab-console").addEventListener("click", function () { showTab("console"); });
  document.getElementById("tab-sessions").addEventListener("click", function () { showTab("sessions"); });

  function loadSessions() {
    var q = document.getElementById("sess-q").value.trim();
    var prov = document.getElementById("sess-provider").value;
    var url = "/api/sessions?limit=300" + (q ? "&q=" + encodeURIComponent(q) : "") + (prov ? "&provider=" + prov : "");
    var list = document.getElementById("sess-list");
    list.textContent = "loading…";
    fetch(url).then(function (r) { return r.json(); }).then(function (rows) {
      list.textContent = rows.length ? "" : "no sessions found";
      rows.forEach(function (s) {
        var row = el("div", "sess-row");
        var t = el("div", "t");
        t.appendChild(el("span", "pill w-" + s.provider, s.provider));
        t.appendChild(document.createTextNode(s.title));
        var meta = (s.cwd || "(no cwd)") + " · " + new Date(s.updatedAt).toLocaleString() +
          (s.messageCount >= 0 ? " · " + s.messageCount + " msgs" : "");
        row.appendChild(t);
        row.appendChild(el("div", "m", meta));
        row.addEventListener("click", function () { openSession(s, row); });
        list.appendChild(row);
      });
    }).catch(function () { list.textContent = "error loading sessions"; });
  }

  function openSession(s, row) {
    if (sessSel) sessSel.className = "sess-row";
    row.className = "sess-row sel";
    sessSel = row;
    var d = document.getElementById("sess-detail");
    d.className = "";
    d.textContent = "loading…";
    fetch("/api/sessions/detail?token=" + encodeURIComponent(s.token))
      .then(function (r) { return r.json(); })
      .then(function (res) {
        d.textContent = "";
        var h = el("div", "m", s.provider + " · " + s.title + " · " + res.messages.length + " messages");
        h.style.marginBottom = "12px";
        var rb = el("button", "tab", "↩ Resume this session");
        rb.style.marginLeft = "10px";
        rb.addEventListener("click", function () { startResume(s); });
        h.appendChild(rb);
        d.appendChild(h);
        res.messages.forEach(function (mm) {
          var w = el("div", "msg " + mm.role);
          w.appendChild(el("div", "who", mm.role));
          w.appendChild(document.createTextNode(mm.text));
          d.appendChild(w);
        });
        if (!res.messages.length) d.appendChild(el("div", "dim", "(no readable messages in this transcript)"));
      }).catch(function () { d.textContent = "error loading transcript"; });
  }

  document.getElementById("sess-q").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { sessSel = null; loadSessions(); }
  });
  document.getElementById("sess-provider").addEventListener("change", function () { sessSel = null; loadSessions(); });

  connect();
  loadHistory();
})();
</script>
</body>
</html>
`;
