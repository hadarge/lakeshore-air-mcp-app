// The view: the customer's half of the app. Everything it does goes through the host as
// tools/call on app-only tools, and the results come back HERE, not to the model.
import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import "./app.css";

type Flight = {
  id: string;
  number: string;
  departs: string;
  arrives: string;
  duration: string;
  stops: number;
  aircraft: string;
  seatsLeft: number;
  status: "on-time" | "delayed";
  scheduled?: { departs: string; arrives: string };
  delayReason?: string;
};
type Trip = {
  ref: string;
  passenger: string;
  date: string;
  from: { code: string; city: string };
  to: { code: string; city: string };
  seat: string;
  version: string;
  asOf: string;
  flight: Flight;
  original: Flight;
  alternatives: Flight[];
  changes: { from: string; to: string; at: string; fromNumber: string; toNumber: string }[];
  handoff?: boolean;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const app = new App({ name: "lakeshore-trip", version: "0.2.0" });
let trip: Trip | null = null;
let picked: string | null = null;
let busy = false;
let reopen = false; // the customer pressed "Change again"

const mins = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const span = (d: number) => {
  const a = Math.abs(d);
  const h = Math.floor(a / 60);
  const m = a % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
};
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

function setStatus(text: string, tone: "" | "ok" | "error" | "wait" = "") {
  const el = $("status");
  el.textContent = text;
  el.dataset.tone = tone;
}

function applyContext(ctx: McpUiHostContext) {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

function renderPass(t: Trip) {
  const f = t.flight;
  const delayed = f.status === "delayed";
  const changed = t.changes.at(-1);
  $("sub").textContent = `Trip ${t.ref} · ${t.passenger}`;
  const pill = $("pill");
  pill.textContent = delayed ? `Delayed ${span(mins(f.departs) - mins(f.scheduled!.departs))}` : changed ? "Confirmed" : "On time";
  pill.dataset.tone = delayed ? "wait" : "ok";
  $("p-flight").textContent = f.number;
  $("p-date").textContent = t.date;
  $("p-seat").textContent = t.seat;
  $("p-from").textContent = t.from.code;
  $("p-to").textContent = t.to.code;
  $("p-from-city").textContent = t.from.city;
  $("p-to-city").textContent = t.to.city;
  $("p-dep").textContent = f.departs;
  $("p-arr").textContent = f.arrives;
  $("p-dep-was").textContent = delayed ? f.scheduled!.departs : "";
  $("p-arr-was").textContent = delayed ? f.scheduled!.arrives : "";
  $("p-dur").textContent = `${f.duration} · ${f.stops ? `${f.stops} stop` : "Nonstop"}`;
  $("pass").dataset.state = delayed ? "delayed" : "ok";
  const ch = $("p-changed");
  ch.hidden = !changed || delayed;
  if (changed && !delayed) ch.textContent = `Changed from ${changed.fromNumber} at ${hhmm(changed.at)}`;
  const notice = $("notice");
  notice.hidden = !delayed;
  if (delayed) {
    notice.innerHTML = "";
    const b = document.createElement("b");
    b.textContent = `${f.delayReason ?? "Delayed"}.`;
    notice.append(b, " Your flight leaves more than 3 hours late. Change to another flight today at no cost, or keep this one.");
  }
}

function renderOptions(t: Trip) {
  const f = t.flight;
  const show = f.status === "delayed" || reopen;
  $("options").hidden = !show;
  const list = $("opt-list");
  list.replaceChildren();
  if (!show) return;
  const pool = [...t.alternatives, t.original].filter((x) => x.id !== f.id && (x.status !== "delayed" || reopen));
  for (const o of pool) {
    const delta = mins(o.arrives) - mins(f.arrives);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opt";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(picked === o.id));
    b.disabled = busy || (o.seatsLeft < 1 && o.status !== "delayed");
    b.innerHTML = `
      <span class="radio" aria-hidden="true"></span>
      <span class="o-times"><b>${o.departs}</b><span class="arrow">→</span><b>${o.arrives}</b></span>
      <span class="o-meta">${o.number} · ${o.stops ? `${o.stops} stop` : "Nonstop"} · ${o.duration}</span>
      <span class="o-delta" data-dir="${delta < 0 ? "earlier" : "later"}">${delta === 0 ? "Same arrival" : `Arrives ${span(delta)} ${delta < 0 ? "earlier" : "later"}`}</span>
      <span class="o-seats">${o.status === "delayed" ? "Your original flight" : o.seatsLeft <= 5 ? `${o.seatsLeft} seats left` : "Seats available"}</span>
      <span class="o-price">$0</span>`;
    b.addEventListener("click", () => {
      picked = o.id;
      render();
    });
    list.append(b);
  }
}

function renderFoot(t: Trip) {
  $("meta").textContent = `Booking record ${t.version} · ${hhmm(t.asOf)}`;
  const btn = $<HTMLButtonElement>("confirm");
  const f = t.flight;
  const choosing = f.status === "delayed" || reopen;
  if (!choosing) {
    btn.disabled = busy;
    btn.textContent = "Change again";
    btn.className = "btn ghost";
    return;
  }
  const o = [...t.alternatives, t.original].find((x) => x.id === picked);
  btn.className = "btn";
  btn.disabled = busy || !o;
  btn.textContent = busy ? "Changing…" : o ? `Change to ${o.number} · $0` : "Select a flight";
}

function render() {
  if (!trip) return;
  $("app").removeAttribute("aria-busy");
  renderPass(trip);
  renderOptions(trip);
  renderFoot(trip);
}

async function refresh() {
  try {
    const r = await app.callServerTool({ name: "load_trip", arguments: {} });
    const next = r.structuredContent as unknown as Trip;
    // Nothing changed on the server: keep the DOM (re-rendering would swallow a click in flight).
    if (trip && next.version === trip.version) {
      trip.asOf = next.asOf;
      renderFoot(trip);
      return;
    }
    if (trip && !busy) reopen = false;
    trip = next;
    if (picked && trip.flight.id === picked) picked = null;
    render();
  } catch (e) {
    console.error("load_trip failed", e);
  }
}

$("confirm").addEventListener("click", async () => {
  if (!trip) return;
  const choosing = trip.flight.status === "delayed" || reopen;
  if (!choosing) {
    reopen = true;
    picked = null;
    setStatus("");
    render();
    return;
  }
  if (!picked) return;
  const target = [...trip.alternatives, trip.original].find((x) => x.id === picked)!;
  busy = true;
  render();
  setStatus(`Changing to ${target.number}…`, "wait");
  try {
    const r = await app.callServerTool({
      name: "change_flight",
      arguments: { flightId: picked, idempotencyKey: `chg-${picked}-${crypto.randomUUID()}` },
    });
    if (r.isError) throw new Error((r.content?.[0] as { text?: string })?.text ?? "The change didn't go through.");
    setStatus(`Done. You're on ${target.number}, seat ${trip.seat}.`, "ok");
    if (trip.handoff) {
      // The spec's bridge (measurement switch): tell the model. The host decides when it lands.
      const v = (r.structuredContent as { version?: string })?.version ?? "";
      await app.updateModelContext({ content: [{ type: "text", text: `The customer changed the flight in the trip view. Trip ${v}: ${target.number}, departs ${target.departs}, arrives ${target.arrives}.` }] }).catch(() => {});
    }
    reopen = false;
    picked = null;
    const pass = $("pass");
    pass.classList.add("flash");
    setTimeout(() => pass.classList.remove("flash"), 1800);
  } catch (e) {
    setStatus(String((e as Error).message ?? e), "error");
  } finally {
    busy = false;
    await refresh();
  }
});

// The model opened us: its result arrives here too.
app.ontoolresult = () => void refresh();
app.onhostcontextchanged = applyContext;
app.onerror = console.error;

app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) applyContext(ctx);
  void refresh();
  // The airline's web page can change the trip too. Poll, and pause while hidden.
  setInterval(() => {
    if (!busy && document.visibilityState === "visible") void refresh();
  }, 4000);
});
