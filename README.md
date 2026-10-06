# Lakeshore Air: an MCP App with two faces

The demo from **"The App Inside the Chat"** (MCP Dev Summit Toronto, 6 Oct 2026, Keren Fanan and Hadar Geva, [Myop](https://myop.dev)). The slides: [slides/](slides/).

A made-up airline's "Manage my trip", inside the chat. A customer's flight is delayed. They pick a new flight in the app and press Change, then ask the chat: "Text Keren my new arrival time." It's built on plain [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps) 2.x (MCP Apps, SEP-1865), with no vendor in the path.

## What it shows

An MCP App has two faces:
- **The model's context:** the tool results the model reads.
- **The user's eyes:** the `ui://` page the host renders.

A view's `tools/call` result goes back to the view, never to the model. So after the customer changes the flight in the view, the model's next write is built from the old trip: the text says 14:13 instead of 11:28.

The fix measured here: the write carries the version it was built from, and the server refuses an old one.

```
isError: Not sent. The trip changed after you read it: your message is based on v1-QPHE, the trip is now v2-PZ8H.
Now: LK 418 ... arrives 11:28. Rewrite the message from the current trip, then send it again with tripVersion v2-PZ8H.
```

| Tool | Who calls it | What it does |
|---|---|---|
| `my_trip` | model (and app) | the trip, for the model; renders the view |
| `get_trip` | model | the current trip and its version |
| `notify_contact` | model | texts a saved contact; takes `tripVersion` |
| `load_trip` | app only | the booking and same-day flights, for the view |
| `change_flight` | app only | the customer's Change button: idempotent, audited |

**Pages:**

| Page | What it is |
|---|---|
| `/trip` | the airline's own web page |
| `/phone` | the contact's phone, where the texts land |
| `/console` | the presenter's switches |

**The two server-side switches:**
- **Freshness line:** a hint added to every result the model gets.
- **Version check on writes:** the fix.

**Two view switches, for trying the spec's own bridges on a real host (both off by default):**
- **View hand-off:** after Change, the view calls `ui/update-model-context` (`app.updateModelContext`).
- **View message:** after Change, the view calls `ui/message` (`app.sendMessage`) with "I changed my flight to LK 418, arriving 11:28." On claude.ai (6 Oct 2026) it landed in the composer unsent, under a caution banner, and waited for the user to press Enter.

## Run it

```bash
npm install
npm start                  # builds the view, serves on :3071 under /usermcp
npm run reset              # the trip: LK 412 delayed, v1, no texts, switches off
npm test                   # protocol e2e against the running server
```

| URL | What |
|---|---|
| `http://localhost:3071/usermcp/mcp` | MCP endpoint (stateless Streamable HTTP, no auth) |
| `http://localhost:3071/usermcp/trip?pin=2468` | airline web page (the PIN enables its Select buttons) |
| `http://localhost:3071/usermcp/phone` | the contact's phone |
| `http://localhost:3071/usermcp/console` | presenter console: Reset, freshness line, version check, view hand-off, view message |

**Environment variables:**

| Variable | Default and meaning |
|---|---|
| `PORT` | 3071 |
| `BASE_PATH` | `/usermcp` |
| `PUBLIC_URL` | the public origin |
| `PRESENTER_PIN` | `2468`. **Set your own on any public URL.** |
| `DATA_DIR` | `./data`. State is JSON files; there is no database. |
| `TZ` | the clock shown in the app, e.g. `America/Toronto` |
| `CHANNEL_PROBE=1` | adds the canary tool |

**To try it in Claude:** expose the endpoint over HTTPS and add it as a custom connector (no sign-in). Then open the connector's page and press **Connect**; a new custom connector gets no tools in chats until you do. Reconnect after every redeploy, because hosts cache the tool list.

**To see the view without Claude:** use the reference host, `ext-apps/examples/basic-host`, with `SERVERS='["http://localhost:3071/usermcp/mcp"]'`.

## The flow from the talk

1. "My flight to SF tomorrow got delayed. Show me my trip and my options." The model calls `my_trip`, and the trip renders in the chat.
2. In the view, pick 09:10 (LK 418) and press Change. The view calls the app-only `change_flight`, and the model never sees it.
3. "Text Keren my new arrival time."
   - **With the version check off:** the text says 14:13.
   - **With it on:** the first send is refused, and the model rewrites with 11:28.

## Tests and measurements

**`npm test`** (`test/e2e.ts`) runs a real MCP client that plays both users. It checks:
- tool visibility;
- the bundled view resource;
- part 1: the stale text gets through;
- part 2: the stale write is refused, and the rewrite is sent;
- the freshness line in both channels;
- that a guessed version is refused;
- strict schemas;
- per-customer isolation.

**`npx tsx test/rehearsal.ts <runs> <nothing,line,guard,both> [parallel]`** is the measurement behind the talk's numbers. It runs real Claude models through headless Claude Code, which has no view, so the change is made through the same app-only tool the view uses. `MODEL` picks the model (default `claude-sonnet-5`).

**`results/`** holds the raw runs:
- **The 30 Sep runs** used an earlier wording of the same flow: Vancouver as the destination, and "Dana" as the contact. Flights, times and versions are identical.
- **`claudeai-handoff-sonnet5-2026-10-05.json`** tests the spec's hand-off (`ui/update-model-context`) on claude.ai. The host accepted it, yet 2 of 3 texts still had the old time.

## Before you run this anywhere public

This is a demo. The bearer token stands in for the customer. Before you keep it up anywhere public:
- Use a real OAuth provider.
- Set `allowedHosts` on the Express app.
- Add per-customer rate limits.
- Set your own `PRESENTER_PIN`.

## License

MIT, see [LICENSE](LICENSE). The bundled font, Instrument Serif, is licensed under the SIL Open Font License.
