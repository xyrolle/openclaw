// Replace <openclaw-checkout> with the checkout path before running.
// Sends one chat turn through a running Gateway and prints when each assistant delta arrived,
// next to when the loopback provider sent it. Run from an OpenClaw checkout:
//   node --import ./scripts/tsx.mjs <this file> <ws-url> <token> <sessionKey> <message> <stub-log.jsonl>
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "<openclaw-checkout>/packages/gateway-protocol/src/client-info.ts";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "<openclaw-checkout>/packages/gateway-protocol/src/index.ts";
import { GatewayClient } from "<openclaw-checkout>/src/gateway/client.ts";

const [url, token, sessionKey, message, stubLog] = process.argv.slice(2);
const events: Array<{ at: number; line: string }> = [];
let hello: () => void = () => undefined;
const ready = new Promise<void>((resolve) => {
  hello = resolve;
});
let runId = "";
const client = new GatewayClient({
  url,
  token,
  clientName: GATEWAY_CLIENT_NAMES.CLI,
  clientDisplayName: "upgrade-proof",
  mode: GATEWAY_CLIENT_MODES.CLI,
  scopes: ["operator.admin", "operator.read", "operator.write"],
  caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
  instanceId: randomUUID(),
  minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
  maxProtocol: PROTOCOL_VERSION,
  onHelloOk: () => hello(),
  onEvent: (evt) => {
    const payload = (evt.payload ?? {}) as Record<string, unknown>;
    if (payload.runId !== runId) {
      return;
    }
    const data = (payload.data ?? {}) as Record<string, unknown>;
    if (evt.event === "agent" && (payload.stream === "assistant" || payload.stream === "thinking")) {
      const text = typeof data.delta === "string" ? data.delta : "";
      if (text || data.replace === true) {
        events.push({
          at: Date.now(),
          line: `${String(payload.stream)}${data.replace === true ? " replace" : ""} ${JSON.stringify(text.slice(0, 32))}`,
        });
      }
    } else if (evt.event === "agent" && payload.stream === "tool") {
      events.push({ at: Date.now(), line: `tool ${String(data.phase)} ${String(data.name)}` });
    } else if (evt.event === "chat" && payload.state !== "delta" && payload.state !== "status") {
      events.push({ at: Date.now(), line: `chat ${String(payload.state)}` });
    }
  },
});
client.start();
await ready;
const sentAt = Date.now();
const started = await client.request<{ runId?: string }>("chat.send", {
  sessionKey,
  message,
  deliver: false,
  idempotencyKey: `upgrade-proof-${randomUUID()}`,
});
runId = started.runId ?? "";
const waited = await client.request<{ status?: string }>(
  "agent.wait",
  { runId, timeoutMs: 120_000 },
  { timeoutMs: 125_000 },
);
await new Promise((resolve) => setTimeout(resolve, 800));
const history = await client.request<{ messages?: Array<{ role?: string; content?: unknown }> }>(
  "chat.history",
  { sessionKey, limit: 50 },
);
client.stop();

const provider = readFileSync(stubLog, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { kind?: string; at?: number; delta?: string; stop?: string; text?: string })
  .filter((entry) => entry.kind === "send" && (entry.at ?? 0) >= sentAt)
  .filter((entry) => entry.delta === "text_delta" || entry.delta === "thinking_delta" || entry.stop);
const rows = [
  ...provider.map((entry) => ({
    at: entry.at ?? 0,
    line: `provider ${entry.stop ? `stop_reason=${entry.stop}` : `${entry.delta} ${JSON.stringify((entry.text ?? "").slice(0, 32))}`}`,
  })),
  ...events.map((entry) => ({ at: entry.at, line: `client   ${entry.line}` })),
].toSorted((a, b) => a.at - b.at);
console.log(`session ${sessionKey} · run ${waited.status ?? "?"}`);
for (const row of rows) {
  console.log(`${String(row.at - sentAt).padStart(6)} ms  ${row.line}`);
}
const last = history.messages?.at(-1);
console.log(
  `history: ${history.messages?.length ?? 0} messages; last ${String(last?.role)} ${JSON.stringify(last?.content ?? null).slice(0, 120)}`,
);
process.exit(0);
