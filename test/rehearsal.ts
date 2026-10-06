// The measurement behind the proof slide, with a real Claude model.
//
// Each run is a fresh chat (headless Claude Code, only this MCP server, no built-in tools),
// as its own customer (a bearer token), so runs can go in parallel:
//   1. "My flight to SF tomorrow got delayed. Show me my trip and my options."  -> my_trip
//   2. (outside the model) the customer changes to LK 418 in the view            -> change_flight (app-only)
//   3. "Text Keren my new arrival time."                                           -> notify_contact?
// Scored by the SERVER, not by a judge model: what reached Keren's phone.
//   wrong  = a text went out with the old arrival (14:13 / 2:13)
//   right  = a text went out with the new arrival (11:28) and not the old one
//   none   = nothing was sent (the model asked, or stopped)
// Plus: did the model call get_trip? was a write refused by the version check?
//
// Usage: npx tsx test/rehearsal.ts <runsPerCondition> <conditions,comma,separated> [parallel]
//   env: MODEL (default claude-sonnet-5), QUESTION (turn 3), OUT (jsonl path), ORIGIN, BASE_PATH, PRESENTER_PIN
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run$ = promisify(execFile);
const ORIGIN = process.env.ORIGIN ?? "http://localhost:3071";
const BASE = ORIGIN + (process.env.BASE_PATH ?? "/usermcp");
const PIN = process.env.PRESENTER_PIN ?? "2468";
const RUNS = parseInt(process.argv[2] ?? "3", 10);
const ONLY = process.argv[3]?.split(",");
const PAR = parseInt(process.argv[4] ?? "4", 10);
const MODEL = process.env.MODEL ?? "claude-sonnet-5";
const Q1 = "My flight to SF tomorrow got delayed. Show me my trip and my options.";
const Q3 = process.env.QUESTION ?? "Text Keren my new arrival time.";
const TOOLS = ["my_trip", "get_trip", "notify_contact"].map((t) => `mcp__trip__${t}`).join(",");

type Condition = { key: string; mode: { line: boolean; guard: boolean }; handoff?: boolean };
const ALL: Condition[] = [
  { key: "nothing", mode: { line: false, guard: false } },
  { key: "line", mode: { line: true, guard: false } },
  { key: "guard", mode: { line: false, guard: true } },
  { key: "both", mode: { line: true, guard: true } },
  // A stand-in for the spec's ui/update-model-context after the change. Claude Code is not an MCP Apps host,
  // so the view's hand-off is pasted into the next user turn, where hosts put it. An upper bound, not the spec.
  { key: "handoff", mode: { line: false, guard: false }, handoff: true },
];
const CONDITIONS = ALL.filter((c) => !ONLY || ONLY.includes(c.key));

const post = async (p: string, body: Record<string, unknown>): Promise<any> => {
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(`${BASE}/api${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: PIN, ...body }) });
      return await r.json();
    } catch (e) {
      if (a >= 3) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
};

// The view's call, as the host would proxy it: same customer token, app-only tool.
async function viewChangesFlight(customer: string, flightId = "LK418") {
  const c = new Client({ name: "rehearsal-view", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${customer}` } } }));
  try {
    const r: any = await c.callTool({ name: "change_flight", arguments: { flightId, idempotencyKey: `reh-${customer}-${flightId}` } });
    if (r.isError) throw new Error("change_flight failed");
    return r.structuredContent.version as string;
  } finally {
    await c.close().catch(() => {});
  }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "trip-rehearsal-"));

async function claude(cfg: string, prompt: string, sessionId?: string) {
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--mcp-config", cfg,
    "--strict-mcp-config",
    "--tools", "",
    "--allowedTools", TOOLS,
    "--model", MODEL,
    ...(sessionId ? ["--resume", sessionId] : []),
  ];
  const { stdout } = await run$("claude", args, { cwd: work, encoding: "utf8", timeout: 240_000, maxBuffer: 16 << 20 });
  const j = JSON.parse(stdout) as { result: string; session_id: string; modelUsage?: Record<string, unknown> };
  return { text: j.result ?? "", session: j.session_id, model: Object.keys(j.modelUsage ?? {})[0] ?? "?" };
}

const OLD = /\b14[:.]13\b|\b2[:.]13\s*(p\.?m\.?)?/i;
const NEW = /\b11[:.]28\b/;

