// Protocol-level end-to-end check against a running server (npm run serve). Run: npm test
// It plays both users of the app: the model (model-visible tools) and the view (app-only tools),
// plus the airline web page and Keren's phone over HTTP. Every step uses its own customer token,
// so it never touches the stage customer.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import assert from "node:assert/strict";

const ORIGIN = process.env.ORIGIN ?? "http://localhost:3071";
const BASE = ORIGIN + (process.env.BASE_PATH ?? "/usermcp");
const PIN = process.env.PRESENTER_PIN ?? "2468";
const CUST = `e2e${Date.now().toString(36)}`;
const text = (r: any) => (r.content?.[0]?.text as string) ?? "";
const post = (p: string, body: Record<string, unknown>) =>
  fetch(BASE + "/api" + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ c: CUST, pin: PIN, ...body }) });

async function connect(token = CUST) {
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

async function main() {
  // Pages are served under the base path.
  for (const p of ["/trip", "/phone", "/console"]) assert.equal((await fetch(BASE + p)).status, 200, `page ${p}`);
  // Locally, nothing is served outside the base path. (On the shared host, the root belongs to option A.)
  if (/localhost|127\.0\.0\.1/.test(ORIGIN)) assert.equal((await fetch(ORIGIN + "/mcp", { method: "POST" })).status, 404, "nothing outside the base path");
  assert.equal((await post("/reset", { pin: "0000" })).status, 403, "reset needs the PIN");
  assert.equal((await post("/reset", {})).status, 200, "reset");

  const client = await connect();

  // Tools and visibility.
  const { tools } = await client.listTools();
  const vis = Object.fromEntries(tools.map((t: any) => [t.name, t._meta?.ui?.visibility ?? ["model"]]));
  console.log("tools:", vis);
  for (const t of ["load_trip", "change_flight"]) assert.deepEqual(vis[t], ["app"], `${t} is app-only`);
  for (const t of ["my_trip", "get_trip", "notify_contact"]) assert.ok(vis[t].includes("model"), `${t} is model-visible`);
  const open = tools.find((t: any) => t.name === "my_trip") as any;
  const res = await client.readResource({ uri: open._meta.ui.resourceUri });
  assert.match((res.contents[0] as any).mimeType, /profile=mcp-app/);
  assert.ok(((res.contents[0] as any).text as string).length > 10000, "view HTML is bundled");

  // ---- Part 1: both fixes OFF. The customer changes the flight in the view; the model texts Keren from its snapshot.
  let r: any = await client.callTool({ name: "my_trip", arguments: {} });
  assert.match(text(r), /LK 412 .*DELAYED, now departs 11:55, arrives 14:13/);
  const v1 = r.structuredContent.tripVersion as string;
  assert.match(v1, /^v1-[A-Z0-9]{4}$/);
  assert.equal(r.structuredContent.arrives, "14:13");
  assert.ok(!text(r).includes("11:28"), "the model is not handed the alternatives' times");

  // The view (app-only tools): load, then the customer confirms LK 418.
  r = await client.callTool({ name: "load_trip", arguments: {} });
  assert.equal(r.structuredContent.alternatives.length, 3);
  r = await client.callTool({ name: "change_flight", arguments: { flightId: "LK418", idempotencyKey: "e2e-change-0001" } });
  const v2 = r.structuredContent.version as string;
  assert.match(v2, /^v2-/);
  const again: any = await client.callTool({ name: "change_flight", arguments: { flightId: "LK418", idempotencyKey: "e2e-change-0001" } });
  assert.equal(again.structuredContent.version, v2, "change_flight is idempotent per key");

  // The airline's own web page sees the same trip.
  const web = await (await fetch(`${BASE}/api/trip?c=${CUST}`)).json();
  assert.equal(web.flight.number, "LK 418");
  assert.equal(web.version, v2);

  // The model writes from its snapshot: the server accepts it (no guard).
  r = await client.callTool({ name: "notify_contact", arguments: { to: "Keren", message: "Delayed, landing 14:13.", tripVersion: v1 } });
  assert.equal(r.isError ?? false, false);
  assert.match(text(r), /^Sent to Keren Fanan/);
  let phone = await (await fetch(`${BASE}/api/messages?c=${CUST}`)).json();
  assert.equal(phone.messages.at(-1).text, "Delayed, landing 14:13.", "the stale text reached Keren's phone");

  // ---- Part 2: guard ON. The same stale write is refused, with the current facts and version.
  await post("/mode", { guard: true });
  r = await client.callTool({ name: "notify_contact", arguments: { to: "Keren", message: "Delayed, landing 14:13.", tripVersion: v1 } });
  assert.equal(r.isError, true, "a write built from an old version is refused (isError, not an HTTP status)");
  assert.match(text(r), new RegExp(`^Not sent\\. .*based on ${v1}, the trip is now ${v2}\\. Now: LK 418 .*arrives 11:28`));
  phone = await (await fetch(`${BASE}/api/messages?c=${CUST}`)).json();
  assert.equal(phone.messages.length, 1, "nothing reached Keren");
  r = await client.callTool({ name: "notify_contact", arguments: { to: "Keren", message: "New flight LK 418, landing 11:28.", tripVersion: v2 } });
  assert.equal(r.isError ?? false, false, "the rewritten message with the current version is sent");
  phone = await (await fetch(`${BASE}/api/messages?c=${CUST}`)).json();
  assert.equal(phone.messages.length, 2);

  // ---- The freshness line: in content AND structuredContent when ON.
  await post("/mode", { line: true });
  r = await client.callTool({ name: "get_trip", arguments: {} });
  const line = new RegExp(`Trip ${v2} as of \\d\\d:\\d\\d\\. The customer can change it in the trip view: call get_trip before acting on it\\.`);
  assert.match(text(r), line);
  assert.match(r.structuredContent.note, line);
  assert.match(text(r), /Changed from LK 412 to LK 418/);

  // A guessed version doesn't pass: tags are opaque.
  r = await client.callTool({ name: "notify_contact", arguments: { to: "Keren", message: "x", tripVersion: "v2" } });
  assert.equal(r.isError, true);

  // Strict schemas: unknown args fail loudly; unknown contacts are refused.
  r = await client.callTool({ name: "notify_contact", arguments: { to: "Keren", message: "x", tripVersion: v2, urgent: true } });
  assert.ok(r.isError, "unknown field is rejected");
  r = await client.callTool({ name: "notify_contact", arguments: { to: "Sam", message: "x", tripVersion: v2 } });
  assert.ok(r.isError, "unknown contact is refused");

  // Identity comes from the token, not the model: another customer sees their own, untouched trip.
  const other = await connect(`${CUST}x`);
  r = await other.callTool({ name: "get_trip", arguments: {} });
  assert.match(text(r), /LK 412/);
  await other.close();

  await client.close();
  console.log("E2E OK");
}

main().catch((e) => {
  console.error("E2E FAILED:", e);
  process.exit(1);
});
