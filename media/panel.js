// Webview side of the Forge agent panel. Renders the TrueForge event stream the extension relays.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $("log");
  const input = $("input");
  const sugg = $("suggest");
  let busy = false;
  let currentAgentMsg = null; // streaming target for the main thread
  const subMsgs = new Map(); // threadId -> element
  const tools = new Map(); // toolCallId -> element
  const reviews = new Map(); // reviewId -> element
  const threads = new Map(); // threadId -> title
  let suggestions = [];
  let sel = 0;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const scroll = () => {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 160;
    if (nearBottom) log.scrollTop = log.scrollHeight;
  };
  const add = (e) => {
    log.appendChild(e);
    scroll();
    return e;
  };
  const short = (v, n = 140) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > n ? s.slice(0, n) + "…" : s;
  };

  function setBusy(b) {
    busy = b;
    $("busy").hidden = !b;
    $("stop").hidden = !b;
    $("send").disabled = b;
  }

  function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    vscode.postMessage({ t: "send", text });
    input.value = "";
    hideSuggest();
  }
  $("send").onclick = send;
  $("stop").onclick = () => vscode.postMessage({ t: "cancel" });
  $("undo").onclick = () => vscode.postMessage({ t: "undo" });
  $("newchat").onclick = () => vscode.postMessage({ t: "newChat" });

  // ----- @mention autocomplete -----
  function mentionPrefix() {
    const upto = input.value.slice(0, input.selectionStart);
    const m = /@([\w./\\:-]*)$/.exec(upto);
    return m ? m[1] : null;
  }
  function hideSuggest() {
    sugg.hidden = true;
    suggestions = [];
  }
  function renderSuggest() {
    sugg.innerHTML = "";
    if (!suggestions.length) return hideSuggest();
    suggestions.forEach((s, i) => {
      const d = el("div", i === sel ? "sel" : "", s.label);
      d.appendChild(el("span", "k", s.kind));
      d.onmousedown = (e) => {
        e.preventDefault();
        pick(i);
      };
      sugg.appendChild(d);
    });
    sugg.hidden = false;
  }
  function pick(i) {
    const s = suggestions[i];
    if (!s) return;
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos).replace(/@([\w./\\:-]*)$/, s.insert + " ");
    input.value = before + input.value.slice(pos);
    input.selectionStart = input.selectionEnd = before.length;
    hideSuggest();
    input.focus();
  }
  input.addEventListener("input", () => {
    const p = mentionPrefix();
    if (p === null) return hideSuggest();
    vscode.postMessage({ t: "suggest", prefix: p });
  });
  input.addEventListener("keydown", (e) => {
    if (!sugg.hidden && suggestions.length) {
      if (e.key === "ArrowDown") { sel = (sel + 1) % suggestions.length; renderSuggest(); e.preventDefault(); return; }
      if (e.key === "ArrowUp") { sel = (sel - 1 + suggestions.length) % suggestions.length; renderSuggest(); e.preventDefault(); return; }
      if (e.key === "Enter" || e.key === "Tab") { pick(sel); e.preventDefault(); return; }
      if (e.key === "Escape") { hideSuggest(); e.preventDefault(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === "Escape" && busy) vscode.postMessage({ t: "cancel" });
  });

  // ----- renderers -----
  function renderDiffPreview(pre, text) {
    pre.innerHTML = "";
    for (const line of text.split("\n")) {
      const cls = line.startsWith("+ ") ? "l-add" : line.startsWith("- ") ? "l-del" : "l-ctx";
      pre.appendChild(el("span", cls, line));
    }
  }

  function renderReview(m) {
    const card = el("div", "card review");
    const h = el("h4");
    h.appendChild(el("span", "", (m.isNew ? "New file " : "Edit ") + m.path));
    h.appendChild(el("span", "meta", `${m.hunks.length} hunk${m.hunks.length === 1 ? "" : "s"} · ${m.origin === "inline" ? "inline edit" : "agent"}`));
    card.appendChild(h);
    if (m.summary) card.appendChild(el("div", "meta", m.summary));
    for (const note of m.notes || []) card.appendChild(el("div", "meta", "note: " + note));
    const hunksBox = el("div");
    m.hunks.forEach((hk) => {
      const box = el("div", "hunk");
      box.dataset.idx = hk.index;
      const hh = el("div", "hh");
      hh.appendChild(el("span", "", `Hunk ${hk.index + 1}`));
      hh.appendChild(el("span", "meta", hk.stats));
      hh.appendChild(el("span", "grow"));
      const acc = el("button", "ok", "✓ Accept");
      const rej = el("button", "bad", "✗ Reject");
      acc.onclick = () => vscode.postMessage({ t: "hunk", id: m.id, idx: hk.index, accept: true });
      rej.onclick = () => vscode.postMessage({ t: "hunk", id: m.id, idx: hk.index, accept: false });
      hh.append(acc, rej);
      const pre = el("pre");
      renderDiffPreview(pre, hk.preview);
      box.append(hh, pre);
      hunksBox.appendChild(box);
    });
    card.appendChild(hunksBox);
    const actions = el("div", "actions");
    const all = el("button", "ok", "Accept all");
    const none = el("button", "bad", "Reject all");
    const open = el("button", "secondary", "Show diff");
    all.onclick = () => vscode.postMessage({ t: "reviewAll", id: m.id, accept: true });
    none.onclick = () => vscode.postMessage({ t: "reviewAll", id: m.id, accept: false });
    open.onclick = () => vscode.postMessage({ t: "showDiff", id: m.id });
    actions.append(all, none, open);
    card.appendChild(actions);
    reviews.set(m.id, card);
    add(card);
  }

  function updateReview(id, states, ended, acceptedCount) {
    const card = reviews.get(id);
    if (!card) return;
    card.querySelectorAll(".hunk").forEach((box) => {
      const st = states[Number(box.dataset.idx)];
      box.classList.toggle("accepted", st === "accepted");
      box.classList.toggle("rejected", st === "rejected");
      box.querySelectorAll("button").forEach((b) => (b.disabled = ended));
      const ok = box.querySelector("button.ok");
      const bad = box.querySelector("button.bad");
      if (ok) ok.textContent = st === "accepted" ? "✓ Accepted" : "✓ Accept";
      if (bad) bad.textContent = st === "rejected" ? "✗ Rejected" : "✗ Reject";
    });
    if (ended) {
      card.querySelector(".actions").innerHTML = "";
      card.querySelector(".actions").appendChild(el("span", "badge", acceptedCount ? `${acceptedCount}/${states.length} hunks accepted` : "rejected"));
    }
  }

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    switch (m.t) {
      case "state":
        setBusy(!!m.busy);
        if (m.model !== undefined) $("model").textContent = "model: " + (m.model || "—");
        if (m.undoDepth !== undefined) $("undo").disabled = !m.undoDepth;
        if (m.session !== undefined) {
          const s = $("session");
          s.innerHTML = "";
          if (m.session) {
            const a = el("a", "", "TrueForge session ↗");
            a.title = m.session;
            a.onclick = () => vscode.postMessage({ t: "openSession" });
            s.appendChild(a);
          }
        }
        break;
      case "clear":
        log.innerHTML = "";
        currentAgentMsg = null;
        tools.clear();
        reviews.clear();
        subMsgs.clear();
        break;
      case "user":
        add(el("div", "msg user", m.text));
        currentAgentMsg = null;
        break;
      case "context": {
        const card = el("div", "card ctx");
        const h = el("h4");
        h.appendChild(el("span", "", `Context chosen by Forge`));
        h.appendChild(el("span", "meta", `${m.used.toLocaleString()} / ${m.budget.toLocaleString()} tokens · ${m.items.length} items · repo: ${m.indexedFiles} files, ${m.indexedLines.toLocaleString()} lines`));
        card.appendChild(h);
        const bar = el("div", "budget");
        const fill = el("div");
        fill.style.width = Math.min(100, (100 * m.used) / m.budget) + "%";
        bar.appendChild(fill);
        card.appendChild(bar);
        const table = el("table");
        for (const it of m.items) {
          const tr = el("tr");
          tr.appendChild(el("td", "f", it.file === "(repo map)" ? "repo map" : `${it.file}:${it.start}-${it.end}`));
          tr.appendChild(el("td", "why", `${it.source === "mention" ? "📌 " : ""}${it.reason} · ${it.tokens}t`));
          table.appendChild(tr);
        }
        const det = el("details");
        const sum = el("summary", "", "why these files?");
        det.append(sum, table);
        det.open = true;
        card.appendChild(det);
        if (m.query) card.appendChild(el("div", "meta", "query terms: " + m.query.join(" ")));
        add(card);
        break;
      }
      case "delta": {
        if (m.thread && m.thread !== "main") {
          let e = subMsgs.get(m.thread);
          if (!e) {
            e = add(el("div", "msg sub", `[sub-agent ${threads.get(m.thread) || m.thread}] `));
            subMsgs.set(m.thread, e);
          }
          e.textContent += m.text;
        } else {
          if (!currentAgentMsg) currentAgentMsg = add(el("div", "msg agent", ""));
          currentAgentMsg.textContent += m.text;
        }
        scroll();
        break;
      }
      case "message":
        if (!m.streamed && m.text) {
          if (m.thread && m.thread !== "main") add(el("div", "msg sub", `[sub-agent ${threads.get(m.thread) || m.thread}] ${m.text}`));
          else add(el("div", "msg agent", m.text));
        }
        currentAgentMsg = null;
        subMsgs.delete(m.thread);
        break;
      case "tool": {
        const t = el("div", "tool" + (m.thread && m.thread !== "main" ? " sub" : ""));
        t.appendChild(el("div", "", `⚙ ${m.server ? m.server + " · " : ""}${m.name}  ${short(m.args)}`));
        tools.set(m.id, t);
        add(t);
        currentAgentMsg = null;
        break;
      }
      case "toolResult": {
        const t = tools.get(m.id);
        if (t) t.appendChild(el("div", "res", short(m.content, 400)));
        break;
      }
      case "thread":
        threads.set(m.id, m.title);
        add(el("div", "status info", `↳ sub-agent started: ${m.title}`));
        break;
      case "status":
        add(el("div", "status " + (m.level || "info"), m.msg));
        break;
      case "review":
        renderReview(m);
        break;
      case "reviewUpdate":
        updateReview(m.id, m.states, false);
        break;
      case "reviewEnd":
        updateReview(m.id, m.states, true, m.accepted);
        break;
      case "approval": {
        const card = el("div", "card");
        const h = el("h4");
        h.appendChild(el("span", "", `Allow ${m.name}?`));
        card.appendChild(h);
        const pre = el("pre", "", typeof m.args === "string" ? m.args : m.args.command || JSON.stringify(m.args, null, 2));
        card.appendChild(pre);
        const row = el("div", "actions");
        const yes = el("button", "ok", "Allow");
        const no = el("button", "bad", "Deny");
        const done = (allow) => {
          vscode.postMessage({ t: "approve", id: m.id, allow });
          row.innerHTML = "";
          row.appendChild(el("span", "badge", allow ? "allowed" : "denied"));
        };
        yes.onclick = () => done(true);
        no.onclick = () => done(false);
        row.append(yes, no);
        card.appendChild(row);
        add(card);
        break;
      }
      case "applied":
        add(el("div", "status info", `✓ wrote ${m.file} (${m.label}) — undo available`));
        $("undo").disabled = !m.undoDepth;
        break;
      case "suggest":
        suggestions = m.items;
        sel = 0;
        renderSuggest();
        break;
      case "done":
        setBusy(false);
        currentAgentMsg = null;
        break;
    }
  });
  vscode.postMessage({ t: "ready" });
})();
