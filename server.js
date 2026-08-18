import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- env (.env loader, no deps) ----
const envPath = path.join(__dirname, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) throw new Error("OPENROUTER_API_KEY required — this server does not start without it");

const MODEL = process.env.MODEL || "deepseek/deepseek-v4-flash";
const PORT = Number(process.env.PORT || 3000);
const SPEND_LIMIT_USD = Number(process.env.SPEND_LIMIT_USD || 0.5); // hard budget for the whole process
const QUESTIONS_PER_SESSION = Number(process.env.QUESTIONS_PER_SESSION || 4);
const MAX_ANSWER_CHARS = 4000;

const bank = JSON.parse(readFileSync(path.join(__dirname, "questions.json"), "utf8"));

// ---- in-memory state (demo scope: single instance) ----
const sessions = new Map(); // id -> {track, questions[], idx, followUpUsed, transcript[], done, createdAt}
let totalSpendUSD = 0;
let totalCalls = 0;

// per-IP sliding-window rate limit: 20 requests / 5 min
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 20;
}

// evict sessions older than 1h
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, s] of sessions) if (s.createdAt < cutoff) sessions.delete(id);
}, 10 * 60 * 1000).unref();

// ---- LLM ----
async function llm(messages, maxTokens) {
  if (totalSpendUSD >= SPEND_LIMIT_USD) {
    const err = new Error("Demo budget exhausted");
    err.status = 503;
    throw err;
  }
  let data;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: AbortSignal.timeout(45_000),
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: maxTokens,
          temperature: 0.4,
          messages,
          usage: { include: true },
          provider: { sort: "throughput" }, // cheapest providers for this model are sometimes 60s+ slow
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw Object.assign(new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`), { retryable: true });
      }
      data = await res.json();
      totalCalls++;
      if (data.usage?.cost) totalSpendUSD += data.usage.cost;
      console.log(`[llm] call#${totalCalls} tokens=${data.usage?.total_tokens} cost=$${(data.usage?.cost ?? 0).toFixed(6)} total=$${totalSpendUSD.toFixed(4)}`);
      const content = data.choices?.[0]?.message?.content;
      if (typeof content === "string" && content.trim()) return content;
      // some providers return null content (reasoning-only) — retry once
      throw Object.assign(new Error("empty completion content"), { retryable: true });
    } catch (e) {
      if (attempt >= 2) {
        if (!e.status) e.status = 502;
        throw e;
      }
      console.warn(`[llm] attempt ${attempt} failed (${e.message.slice(0, 80)}), retrying`);
    }
  }
}

function parseJSON(text) {
  // models sometimes fence their JSON; strip and grab the outermost object
  const stripped = text.replace(/```(?:json)?/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in response");
  return JSON.parse(stripped.slice(start, end + 1));
}

const RUBRICS = {
  behavioral: {
    keys: ["situation", "task", "action", "result"],
    desc: "STAR rubric — situation (context set clearly), task (their responsibility clear), action (specific things THEY did), result (concrete outcome, ideally measured)",
  },
  technical: {
    keys: ["correctness", "approach", "communication", "depth"],
    desc: "technical rubric — correctness (factually right), approach (structured problem-solving, clarifies requirements, names tradeoffs), communication (clear, organized explanation), depth (goes beyond surface buzzwords)",
  },
};

function feedbackPrompt(track, item, answer, followUpExchange, followUpAllowed) {
  const r = RUBRICS[track];
  return [
    {
      role: "system",
      content: `You are a warm but rigorous ${track} interview coach. Evaluate the candidate's answer using the ${r.desc}. Interviewer's note on what a strong answer covers: ${item.hint}

Respond with ONLY a JSON object, no prose around it:
{
  "needs_follow_up": boolean,       // true ONLY if ${followUpAllowed ? "one short follow-up question would let the candidate meaningfully improve the answer (e.g. they skipped the result, or stayed vague)" : "false — a follow-up was already asked; you must evaluate now"}
  "follow_up": string or null,      // the follow-up question, conversational, one sentence
  "feedback": {                     // null if needs_follow_up is true, otherwise:
    "scores": { ${r.keys.map((k) => `"${k}": 1-5`).join(", ")} },
    "strengths": [2-3 short specific strings],
    "improvements": [2-3 short specific strings],
    "comment": "2-3 sentence coach's comment, direct and encouraging, referencing what they actually said"
  }
}`,
    },
    {
      role: "user",
      content:
        `Interview question: "${item.q}"\n\nCandidate's answer:\n${answer}` +
        (followUpExchange ? `\n\nFollow-up asked: "${followUpExchange.q}"\nCandidate's follow-up answer:\n${followUpExchange.a}` : ""),
    },
  ];
}

function summaryPrompt(track, transcript) {
  const r = RUBRICS[track];
  return [
    {
      role: "system",
      content: `You are a ${track} interview coach writing an end-of-session report. Use the ${r.desc}.

Respond with ONLY a JSON object:
{
  "readiness": 1-5,                  // overall interview readiness
  "headline": "one-sentence overall verdict, direct but encouraging",
  "strengths": [2-3 strings],
  "growth_areas": [2-3 strings, each with a concrete practice suggestion],
  "per_question": [ { "score": 1-5, "note": "one-sentence note" } ]   // one entry per question, in order
}
Keep every string short — the whole report under 200 words. Output nothing but the JSON.`,
    },
    {
      role: "user",
      content: transcript
        .map(
          (t, i) =>
            `Q${i + 1}: ${t.q}\nAnswer: ${t.answer}` +
            (t.followUp ? `\nFollow-up: ${t.followUp}\nFollow-up answer: ${t.followUpAnswer}` : "") +
            `\nPer-answer scores: ${JSON.stringify(t.feedback?.scores ?? {})}`
        )
        .join("\n\n"),
    },
  ];
}

