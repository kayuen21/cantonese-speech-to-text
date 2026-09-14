/* 粵轉文字 — frontend logic */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const els = {
    dropzone: $("dropzone"), fileInput: $("fileInput"), fileChip: $("fileChip"),
    fileName: $("fileName"), fileSize: $("fileSize"), fileRemove: $("fileRemove"),
    controls: $("controls"), progress: $("progress"), progressStatus: $("progressStatus"),
    progressPct: $("progressPct"), progressFill: $("progressFill"),
    transcript: $("transcript"), transBody: $("transBody"), metaChips: $("metaChips"),
    copyBtn: $("copyBtn"), dlTxt: $("dlTxt"), dlSrt: $("dlSrt"), dlVtt: $("dlVtt"),
    resetBtn: $("resetBtn"), errorBox: $("errorBox"), errorText: $("errorText"),
    gpuBadge: $("gpuBadge"), modelNote: $("modelNote"), toast: $("toast"),
    viewTabs: $("viewTabs"), runActions: $("runActions"), startBtn: $("startBtn"),
    abortBtn: $("abortBtn"), runHint: $("runHint"),
    chat: $("chat"), chatSub: $("chatSub"), chatClear: $("chatClear"), chatWarn: $("chatWarn"),
    chatLog: $("chatLog"), chatInput: $("chatInput"), chatSend: $("chatSend"), chatStop: $("chatStop"),
  };

  const state = { file: null, jobId: null, timer: null, running: false, text: "", segments: [], corrected: null, view: "raw" };

  const LANG_LABELS = { zh: "粵語 / 中文", yue: "粵語", en: "English" };
  const LANG_CODES = { "zh": "粵語/中文" };

  const MODEL_NOTES = {
    "medium": "均衡檔，速度快，日常足夠",
    "large-v3": "精準檔，首次使用需下載約 3GB 模型",
  };

  /* ---------- helpers ---------- */

  function fmtBytes(b) {
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
    return (b / 1048576).toFixed(1) + " MB";
  }

  function fmtDuration(sec) {
    if (!sec) return "—";
    sec = Math.round(sec);
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function langLabel(code) {
    return LANG_LABELS[code] || code || "—";
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.remove("hidden");
    requestAnimationFrame(() => els.toast.classList.add("show"));
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.remove("show"), 1800);
  }

  function segmentsToHtml(lines) {
    if (!lines.length) {
      return '<p class="placeholder">正在轉寫，文字將逐行顯示…</p>';
    }
    return lines.map((l) => {
      const m = l.match(/^(說話人(\d+)：)(.*)$/);
      if (m) {
        return `<p><span class="spk spk-${m[2]}">${m[1]}</span>${escapeHtml(m[3])}</p>`;
      }
      return `<p>${escapeHtml(l)}</p>`;
    }).join("");
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /* ---------- GPU health ---------- */

  async function checkHealth() {
    try {
      const r = await fetch("/api/health");
      const h = await r.json();
      if (h.gpu) {
        els.gpuBadge.textContent = "GPU 就緒 · " + (h.cuda_devices > 0 ? "CUDA" : "") + " 加速中";
        els.gpuBadge.classList.add("ok");
      } else {
        els.gpuBadge.textContent = "CPU 模式（未偵測到 GPU）";
        els.gpuBadge.classList.add("warn");
      }
    } catch (e) {
      els.gpuBadge.textContent = "服務未連線";
      els.gpuBadge.classList.add("warn");
    }
  }

  /* ---------- segmented controls ---------- */

  function bindSegmented(segId, onChange) {
    const seg = $(segId);
    if (!seg) return;
    seg.addEventListener("click", (e) => {
      const btn = e.target.closest(".seg-btn");
      if (!btn) return;
      seg.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      if (onChange) onChange(btn.dataset.value);
    });
  }

  bindSegmented("modelSeg", (v) => {
    els.modelNote.textContent = MODEL_NOTES[v] || "";
  });
  // Every segmented control needs this handler — without it the .active class
  // never moves and startJob() keeps reading the first (default) button, which
  // made 語言 / 校對 / 說話人 impossible to change or switch off.
  bindSegmented("langSeg");
  bindSegmented("proofSeg");
  bindSegmented("diarizeSeg");

  // initialize the note to match the default selection on load
  const defaultModel = document.querySelector("#modelSeg .seg-btn.active");
  if (defaultModel) els.modelNote.textContent = MODEL_NOTES[defaultModel.dataset.value] || "";

  /* ---------- file selection ---------- */

  function setFile(file) {
    if (!file) return;
    if (state.running) return;
    state.file = file;
    els.fileName.textContent = file.name;
    els.fileSize.textContent = fmtBytes(file.size);
    els.fileChip.classList.remove("hidden");
    els.dropzone.classList.add("hidden");
    els.errorBox.classList.add("hidden");
    els.transcript.classList.add("hidden");
    // stage only — the job starts when the user presses 開始轉寫
    updateRunActions();
  }

  // 開始轉寫 / 中止 are the only ways to start or stop a run
  function updateRunActions() {
    els.startBtn.classList.toggle("hidden", state.running);
    els.startBtn.disabled = state.running || !state.file;
    els.abortBtn.classList.toggle("hidden", !state.running);
    els.runHint.textContent = state.running
      ? "轉寫進行中…可隨時按「中止」取消"
      : (state.file ? `已選擇「${state.file.name}」— 按「開始轉寫」開始`
                    : "請先選擇音訊檔案");
  }

  els.startBtn.addEventListener("click", () => {
    if (state.file && !state.running) startJob();
  });
  els.abortBtn.addEventListener("click", abortJob);

  els.dropzone.addEventListener("click", () => els.fileInput.click());
  els.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.fileInput.click(); }
  });
  els.fileInput.addEventListener("change", () => {
    if (els.fileInput.files.length) setFile(els.fileInput.files[0]);
  });

  ["dragenter", "dragover"].forEach((ev) =>
    els.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      els.dropzone.classList.add("drag");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    els.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      els.dropzone.classList.remove("drag");
    })
  );
  els.dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
  });

  els.fileRemove.addEventListener("click", () => {
    state.file = null;
    els.fileChip.classList.add("hidden");
    els.dropzone.classList.remove("hidden");
    els.fileInput.value = "";
    updateRunActions();
  });

  /* ---------- job lifecycle ---------- */

  async function startJob() {
    if (!state.file || state.running) return;
    const model = document.querySelector("#modelSeg .seg-btn.active").dataset.value;
    const lang = document.querySelector("#langSeg .seg-btn.active").dataset.value;
    const proof = document.querySelector("#proofSeg .seg-btn.active").dataset.value;
    const diar = document.querySelector("#diarizeSeg .seg-btn.active").dataset.value;
    state.running = true;
    state.text = "";
    state.corrected = null;
    hideChat();   // the previous transcript is gone — the chat goes with it
    resetChat();
    setControlsDisabled(true);
    updateRunActions();
    showProgress("正在上傳音訊…", 0);

    const fd = new FormData();
    fd.append("audio", state.file);
    fd.append("model", model);
    fd.append("language", lang);
    fd.append("proofread", proof);
    fd.append("diarize", diar);

    try {
      const resp = await fetch("/api/transcribe", { method: "POST", body: fd });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "上傳失敗");
      state.jobId = data.job_id;
      poll();
    } catch (err) {
      fail(err.message);
    }
  }

  async function poll() {
    clearTimeout(state.timer);
    if (!state.running || !state.jobId) return;
    try {
      const resp = await fetch("/api/status/" + state.jobId);
      const s = await resp.json();
      if (!state.running) return;  // 中止 pressed while this fetch was in flight
      if (!resp.ok) throw new Error(s.error || "取得狀態失敗");

      if (s.status === "queued" || s.status === "loading") {
        showProgress("正在載入模型…", 3);
        els.progressStatus.textContent = s.status === "queued" ? "排隊中…" : "正在載入最佳模型…";
      } else if (s.status === "proofreading") {
        showProgress("Qwen3 校對中…", 99);
        els.progressFill.classList.add("pulse");
      } else if (s.status === "diarizing") {
        showProgress("說話人分離中…", 99);
        els.progressFill.classList.add("pulse");
      } else if (s.status === "transcribing") {
        showProgress(`正在轉寫 · ${langLabel(s.language)}`, s.progress || 1);
        const lines = (s.text || "").split("\n").filter(Boolean);
        els.transcript.classList.remove("hidden");
        els.transBody.innerHTML = segmentsToHtml(lines);
        els.transBody.scrollTop = els.transBody.scrollHeight;
      } else if (s.status === "cancelling") {
        showProgress("正在中止…", s.progress || 0);
        els.progressFill.classList.add("pulse");
      } else if (s.status === "cancelled") {
        cancelled(s);
        return;
      } else if (s.status === "done") {
        finish(s);
        return;
      } else if (s.status === "error") {
        fail(s.error || "轉寫失敗");
        return;
      }
      if (state.running) state.timer = setTimeout(poll, 700);
    } catch (err) {
      if (state.running) fail(err.message);
    }
  }

  // 中止 — stops polling immediately, then tells the server to drop the job
  async function abortJob() {
    if (!state.running) return;
    const jobId = state.jobId;
    clearTimeout(state.timer);
    state.running = false;  // stops the poll loop even if the POST is slow
    els.abortBtn.disabled = true;
    els.runHint.textContent = "正在中止…";
    try {
      if (jobId) await fetch("/api/cancel/" + jobId, { method: "POST" });
    } catch (e) {
      /* server unreachable — the UI stops anyway */
    }
    state.jobId = null;
    els.abortBtn.disabled = false;
    cancelled(null);
  }

  function cancelled(s) {
    state.running = false;
    clearTimeout(state.timer);
    setControlsDisabled(false);
    if (s && s.text) {
      finish(s);  // keep whatever we already transcribed
      toast("已中止 — 以上為已轉寫部分");
      return;
    }
    els.progress.classList.add("hidden");
    els.progressFill.classList.remove("pulse");
    els.transcript.classList.add("hidden");
    updateRunActions();
    toast("已中止轉寫");
  }

  function finish(s) {
    state.running = false;
    setControlsDisabled(false);
    updateRunActions();
    els.progress.classList.add("hidden");
    els.progressFill.classList.remove("pulse");
    els.transcript.classList.remove("hidden");

    const meta = [
      ["時長", fmtDuration(s.duration)],
      ["語言", langLabel(s.language) + (s.language_probability ? ` · ${Math.round(s.language_probability * 100)}%` : "")],
      ["模型", s.model || "medium"],
      ["片段", String(s.segments_count || 0)],
    ];
    if (s.corrected_text) meta.push(["校對", "Qwen3 ✓"]);
    if (s.speakers) meta.push(["說話人", `${s.speakers} 位`]);
    if (s.diarize && s.diarize_skipped) {
      const reason = s.diarize_skipped === "no_token" ? "未執行（缺 token）" : `分離失敗（${s.diarize_skipped}）`;
      meta.push(["說話人", reason]);
    }
    if (s.status === "cancelled") meta.unshift(["狀態", "已中止 · 部分結果"]);
    els.metaChips.innerHTML = meta
      .map(([k, v]) => `<span class="meta-chip">${k} <strong>${v}</strong></span>`)
      .join("");

    state.text = s.text || "";
    state.segments = s.segments || [];
    state.corrected = s.corrected_text || null;
    state.view = state.corrected ? "corrected" : "raw";

    // 原文 / 校對版 tabs
    els.viewTabs.classList.toggle("hidden", !state.corrected);
    els.viewTabs.querySelectorAll(".seg-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === state.view));

    renderTranscript();

    els.copyBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(currentText()); toast("已複製全文"); }
      catch (e) { toast("複製失敗，請手動選擇"); }
    };
    // downloads are generated in the browser from the transcript we already
    // have — they always work, even after a server restart
    els.dlTxt.onclick = () => clientDownload("txt");
    els.dlSrt.onclick = () => clientDownload("srt");
    els.dlVtt.onclick = () => clientDownload("vtt");

    // the chat runs on whatever text is on screen — start each job's clean
    if (currentText().trim()) {
      resetChat();
      showChat();
    } else {
      hideChat();
    }
  }

  function currentText() {
    return state.view === "corrected" && state.corrected ? state.corrected : state.text;
  }

  function renderTranscript() {
    const lines = currentText().split("\n").filter(Boolean);
    els.transBody.innerHTML = segmentsToHtml(lines);
    els.transBody.scrollTop = els.transBody.scrollHeight;
  }

  // view tab switching (原文 / 校對版)
  els.viewTabs.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn || btn.dataset.view === state.view) return;
    state.view = btn.dataset.view;
    els.viewTabs.querySelectorAll(".seg-btn").forEach((b) =>
      b.classList.toggle("active", b === btn));
    renderTranscript();
  });

  /* ---------- client-side downloads ---------- */

  function clientDownload(fmt) {
    if (fmt === "txt") {
      saveBlob(new Blob([currentText()], { type: "text/plain;charset=utf-8" }), nameFor("txt"));
      return;
    }
    if (!state.segments.length) {  // very old session — fall back to server
      if (state.jobId) serverDownload(state.jobId, fmt);
      else toast("沒有可下載的內容");
      return;
    }
    const mime = fmt === "srt" ? "application/x-subrip" : "text/vtt;charset=utf-8";
    const body = fmt === "srt"
      ? state.segments.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`).join("\n")
      : "WEBVTT\n\n" + state.segments.map((s) => `${vttTime(s.start)} --> ${vttTime(s.end)}\n${s.text}`).join("\n\n");
    saveBlob(new Blob([body], { type: mime }), nameFor(fmt));
  }

  function nameFor(fmt) {
    const stem = (state.file && state.file.name.replace(/\.[^.]+$/, "")) || "transcript";
    return `${stem}.${fmt}`;
  }

  function srtTime(t) {
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${(t % 60).toFixed(3).replace(".", ",")}`;
  }

  function vttTime(t) {
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${(t % 60).toFixed(3)}`;
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function serverDownload(jobId, fmt) {
    const a = document.createElement("a");
    a.href = `/api/download/${jobId}/${fmt}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function fail(msg) {
    state.running = false;
    setControlsDisabled(false);
    updateRunActions();
    els.progress.classList.add("hidden");
    els.errorText.textContent = msg;
    els.errorBox.classList.remove("hidden");
  }

  function showProgress(status, pct) {
    els.progress.classList.remove("hidden");
    els.progressStatus.textContent = status;
    els.progressPct.textContent = Math.round(pct) + "%";
    els.progressFill.style.width = Math.min(100, Math.max(0, pct)) + "%";
  }

  function setControlsDisabled(disabled) {
    els.dropzone.dataset.disabled = disabled ? "1" : "0";
    els.fileRemove.disabled = disabled;
    els.dropzone.style.pointerEvents = disabled ? "none" : "auto";
    els.controls.style.opacity = disabled ? .5 : 1;
    els.controls.style.pointerEvents = disabled ? "none" : "auto";
  }

  /* ---------- transcript chat (會議記錄) ---------- */
  // The transcript is not stored server-side: each request carries the text
  // currently on screen (校對版 or 原文) and the browser streams the answer back.

  const CHAT_PREFILL =
    "請根據以上逐字稿生成會議記錄，包括：會議主題、出席者、討論重點、決議事項、待辦事項（負責人／期限）。用繁體中文、重點條列。";

  const chat = { history: [], streaming: false, abort: null };

  function showChat() { els.chat.classList.remove("hidden"); }
  function hideChat() { els.chat.classList.add("hidden"); }

  function resetChat() {
    if (chat.abort) { try { chat.abort.abort(); } catch (e) { /* already done */ } }
    chat.history = [];
    chat.streaming = false;
    chat.abort = null;
    els.chatLog.innerHTML = "";
    els.chatWarn.classList.add("hidden");
    els.chatWarn.textContent = "";
    els.chatInput.value = CHAT_PREFILL;
    els.chatInput.disabled = false;
    els.chatSend.disabled = false;
    els.chatStop.classList.add("hidden");
  }

  // model output is text — escape it first, then light-touch the handful of
  // markers Qwen actually emits (bold, headings, inline code)
  function chatFormat(text) {
    const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return esc
      .replace(/^#{1,6}\s*(.+)$/gm, "$1")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function chatBubble(role, text) {
    const row = document.createElement("div");
    row.className = "chat-row " + role;
    const who = document.createElement("span");
    who.className = "chat-who";
    who.textContent = role === "user" ? "你" : "Qwen3";
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    bubble.textContent = text;
    row.append(who, bubble);
    els.chatLog.appendChild(row);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
    return bubble;
  }

  function chatBusy(busy) {
    chat.streaming = busy;
    els.chatSend.disabled = busy;
    els.chatInput.disabled = busy;
    els.chatStop.classList.toggle("hidden", !busy);
  }

  function showChatMeta(meta) {
    if (meta.model) els.chatSub.textContent = meta.model + " · 逐字稿會自動附上";
    if (meta.truncated) {
      els.chatWarn.textContent =
        `逐字稿過長：只取頭尾約 ${meta.chars.toLocaleString()} 字，中段 ${meta.omitted.toLocaleString()} 字已省略。` +
        "要完整內容，請分開轉寫，或在 config.json 調高 chat_num_ctx。";
      els.chatWarn.classList.remove("hidden");
    } else {
      els.chatWarn.classList.add("hidden");
    }
  }

  async function sendChat() {
    if (chat.streaming) return;
    const prompt = els.chatInput.value.trim();
    if (!prompt) { toast("請先輸入指令"); return; }
    const transcript = currentText().trim();
    if (!transcript) { toast("還沒有逐字稿可以對話"); return; }

    els.chatInput.value = "";
    chatBubble("user", prompt);
    chat.history.push({ role: "user", content: prompt });

    const bubble = chatBubble("assistant", "");
    bubble.classList.add("streaming");
    chatBusy(true);

    let acc = "";
    const ctrl = new AbortController();
    chat.abort = ctrl;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: chat.history, text: transcript }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        let msg = "HTTP " + res.status;
        try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) { /* not json */ }
        throw new Error(msg);
      }

      // server-sent events: one JSON object per "data:" line
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop();
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
          if (ev.meta) showChatMeta(ev.meta);
          else if (ev.delta) {
            acc += ev.delta;
            bubble.innerHTML = chatFormat(acc);
            els.chatLog.scrollTop = els.chatLog.scrollHeight;
          } else if (ev.error) {
            throw new Error(ev.error);
          }
        }
      }
      if (!acc.trim()) acc = "（模型沒有回應）";
      bubble.innerHTML = chatFormat(acc);
    } catch (err) {
      const stopped = err && err.name === "AbortError";
      acc += (acc ? "\n\n" : "") + (stopped ? "（已停止）" : "⚠️ " + (err.message || "生成失敗"));
      bubble.innerHTML = chatFormat(acc);
    } finally {
      bubble.classList.remove("streaming");
      chatBusy(false);
      chat.abort = null;
      // a stopped answer is kept as-is — the next question can build on it
      if (acc.trim()) chat.history.push({ role: "assistant", content: acc });
    }
  }

  els.chatSend.addEventListener("click", sendChat);
  els.chatStop.addEventListener("click", () => {
    if (chat.abort) { try { chat.abort.abort(); } catch (e) { /* already done */ } }
  });
  els.chatClear.addEventListener("click", () => { resetChat(); toast("已清除對話"); });
  els.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  /* ---------- reset ---------- */

  els.resetBtn.addEventListener("click", () => {
    clearTimeout(state.timer);
    state.running = false;
    state.jobId = null;
    state.file = null;
    state.text = "";
    state.corrected = null;
    state.segments = [];
    state.view = "raw";
    els.viewTabs.classList.add("hidden");
    setControlsDisabled(false);
    els.fileChip.classList.add("hidden");
    els.dropzone.classList.remove("hidden");
    els.progress.classList.add("hidden");
    els.transcript.classList.add("hidden");
    els.errorBox.classList.add("hidden");
    els.fileInput.value = "";
    hideChat();
    resetChat();
    updateRunActions();
  });

  resetChat();   // prefill the meeting-notes prompt
  updateRunActions();
  checkHealth();
})();