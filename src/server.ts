// "Manage my trip" as an MCP App, for the customers of a (fictional) airline, Lakeshore Air.
// Plain @modelcontextprotocol/ext-apps 2.x.
//
// Two users share this app:
//   the model  -> my_trip, get_trip, notify_contact
//   the view   -> load_trip, change_flight (app-only: hidden from the model)
// The customer changes the flight in the view. That tools/call result goes back to the view,
// never to the model. So the model's next WRITE (a text to a friend) is built from the old trip.
//
// Two fixes, each behind a switch so the demo and the measurement can compare them:
//   line  - one freshness line in every model-facing result (raises the odds the model re-reads)
//   guard - model writes carry the trip version they were built from; the server refuses an old one
import { AsyncLocalStorage } from "node:async_hooks";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer, type CallToolResult, type ReadResourceResult } from "@modelcontextprotocol/server";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ALTERNATIVES, audit, bump, clock, CONTACTS, FLIGHTS, flightOf, load, newId, ORIGINAL, save, type Trip } from "./store.js";

const VIEW_URI = "ui://lakeshore-air/trip.html";
const DIST = path.join(process.cwd(), "dist", "view", "mcp-app.html");

// Who is calling. In production this is the subject of a validated OAuth token.
// In the demo, a bearer token IS the customer key (no auth = the "stage" customer).
export const who = new AsyncLocalStorage<{ customer: string; ua: string }>();
const customer = () => who.getStore()?.customer ?? "stage";

// Every tool call, for the rehearsal harness: which tools did the model use?
export const callLog: { customer: string; tool: string; at: string }[] = [];
const logCall = (tool: string) => void callLog.push({ customer: customer(), tool, at: new Date().toISOString() });

function fmtFlight(t: Trip) {
  const f = flightOf(t);
  const route = `${t.from.city} (${t.from.code}) to ${t.to.city} (${t.to.code}), ${t.date}`;
  if (f.status === "delayed" && f.scheduled) {
    return `${f.number} ${route}: DELAYED, now departs ${f.departs}, arrives ${f.arrives} (was ${f.scheduled.departs} to ${f.scheduled.arrives}). Seat ${t.seat}.`;
  }
  return `${f.number} ${route}: on time, departs ${f.departs}, arrives ${f.arrives}. Seat ${t.seat}.`;
}

// Fix 1. Server-generated values only: never put user or view text in this line.
function freshLine(t: Trip) {
  return `Trip ${t.token} as of ${clock()}. The customer can change it in the trip view: call get_trip before acting on it.`;
}

// What the model reads, in content AND structuredContent: some hosts show the model only one of them
// (Claude Code shows structuredContent when both are present).
function forModel(t: Trip, text: string, data: Record<string, unknown>): CallToolResult {
  const line = t.mode.line ? freshLine(t) : undefined;
  return {
    content: [{ type: "text", text: line ? `${text}\n${line}` : text }],
    structuredContent: { ...data, tripVersion: t.token, asOf: new Date().toISOString(), ...(line ? { note: line } : {}) },
  };
}

