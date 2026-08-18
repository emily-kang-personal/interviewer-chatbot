/* The Mock Interview — client */
const $ = (id) => document.getElementById(id);
const views = { select: $("viewSelect"), interview: $("viewInterview"), summary: $("viewSummary") };
const thread = $("thread");
const input = $("answerInput");
const sendBtn = $("sendBtn");
const micBtn = $("micBtn");

let sessionId = null;
let awaiting = false;

function show(name) {
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: "Bad response" }));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function addQuestion(text, index, total, isFollowUp) {
  const block = el("div", "q-block");
  block.appendChild(el("span", "q-label mono", isFollowUp ? "Follow-up" : `Question ${index + 1} of ${total}`));
  block.appendChild(el("p", "q-text" + (isFollowUp ? " followup" : ""), esc(text)));
  thread.appendChild(block);
  if (!isFollowUp) {
    $("qNow").textContent = index + 1;
    $("qTotal").textContent = total;
  }
  block.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function addAnswer(text) {
  thread.appendChild(el("div", "a-block", esc(text)));
}

function addThinking() {
  const t = el("div", "thinking", `<span class="dot"></span><span class="dot"></span><span class="dot"></span> the coach is reviewing your answer`);
  thread.appendChild(t);
  t.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return t;
}

function addError(msg) {
  thread.appendChild(el("div", "error-note", esc(msg)));
}

function pips(n) {
  let h = '<span class="pips">';
  for (let i = 1; i <= 5; i++) h += `<span class="pip${i <= n ? " on" + (n <= 2 ? " hot" : "") : ""}"></span>`;
  return h + "</span>";
}

function addFeedback(fb) {
  const card = el("div", "fb-card");
  let avg = "";
  if (fb.scores) {
    const vals = Object.values(fb.scores);
    avg = `<span class="fb-avg mono">${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)} / 5</span>`;
  }
  let html = `<div class="fb-head"><span class="fb-title">Coach’s scorecard</span>${avg}</div>`;
  if (fb.scores) {
    html += '<div class="scores">';
    for (const [k, v] of Object.entries(fb.scores)) {
      html += `<div class="score-row"><span class="score-name">${esc(k)}</span>${pips(v)}</div>`;
    }
    html += "</div>";
  }
  if (fb.strengths?.length || fb.improvements?.length) {
    html += `<div class="fb-lists">
      <div class="plus"><h4>Worked</h4><ul>${(fb.strengths || []).map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>
      <div class="delta"><h4>Sharpen</h4><ul>${(fb.improvements || []).map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>
    </div>`;
  }
  if (fb.comment) html += `<p class="fb-comment">${esc(fb.comment)}</p>`;
  card.innerHTML = html;
  thread.appendChild(card);
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---- flow ----
document.querySelectorAll(".track-card").forEach((btn) =>
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const data = await api("/api/start", { track: btn.dataset.track });
      sessionId = data.sessionId;
      show("interview");
      $("progressChip").hidden = false;
      addQuestion(data.question, data.index, data.total, false);
      input.focus();
    } catch (e) {
      alert(e.message);
      btn.disabled = false;
    }
  })
);

async function submit() {
  const answer = input.value.trim();
  if (!answer || awaiting) return;
  awaiting = true;
  sendBtn.disabled = true;
  stopMic();
  addAnswer(answer);
  input.value = "";
  const thinking = addThinking();
  try {
    const data = await api("/api/answer", { sessionId, answer });
    thinking.remove();
    if (data.followUp) {
      addQuestion(data.followUp, 0, 0, true);
    } else {
      addFeedback(data.feedback || {});
      if (data.done) return finish();
      setTimeout(() => addQuestion(data.question, data.index, data.total, false), 500);
    }
  } catch (e) {
    thinking.remove();
    addError(e.message);
    input.value = answer; // let them retry
  } finally {
    awaiting = false;
    sendBtn.disabled = false;
    input.focus();
  }
}
sendBtn.addEventListener("click", submit);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
});

async function finish() {
  $("answerDesk").style.display = "none";
  const thinking = addThinking();
  thinking.lastChild.textContent = " compiling your session report";
  try {
    const { summary } = await api("/api/summary", { sessionId });
    thinking.remove();
    renderSummary(summary);
    show("summary");
    $("progressChip").hidden = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (e) {
    thinking.remove();
    addError(e.message);
  }
}

function renderSummary(s) {
  const report = $("report");
  const pq = (s.per_question || [])
    .map(
      (p, i) => `<div class="pq"><span class="pq-score">${esc(p.score ?? "–")}/5</span>
        <div><div class="pq-q">${esc(s.questions?.[i] || `Question ${i + 1}`)}</div>
        <div class="pq-note">${esc(p.note || "")}</div></div></div>`
    )
    .join("");
  report.innerHTML = `
    <div class="report-head">
      <h2 class="report-headline">${esc(s.headline || "Session complete.")}</h2>
      <div class="readiness"><div class="big">${esc(s.readiness ?? "–")}</div><div class="of mono">readiness / 5</div></div>
    </div>
    <div class="report-cols">
      <div class="plus"><h3>Strengths</h3><ul>${(s.strengths || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
      <div class="delta"><h3>Growth areas</h3><ul>${(s.growth_areas || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
    </div>
    ${pq}`;
}

$("againBtn").addEventListener("click", () => location.reload());

// ---- mic (Web Speech API) ----
let rec = null;
let recLive = false;
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  micBtn.hidden = false;
  $("micHint").textContent = "⌘↵ to submit · mic appends as you speak";
  rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  let base = "";
  rec.onstart = () => {
    base = input.value ? input.value + " " : "";
    micBtn.classList.add("live");
    micBtn.textContent = "■ STOP";
    recLive = true;
  };
  rec.onresult = (e) => {
    let text = "";
    for (const r of e.results) text += r[0].transcript;
    input.value = base + text;
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed") $("micHint").textContent = "Mic permission denied — type instead.";
    stopMic();
  };
  rec.onend = () => stopMic();
  micBtn.addEventListener("click", () => (recLive ? rec.stop() : rec.start()));
} else {
  $("micHint").textContent = "⌘↵ to submit · voice input needs Chrome/Safari/Edge";
}
function stopMic() {
  if (!recLive) return;
  recLive = false;
  micBtn.classList.remove("live");
  micBtn.textContent = "● REC";
  try { rec.stop(); } catch {}
}