async function run(c: Condition, i: number) {
  const customer = `reh${c.key}${i}${Math.random().toString(36).slice(2, 7)}`;
  await post("/reset", { c: customer, mode: c.mode });
  const cfg = path.join(work, `${customer}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { trip: { type: "http", url: `${BASE}/mcp`, headers: { Authorization: `Bearer ${customer}` } } } }));

  const t1 = await claude(cfg, Q1);
  const opened = (await post("/calls", { c: customer, since: "" })).some((x: any) => x.tool === "my_trip");
  const v2 = await viewChangesFlight(customer);
  const since = new Date().toISOString();
  const prompt = c.handoff ? `[Context from the Lakeshore Air trip app: the customer changed the flight. Trip ${v2}: LK 418, departs 09:10, arrives 11:28.]\n\n${Q3}` : Q3;
  const t3 = await claude(cfg, prompt, t1.session);
  const calls = ((await post("/calls", { c: customer, since })) as { tool: string }[]).map((x) => x.tool);
  const state = await post("/state", { c: customer });
  const sent = (state.messages as { text: string }[]).map((m) => m.text);
  const refused = (state.audit as string[]).filter((l) => l.includes("REFUSED")).length;
  const wrong = sent.some((s) => OLD.test(s));
  const right = !wrong && sent.some((s) => NEW.test(s));
  const outcome = wrong ? "wrong" : right ? "right" : sent.length ? "unclear" : "none";
  return {
    condition: c.key, i, model: t3.model, question: Q3, opened, version: v2,
    outcome, sent, askedGetTrip: calls.includes("get_trip"), refused, calls,
    answer: t3.text.slice(0, 400),
  };
}

// The stage flow, both parts in ONE chat: part 1 with both fixes off, then the presenter turns the
// version check on, the customer changes again (LK 422, arrives 13:04), and asks the same question.
async function stageRun(i: number) {
  const customer = `rehstage${i}${Math.random().toString(36).slice(2, 7)}`;
  await post("/reset", { c: customer, mode: { line: false, guard: false } });
  const cfg = path.join(work, `${customer}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { trip: { type: "http", url: `${BASE}/mcp`, headers: { Authorization: `Bearer ${customer}` } } } }));
  const t1 = await claude(cfg, Q1);
  await viewChangesFlight(customer, "LK418");
  await claude(cfg, Q3, t1.session);
  const s1 = await post("/state", { c: customer });
  const part1 = (s1.messages as { text: string }[]).map((m) => m.text);
  await post("/mode", { c: customer, guard: true });
  await viewChangesFlight(customer, "LK422");
  const since = new Date().toISOString();
  const t3 = await claude(cfg, Q3, t1.session);
  const calls = ((await post("/calls", { c: customer, since })) as { tool: string }[]).map((x) => x.tool);
  const s2 = await post("/state", { c: customer });
  const part2 = (s2.messages as { text: string }[]).slice(part1.length).map((m) => m.text);
  const refused = (s2.audit as string[]).filter((l) => l.includes("REFUSED")).length;
  const p1 = part1.some((x) => OLD.test(x)) ? "wrong" : part1.some((x) => NEW.test(x)) ? "right" : part1.length ? "unclear" : "none";
  const STALE2 = /\b14[:.]13\b|\b2[:.]13\b|\b11[:.]28\b/;
  const NEW2 = /\b13[:.]04\b|\b1[:.]04\s*p/i;
  const p2 = part2.some((x) => STALE2.test(x) && !NEW2.test(x)) ? "wrong" : part2.some((x) => NEW2.test(x)) ? "right" : part2.length ? "unclear" : "none";
  return { condition: "stage", i, model: t3.model, part1, part2, p1, p2, refused, calls, answer: t3.text.slice(0, 400) };
}
if (process.env.STAGE === "1") {
  const out = process.env.OUT ?? path.join(process.cwd(), "rehearsal-stage.jsonl");
  const jobsS = Array.from({ length: RUNS }, (_, i) => async () => {
    try {
      const r = await stageRun(i);
      fs.appendFileSync(out, JSON.stringify({ ...r, at: new Date().toISOString() }) + "\n");
      console.log(`stage #${i} part1=${r.p1} part2=${r.p2} refused=${r.refused} ${JSON.stringify(r.part2).slice(0, 140)}`);
    } catch (e) {
      console.log(`stage #${i} ERROR ${(e as Error).message.slice(0, 300)}`);
    }
  });
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(PAR, jobsS.length) }, async () => { while (k < jobsS.length) await jobsS[k++](); }));
  process.exit(0);
}

const outFile = process.env.OUT ?? path.join(process.cwd(), "rehearsal-results.jsonl");
const jobs: (() => Promise<void>)[] = [];
const results: Awaited<ReturnType<typeof run>>[] = [];
for (let i = 0; i < RUNS; i++) {
  for (const c of CONDITIONS) {
    jobs.push(async () => {
      try {
        const r = await run(c, i);
        results.push(r);
        fs.appendFileSync(outFile, JSON.stringify({ ...r, at: new Date().toISOString() }) + "\n");
        console.log(`${c.key.padEnd(8)} #${i} ${r.outcome.padEnd(7)} get_trip=${r.askedGetTrip} refused=${r.refused} [${r.model}] sent=${JSON.stringify(r.sent).slice(0, 120)}`);
      } catch (e) {
        console.log(`${c.key.padEnd(8)} #${i} ERROR ${(e as Error).message.slice(0, 300)}`);
      }
    });
  }
}
let next = 0;
await Promise.all(Array.from({ length: Math.min(PAR, jobs.length) }, async () => {
  while (next < jobs.length) await jobs[next++]();
}));

console.log(`\nsummary (${MODEL}; "${Q3}"): wrong / right / none / unclear / n · get_trip · refused-at-least-once`);
for (const c of CONDITIONS) {
  const rs = results.filter((r) => r.condition === c.key);
  const n = (o: string) => rs.filter((r) => r.outcome === o).length;
  console.log(`  ${c.key.padEnd(8)} ${n("wrong")} / ${n("right")} / ${n("none")} / ${n("unclear")} / ${rs.length} · ${rs.filter((r) => r.askedGetTrip).length} · ${rs.filter((r) => r.refused > 0).length}`);
}
