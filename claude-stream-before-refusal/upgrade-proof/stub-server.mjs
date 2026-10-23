// Runs the loopback Anthropic SSE stub on a fixed port and appends every sent frame to a JSONL log.
//   node stub-server.mjs <port> <log.jsonl>
import { appendFileSync, writeFileSync } from "node:fs";
import { createAnthropicSseStub } from "../repro/claude-stream-repro-stub.mjs";

const [port, logFile] = [Number(process.argv[2]), process.argv[3]];
writeFileSync(logFile, "");
const stub = createAnthropicSseStub({
  delayMs: 600,
  workspaceDir: "",
  log: (entry) => appendFileSync(logFile, `${JSON.stringify(entry)}\n`),
});
let written = 0;
setInterval(() => {
  for (; written < stub.sends.length; written += 1) {
    appendFileSync(logFile, `${JSON.stringify({ ...stub.sends[written], kind: "send" })}\n`);
  }
}, 50);
await stub.listen(port);
console.log(`stub listening on 127.0.0.1:${port}`);
