// e2e_chat.mjs — drives the real page in headless Chrome:
// stage a file → 開始轉寫 → wait for the transcript → the 會議記錄 chatbox must
// appear prefilled, and a question must come back streamed from the local LLM.
import path from "node:path";

const BASE = "http://127.0.0.1:5000";
const CDP = "http://127.0.0.1:9333";
const WAV = path.resolve("test_2speaker.wav");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, extra = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
}

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(CDP + "/json/list")).json();
      const page = list.find((t) => t.type === "page" && t.url.includes("127.0.0.1:5000"))
        || list.find((t) => t.type === "page");
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("CDP target never appeared");
}

class Session {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

const ws = new WebSocket(await findTarget());
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});
const s = new Session(ws);
await s.send("Page.enable");
await s.send("DOM.enable");
await s.send("Runtime.enable");

console.log("== page load ==");
await s.send("Page.navigate", { url: `${BASE}/?t=${Date.now()}` });
await sleep(2500);

const assets = await s.eval("[...document.querySelectorAll('script[src],link[href]')].map(e => e.getAttribute('src') || e.getAttribute('href')).join(' ')");
check("serves app.js?v=12", /app\.js\?v=12/.test(assets));
check("serves style.css?v=7", /style\.css\?v=7/.test(assets));

console.log("== before any transcript ==");
check("chatbox is hidden", await s.eval("document.getElementById('chat').classList.contains('hidden')"));
const prefill = await s.eval("document.getElementById('chatInput').value");
check("prompt is already in the box", prefill.includes("會議記錄") && prefill.length > 20, prefill.slice(0, 24) + "…");

console.log("== stage the file (no auto-start) ==");
const doc = await s.send("DOM.getDocument");
const input = await s.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#fileInput" });
await s.send("DOM.setFileInputFiles", { files: [WAV], nodeId: input.nodeId });
await sleep(800);
check("file staged", (await s.eval("document.getElementById('fileInput').files.length")) === 1,
  await s.eval("document.getElementById('fileName').textContent"));
check("still idle — upload did not start",
  await s.eval("document.getElementById('chat').classList.contains('hidden') && document.getElementById('progress').classList.contains('hidden')"));

console.log("== fast config, then start ==");
await s.eval("document.querySelectorAll('#proofSeg .seg-btn')[1].click(); document.querySelectorAll('#diarizeSeg .seg-btn')[1].click();");
await sleep(300);
await s.eval("document.getElementById('startBtn').click()");

let done = false, lastStatus = "";
const t0 = Date.now();
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  const st = await s.eval("document.getElementById('progressStatus').textContent");
  if (st !== lastStatus) { lastStatus = st; console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${st}`); }
  const err = await s.eval("document.getElementById('errorBox').classList.contains('hidden') ? '' : document.getElementById('errorText').textContent");
  if (err) { check("transcription finished", false, err); break; }
  done = await s.eval("!document.getElementById('chat').classList.contains('hidden')");
  if (done) break;
}
check("transcription finished → chatbox revealed", done, `${((Date.now() - t0) / 1000).toFixed(0)}s`);
const txt = await s.eval("document.getElementById('transBody').textContent.trim()");
check("transcript has text", txt.length > 20, `${txt.length} chars`);

console.log("== ask for the meeting notes ==");
check("box still holds the 會議記錄 prompt", (await s.eval("document.getElementById('chatInput').value")).includes("會議記錄"));
await s.eval("document.getElementById('chatSend').click()");
await sleep(1500);
check("user bubble rendered", (await s.eval("document.querySelectorAll('.chat-row.user').length")) === 1);
check("stop button offered while streaming", !(await s.eval("document.getElementById('chatStop').classList.contains('hidden')")));

let prev = -1, stable = 0, answer = "";
const t1 = Date.now();
for (let i = 0; i < 150; i++) {
  await sleep(2000);
  answer = await s.eval("(() => { const b = document.querySelectorAll('.chat-row.assistant .chat-bubble'); return b.length ? b[b.length - 1].textContent : ''; })()");
  if (answer.length === prev && answer.length > 40) { stable++; if (stable >= 2) break; } else stable = 0;
  prev = answer.length;
  if (i % 4 === 0) console.log(`  [${((Date.now() - t1) / 1000).toFixed(0)}s] streaming… ${answer.length} chars`);
}
check("streamed a full answer", answer.length > 300, `${answer.length} chars in ${((Date.now() - t1) / 1000).toFixed(0)}s`);
check("answer looks like 會議記錄", /會議|討論|決議|待辦|出席/.test(answer));
check("stop button hidden again", await s.eval("document.getElementById('chatStop').classList.contains('hidden')"));
console.log("---- answer preview ----");
console.log(answer.slice(0, 800));

console.log("== follow-up turn (transcript still in context) ==");
await s.eval("document.getElementById('chatInput').value = '用一句話總結這次會議。'");
await s.eval("document.getElementById('chatSend').click()");
let prev2 = -1, stable2 = 0, answer2 = "";
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  answer2 = await s.eval("(() => { const b = document.querySelectorAll('.chat-row.assistant .chat-bubble'); return b.length > 1 ? b[b.length - 1].textContent : ''; })()");
  if (answer2.length === prev2 && answer2.length > 1) { stable2++; if (stable2 >= 2) break; } else stable2 = 0;
  prev2 = answer2.length;
}
check("follow-up answered", answer2.length > 5, JSON.stringify(answer2.slice(0, 140)));
check("conversation kept both turns", (await s.eval("document.querySelectorAll('.chat-row').length")) >= 4);

ws.close();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