function pickQuestions(track) {
  const pool = [...bank[track]];
  const out = [];
  while (out.length < QUESTIONS_PER_SESSION && pool.length) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

// ---- routes ----
async function handleApi(req, res, url, body, ip) {
  if (rateLimited(createHash("sha256").update(ip).digest("hex"))) {
    return send(res, 429, { error: "Rate limit reached — this is a demo. Try again in a few minutes." });
  }

  if (url.pathname === "/api/start" && req.method === "POST") {
    const track = body.track === "technical" ? "technical" : "behavioral";
    const id = randomUUID();
    const questions = pickQuestions(track);
    sessions.set(id, { track, questions, idx: 0, followUpUsed: false, pendingFollowUp: null, transcript: [], done: false, createdAt: Date.now() });
    return send(res, 200, { sessionId: id, track, total: questions.length, question: questions[0].q, index: 0 });
  }

  const session = sessions.get(body.sessionId);
  if (!session) return send(res, 404, { error: "Session not found or expired — start a new interview." });
  if (session.busy) return send(res, 409, { error: "Still thinking — hold on." });

  if (url.pathname === "/api/answer" && req.method === "POST") {
    if (session.done) return send(res, 400, { error: "Session is finished." });
    const answer = String(body.answer || "").slice(0, MAX_ANSWER_CHARS).trim();
    if (!answer) return send(res, 400, { error: "Empty answer." });

    const item = session.questions[session.idx];
    session.busy = true;
    try {
      if (session.pendingFollowUp) {
        // this answer responds to the follow-up; evaluate with full exchange
        const exchange = { q: session.pendingFollowUp, a: answer };
        const raw = await llm(feedbackPrompt(session.track, item, session.baseAnswer, exchange, false), 900);
        const parsed = safeFeedback(raw, session.track);
        session.transcript.push({ q: item.q, answer: session.baseAnswer, followUp: exchange.q, followUpAnswer: exchange.a, feedback: parsed.feedback });
        session.pendingFollowUp = null;
        session.baseAnswer = null;
        return send(res, 200, advance(session, parsed.feedback));
      }

      const followUpAllowed = !session.followUpUsed;
      const raw = await llm(feedbackPrompt(session.track, item, answer, null, followUpAllowed), 900);
      const parsed = safeFeedback(raw, session.track);

      if (followUpAllowed && parsed.needs_follow_up && parsed.follow_up) {
        session.followUpUsed = true;
        session.pendingFollowUp = parsed.follow_up;
        session.baseAnswer = answer;
        return send(res, 200, { followUp: parsed.follow_up });
      }

      session.transcript.push({ q: item.q, answer, feedback: parsed.feedback });
      return send(res, 200, advance(session, parsed.feedback));
    } finally {
      session.busy = false;
    }
  }

  if (url.pathname === "/api/summary" && req.method === "POST") {
    if (!session.done) return send(res, 400, { error: "Session not finished yet." });
    session.busy = true;
    try {
      const raw = await llm(summaryPrompt(session.track, session.transcript), 2200);
      let summary;
      try {
        summary = parseJSON(raw);
      } catch {
        summary = { readiness: 3, headline: raw.slice(0, 200), strengths: [], growth_areas: [], per_question: [] };
      }
      summary.questions = session.transcript.map((t) => t.q);
      return send(res, 200, { summary });
    } finally {
      session.busy = false;
    }
  }

  return send(res, 404, { error: "Not found" });
}

function safeFeedback(raw, track) {
  try {
    const parsed = parseJSON(raw);
    if (parsed.feedback?.scores) {
      for (const k of RUBRICS[track].keys) {
        parsed.feedback.scores[k] = Math.min(5, Math.max(1, Number(parsed.feedback.scores[k]) || 3));
      }
    }
    return parsed;
  } catch {
    // fall back to showing the model's text as the coach comment
    return { needs_follow_up: false, follow_up: null, feedback: { scores: null, strengths: [], improvements: [], comment: raw.slice(0, 600) } };
  }
}

function advance(session, feedback) {
  session.idx++;
  session.followUpUsed = false;
  if (session.idx >= session.questions.length) {
    session.done = true;
    return { feedback, done: true };
  }
  return { feedback, question: session.questions[session.idx].q, index: session.idx, total: session.questions.length };
}

// ---- static files ----
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const file = path.join(__dirname, "public", path.normalize(rel));
  if (!file.startsWith(path.join(__dirname, "public")) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
}

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const ip = req.headers["fly-client-ip"] || req.socket.remoteAddress || "unknown";
    try {
      if (url.pathname.startsWith("/api/")) {
        let body = {};
        if (req.method === "POST") {
          const chunks = [];
          let size = 0;
          for await (const c of req) {
            size += c.length;
            if (size > 64 * 1024) throw Object.assign(new Error("Body too large"), { status: 413 });
            chunks.push(c);
          }
          body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        }
        await handleApi(req, res, url, body, ip);
      } else {
        serveStatic(res, url.pathname);
      }
    } catch (e) {
      console.error(`[err] ${req.method} ${url.pathname}: ${e.message}`);
      send(res, e.status || 500, { error: e.status ? e.message : "Something went wrong — try again." });
    }
  })
  .listen(PORT, () => console.log(`interviewer-chatbot on http://localhost:${PORT} model=${MODEL} spend_limit=$${SPEND_LIMIT_USD}`));
