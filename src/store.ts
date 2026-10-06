// The trip lives on the airline's server, never in the view or the chat.
// One record per customer (the customer comes from auth, never from the model).
// A JSON file per customer is enough for a demo; swap it for your booking system.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type Flight = {
  id: string; // "LK418"
  number: string; // "LK 418"
  departs: string; // local time at origin, "09:10"
  arrives: string; // local time at destination, "11:28"
  duration: string;
  stops: number;
  aircraft: string;
  seatsLeft: number;
  status: "on-time" | "delayed";
  scheduled?: { departs: string; arrives: string };
  delayReason?: string;
};

export type Message = {
  id: string;
  to: string;
  text: string;
  at: string;
  // For the measurement: which trip version the model said it built the message from,
  // and which one was current when the server accepted it.
  claimedVersion: string | null;
  currentVersion: string;
};

export type Mode = {
  // Fix 1, the freshness line (option A's rule four): one line in every model-facing result.
  line: boolean;
  // Fix 2, the precondition: model writes carry the trip version they were built from,
  // and the server refuses a write built from an old version.
  guard: boolean;
  // The spec's bridge, for measurement on a real host: after a change the view calls ui/update-model-context.
  handoff?: boolean;
  // Option 2 on a real host: after a change the view calls ui/message (the host decides whether it waits for Enter).
  message?: boolean;
};

export type Trip = {
  customer: string;
  ref: string;
  passenger: string;
  date: string; // "Wed 7 Oct"
  from: { code: string; city: string };
  to: { code: string; city: string };
  flightId: string;
  seat: string;
  version: number;
  token: string; // opaque version tag the model sees: "v1-7QF2"
  history: { version: number; token: string; flightId: string; at: string; by: string }[];
  changes: { key: string; from: string; to: string; at: string; version: number }[];
  messages: Message[];
  mode: Mode;
  audit: string[];
};

// The schedule for the demo day. Local times: Toronto (ET) to San Francisco (PT).
export const FLIGHTS: Record<string, Flight> = {
  LK412: {
    id: "LK412", number: "LK 412", departs: "11:55", arrives: "14:13", duration: "5h 18m", stops: 0,
    aircraft: "A321neo", seatsLeft: 0, status: "delayed",
    scheduled: { departs: "07:40", arrives: "09:58" }, delayReason: "Aircraft maintenance",
  },
  LK418: { id: "LK418", number: "LK 418", departs: "09:10", arrives: "11:28", duration: "5h 18m", stops: 0, aircraft: "A321neo", seatsLeft: 14, status: "on-time" },
  LK422: { id: "LK422", number: "LK 422", departs: "10:45", arrives: "13:04", duration: "5h 19m", stops: 0, aircraft: "737 MAX 8", seatsLeft: 3, status: "on-time" },
  LK430: { id: "LK430", number: "LK 430", departs: "13:20", arrives: "15:38", duration: "5h 18m", stops: 0, aircraft: "A321neo", seatsLeft: 22, status: "on-time" },
};
export const ORIGINAL = "LK412";
export const ALTERNATIVES = ["LK418", "LK422", "LK430"];
export const CONTACTS = [{ name: "Keren Fanan", first: "Keren", phone: "+1 415 555 0142" }];

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const safe = (c: string) => c.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "stage";
const fileOf = (customer: string) => path.join(DATA_DIR, `trip-${safe(customer)}.json`);

const tag = () => {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(4), (b) => A[b % A.length]).join("");
};
export const newToken = (v: number) => `v${v}-${tag()}`;

export function freshTrip(customer: string): Trip {
  const at = new Date().toISOString();
  const token = newToken(1);
  return {
    customer: safe(customer),
    ref: "Q7M4KD",
    passenger: "Jordan Lee",
    date: "Wed 7 Oct",
    from: { code: "YYZ", city: "Toronto" },
    to: { code: "SFO", city: "San Francisco" },
    flightId: ORIGINAL,
    seat: "14A",
    version: 1,
    token,
    history: [{ version: 1, token, flightId: ORIGINAL, at, by: "seed" }],
    changes: [],
    messages: [],
    mode: { line: false, guard: false },
    audit: [],
  };
}

export function load(customer: string): Trip {
  try {
    return JSON.parse(fs.readFileSync(fileOf(customer), "utf8")) as Trip;
  } catch {
    const t = freshTrip(customer);
    save(t);
    return t;
  }
}

export function save(t: Trip) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const f = fileOf(t.customer);
  fs.writeFileSync(f + ".tmp", JSON.stringify(t, null, 2));
  fs.renameSync(f + ".tmp", f);
}

export function reset(customer: string, mode?: Partial<Mode>) {
  const t = freshTrip(customer);
  if (mode) t.mode = { ...t.mode, ...mode };
  save(t);
  return t;
}

export const flightOf = (t: Trip) => FLIGHTS[t.flightId];

// Bump the version: every change to the trip gets a new opaque tag.
export function bump(t: Trip, by: string) {
  t.version += 1;
  t.token = newToken(t.version);
  t.history.push({ version: t.version, token: t.token, flightId: t.flightId, at: new Date().toISOString(), by });
}

// HH:MM in the stage's time zone (run with TZ=America/Toronto).
export function clock(d = new Date()) {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function audit(t: Trip, line: string) {
  t.audit.push(`${new Date().toISOString()} ${line}`);
  console.log(`[audit ${t.customer}] ${line}`);
}

export const newId = () => tag().toLowerCase() + tag().toLowerCase();
