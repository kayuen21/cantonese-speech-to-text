// Unit check for the chat bubble formatter lifted out of static/app.js:
// markdown-ish output renders, and model output can never inject HTML.
import fs from "node:fs";

const src = fs.readFileSync("static/app.js", "utf8");
const body = src.match(/function chatFormat\(text\) \{[\s\S]*?\n  \}/);
if (!body) { console.log("FAIL  chatFormat not found in app.js"); process.exit(1); }
const chatFormat = new Function("return " + body[0].replace("function ", "function "))();

const cases = [
  ["**會議記錄**", "<strong>會議記錄</strong>", "bold"],
  ["### 主題\n- **出席者**：亞明", "主題\n- <strong>出席者</strong>：亞明", "heading stripped + bold"],
  ["- 待辦：寫 `report`", "- 待辦：寫 <code>report</code>", "inline code"],
  ["<script>alert(1)</script>", "&lt;script&gt;alert(1)&lt;/script&gt;", "html escaped"],
  ["<img src=x onerror=alert(1)>", "&lt;img src=x onerror=alert(1)&gt;", "no tag injection"],
  ["a & b", "a &amp; b", "ampersand"],
];

let bad = 0;
for (const [input, want, name] of cases) {
  const got = chatFormat(input);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
}
console.log(bad === 0 ? "\nALL FORMAT CHECKS PASSED" : `\n${bad} FORMAT CHECK(S) FAILED`);
process.exit(bad === 0 ? 0 : 1);
