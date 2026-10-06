// One process, everything under one path prefix (BASE_PATH, default "/usermcp"):
//   <base>/mcp       the MCP endpoint (stateless Streamable HTTP)
//   <base>/trip      the airline's own "Manage trip" web page: the customer's app today
//   <base>/phone     Keren's phone: the texts the assistant sends
//   <base>/console   the presenter's switches (PIN)
//   <base>/api/...   JSON for those pages and for the rehearsal harness
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { callLog, createServer, who } from "./server.js";
import { ALTERNATIVES, audit, bump, CONTACTS, FLIGHTS, flightOf, load, ORIGINAL, reset, save } from "./store.js";

const PORT = parseInt(process.env.PORT ?? "3071", 10);
const BASE = ("/" + (process.env.BASE_PATH ?? "/usermcp").replace(/^\/+|\/+$/g, "")).replace(/^\/$/, "");
export const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
// The presenter's PIN (console, reset, rehearsal). Set your own before you put this on a public URL.
const PIN = process.env.PRESENTER_PIN ?? "2468";

const app = createMcpExpressApp({ host: "0.0.0.0" });
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "256kb" }));

// Identity: a demo bearer token is the customer key. Production: validate an OAuth token, use its subject.
const customerOf = (req: Request) => {
  const m = String(req.headers.authorization ?? "").match(/^Bearer\s+([A-Za-z0-9_-]{1,64})$/);
  return m ? m[1] : "stage";
};

const mcpPath = `${BASE}/mcp`;
app.use(mcpPath, (req: Request, _res: Response, next: NextFunction) => {
  const b = req.body as { method?: string; params?: { name?: string } } | undefined;
  const ua = String(req.headers["user-agent"] ?? "").slice(0, 40);
  const c = customerOf(req);
  if (b?.method) console.log(`[mcp ${c}] ${req.method} ${b.method}${b.params?.name ? ` ${b.params.name}` : ""} (${ua})`);
  who.run({ customer: c, ua }, next);
});

// Stateless Streamable HTTP: a fresh server per request; state lives in the store.
const modern = process.env.MCP_ENTRY !== "legacy" ? toNodeHandler(createMcpHandler(createServer)) : null;
if (modern) app.all(mcpPath, (req: Request, res: Response) => void modern(req, res, req.body));
app.all(mcpPath, async (req: Request, res: Response) => {
  const server = createServer();
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP error:", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});

// ---- JSON for the pages ------------------------------------------------------
const api = express.Router();
const c = (req: Request) => String(req.query.c ?? req.body?.c ?? "stage");
const pinOk = (req: Request, res: Response) => {
  if (req.body?.pin === PIN) return true;
  res.status(403).json({ error: "wrong PIN" });
  return false;
};

// The customer's trip, for the airline web page. (Demo: no login. Production: the customer's session.)
api.get("/trip", (req, res) => {
  const t = load(c(req));
  res.set("Cache-Control", "no-store").json({
    ref: t.ref, passenger: t.passenger, date: t.date, from: t.from, to: t.to, seat: t.seat,
    version: t.token, flight: flightOf(t), original: FLIGHTS[ORIGINAL],
    alternatives: ALTERNATIVES.map((id) => FLIGHTS[id]),
    changes: t.changes.map((x) => ({ ...x, fromNumber: FLIGHTS[x.from].number, toNumber: FLIGHTS[x.to].number })),
  });
});

// The web page can change the flight too: same server, same rules, same version bump.
// Demo: the presenter's copy of the page carries the PIN (?pin=), so the audience can't change the stage trip.
// Production: the customer's own session.
api.post("/trip/change", (req, res) => {
  if (!pinOk(req, res)) return;
  const t = load(c(req));
  const id = String(req.body?.flightId ?? "");
  if (!FLIGHTS[id] || id === t.flightId) return void res.status(400).json({ error: "bad flight" });
  const from = t.flightId;
  t.flightId = id;
  bump(t, "web:change");
  t.changes.push({ key: `web-${Date.now()}`, from, to: id, at: new Date().toISOString(), version: t.version });
  audit(t, `web change ${FLIGHTS[from].number} -> ${FLIGHTS[id].number}, trip now ${t.token} (initiator: web page)`);
  save(t);
  res.json({ ok: true, version: t.token });
});

// Keren's phone.
api.get("/messages", (req, res) => {
  const t = load(c(req));
  res.set("Cache-Control", "no-store").json({ from: t.passenger, contact: CONTACTS[0], messages: t.messages.map(({ id, text, at }) => ({ id, text, at })) });
});

// ---- presenter + rehearsal (PIN) ----------------------------------------------
api.post("/reset", (req, res) => {
  if (!pinOk(req, res)) return;
  const t = reset(c(req), req.body?.mode);
  res.json({ ok: true, version: t.token, mode: t.mode });
});
api.post("/mode", (req, res) => {
  if (!pinOk(req, res)) return;
  const t = load(c(req));
  if (typeof req.body?.line === "boolean") t.mode.line = req.body.line;
  if (typeof req.body?.guard === "boolean") t.mode.guard = req.body.guard;
  if (typeof req.body?.handoff === "boolean") t.mode.handoff = req.body.handoff;
  audit(t, `mode line=${t.mode.line} guard=${t.mode.guard} handoff=${Boolean(t.mode.handoff)}`);
  save(t);
  res.json(t.mode);
});
api.post("/state", (req, res) => {
  if (!pinOk(req, res)) return;
  res.json(load(c(req)));
});
api.post("/calls", (req, res) => {
  if (!pinOk(req, res)) return;
  const since = String(req.body?.since ?? "");
  const cust = c(req);
  res.json(callLog.filter((x) => x.customer === cust && x.at >= since));
});

app.use(`${BASE}/api`, api);

// ---- pages ---------------------------------------------------------------------
const pub = path.join(process.cwd(), "public");
app.get(BASE || "/", (_req, res) => res.redirect(`${BASE}/trip`));
app.use(BASE || "/", express.static(pub, { extensions: ["html"], index: false }));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

const http = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Lakeshore Air trip MCP app`);
  console.log(`  MCP:          ${PUBLIC_URL}${BASE}/mcp`);
  console.log(`  airline page: ${PUBLIC_URL}${BASE}/trip`);
  console.log(`  Keren's phone: ${PUBLIC_URL}${BASE}/phone`);
  console.log(`  console:      ${PUBLIC_URL}${BASE}/console`);
});
// Outlive clients' idle sockets (Node's 5 s default races keep-alive reuse and resets connections).
http.keepAliveTimeout = 65_000;
http.headersTimeout = 66_000;
