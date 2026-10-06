import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
const c = new Client({ name: "shot", version: "0" });
await c.connect(new StreamableHTTPClientTransport(new URL("http://localhost:3071/usermcp/mcp")));
const r: any = await c.callTool({ name: "notify_contact", arguments: { to: "Keren", message: process.argv[2], tripVersion: process.argv[3] ?? "v1-XXXX" } });
console.log(JSON.stringify(r).slice(0, 600));
await c.close();