function tripFacts(t: Trip) {
  const f = flightOf(t);
  return {
    ref: t.ref,
    passenger: t.passenger,
    flight: f.number,
    route: `${t.from.code}-${t.to.code}`,
    date: t.date,
    status: f.status,
    departs: f.departs,
    arrives: f.arrives,
    ...(f.scheduled ? { scheduled: f.scheduled } : {}),
    seat: t.seat,
  };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "lakeshore-trip", version: "0.2.0" });

  // ---- the model's tools --------------------------------------------------

  registerAppTool(
    server,
    "my_trip",
    {
      title: "My trip",
      description:
        "Open the customer's upcoming Lakeshore Air trip: flight status, and if the flight is disrupted, the same-day flights they can change to. " +
        "The customer picks and confirms any change in the trip view.",
      inputSchema: z.object({}).strict(),
      _meta: { ui: { resourceUri: VIEW_URI, visibility: ["model", "app"] } },
    },
    async (): Promise<CallToolResult> => {
      logCall("my_trip");
      const t = load(customer());
      const f = flightOf(t);
      const alts = f.status === "delayed" ? ` The trip view shows ${ALTERNATIVES.length} same-day flights with no change fee; the customer chooses and confirms there.` : "";
      return forModel(t, `Trip ${t.ref} for ${t.passenger}, version ${t.token}. ${fmtFlight(t)}${alts}`, {
        ...tripFacts(t),
        alternativesInView: f.status === "delayed" ? ALTERNATIVES.length : 0,
      });
    },
  );

  server.registerTool(
    "get_trip",
    {
      title: "Trip details",
      description: "The customer's current trip as text, read from the airline's booking system. To show the trip to the customer, use my_trip.",
      inputSchema: z.object({}).strict(),
    },
    async (): Promise<CallToolResult> => {
      logCall("get_trip");
      const t = load(customer());
      const last = t.changes.at(-1);
      const changed = last ? ` Changed from ${FLIGHTS[last.from].number} to ${FLIGHTS[last.to].number} at ${clock(new Date(last.at))} in the trip view.` : "";
      return forModel(t, `Trip ${t.ref}, version ${t.token}, as of ${clock()}. ${fmtFlight(t)}${changed}`, {
        ...tripFacts(t),
        ...(last ? { lastChange: { from: FLIGHTS[last.from].number, to: FLIGHTS[last.to].number, at: last.at } } : {}),
      });
    },
  );

  server.registerTool(
    "notify_contact",
    {
      title: "Text a contact",
      description:
        "Send a text message to one of the customer's saved contacts, on the customer's behalf, from Lakeshore Air. " +
        `Saved contacts: ${CONTACTS.map((c) => c.name).join(", ")}.`,
      inputSchema: z
        .object({
          to: z.string().min(1).max(60).describe("The contact's name"),
          message: z.string().min(1).max(320),
          tripVersion: z.string().min(1).max(40).describe("The trip version this message is based on"),
        })
        .strict(),
    },
    async ({ to, message, tripVersion }): Promise<CallToolResult> => {
      logCall("notify_contact");
      const t = load(customer());
      const contact = CONTACTS.find((c) => c.name.toLowerCase().includes(to.trim().toLowerCase()) || to.toLowerCase().includes(c.first.toLowerCase()));
      if (!contact) {
        return { isError: true, content: [{ type: "text", text: `No saved contact called "${to}". Saved contacts: ${CONTACTS.map((c) => c.name).join(", ")}.` }] };
      }
      // Fix 2: the precondition. Like If-Match on an HTTP write: the version is opaque, so it can't be guessed.
      if (t.mode.guard && tripVersion !== t.token) {
        audit(t, `notify_contact REFUSED: built from ${tripVersion}, trip is ${t.token}`);
        save(t);
        const text =
          `Not sent. The trip changed after you read it: your message is based on ${tripVersion}, the trip is now ${t.token}. ` +
          `Now: ${fmtFlight(t)} Rewrite the message from the current trip, then send it again with tripVersion ${t.token}.`;
        return { isError: true, content: [{ type: "text", text }], structuredContent: { sent: false, reason: "stale", current: tripFacts(t), tripVersion: t.token } };
      }
      const m = { id: newId(), to: contact.name, text: message, at: new Date().toISOString(), claimedVersion: tripVersion, currentVersion: t.token };
      t.messages.push(m);
      audit(t, `notify_contact sent to ${contact.name} (built from ${tripVersion}, trip ${t.token}, initiator: model)`);
      save(t);
      return forModel(t, `Sent to ${contact.name} at ${clock()}.`, { sent: true, to: contact.name, at: m.at });
    },
  );

  // ---- the view's tools (app-only: hidden from the model) -----------------

  registerAppTool(
    server,
    "load_trip",
    {
      description: "Trip data for the view: the booking and the flights the customer can change to.",
      inputSchema: z.object({}).strict(),
      _meta: { ui: { resourceUri: VIEW_URI, visibility: ["app"] } },
    },
    async (): Promise<CallToolResult> => {
      logCall("load_trip");
      const t = load(customer());
      const data = {
        ref: t.ref,
        passenger: t.passenger,
        date: t.date,
        from: t.from,
        to: t.to,
        seat: t.seat,
        version: t.token,
        asOf: new Date().toISOString(),
        flight: flightOf(t),
        original: FLIGHTS[ORIGINAL],
        alternatives: ALTERNATIVES.map((id) => FLIGHTS[id]),
        changes: t.changes.map((c) => ({ ...c, fromNumber: FLIGHTS[c.from].number, toNumber: FLIGHTS[c.to].number })),
        handoff: Boolean(t.mode.handoff),
        message: Boolean(t.mode.message),
      };
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
    },
  );

  registerAppTool(
    server,
    "change_flight",
    {
      description: "The customer confirmed a change to another same-day flight. Idempotent per key.",
      inputSchema: z.object({ flightId: z.enum(["LK412", "LK418", "LK422", "LK430"]), idempotencyKey: z.string().min(8).max(80) }).strict(),
      _meta: { ui: { resourceUri: VIEW_URI, visibility: ["app"] } },
    },
    async ({ flightId, idempotencyKey }): Promise<CallToolResult> => {
      logCall("change_flight");
      const t = load(customer());
      const seen = t.changes.find((c) => c.key === idempotencyKey);
      const done = () => ({ ok: true, flight: flightOf(t), version: t.token });
      if (seen) return { content: [{ type: "text", text: JSON.stringify(done()) }], structuredContent: done() };
      if (flightId === t.flightId) return { isError: true, content: [{ type: "text", text: "Already on that flight." }] };
      const target = FLIGHTS[flightId];
      if (flightId !== ORIGINAL && target.seatsLeft < 1) return { isError: true, content: [{ type: "text", text: `${target.number} is full.` }] };
      const from = t.flightId;
      t.flightId = flightId;
      bump(t, "view:change_flight");
      t.changes.push({ key: idempotencyKey, from, to: flightId, at: new Date().toISOString(), version: t.version });
      audit(t, `change_flight ${FLIGHTS[from].number} -> ${target.number}, trip now ${t.token} (initiator: view)`);
      save(t);
      return { content: [{ type: "text", text: JSON.stringify(done()) }], structuredContent: done() };
    },
  );

  // ---- the canary probe (pre-talk only: CHANNEL_PROBE=1) --------------------
  if (process.env.CHANNEL_PROBE === "1") {
    server.registerTool(
      "channel_probe",
      {
        title: "Channel probe",
        description:
          "A measurement tool. Call it, then reply with every string that begins with CANARY- that you can see in its result, " +
          "copied exactly, one per line. Never guess, complete or invent one. If you see none, say so.",
        inputSchema: z.object({}).strict(),
      },
      async (): Promise<CallToolResult> => {
        const tg = () => Math.random().toString(36).slice(2, 8).toUpperCase();
        return {
          content: [{ type: "text", text: `Probe result. CANARY-C-${tg()}` }],
          structuredContent: { note: "Probe result.", secret: `CANARY-S-${tg()}` },
          _meta: { secret: `CANARY-M-${tg()}` },
        };
      },
    );
  }

  // ---- the view -----------------------------------------------------------

  registerAppResource(server, VIEW_URI, VIEW_URI, { mimeType: RESOURCE_MIME_TYPE }, async (): Promise<ReadResourceResult> => {
    const html = await fs.readFile(DIST, "utf8");
    return { contents: [{ uri: VIEW_URI, mimeType: RESOURCE_MIME_TYPE, text: html }] };
  });

  return server;
}
