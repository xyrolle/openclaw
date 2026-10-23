// Loopback Anthropic Messages stub: answers POST /v1/messages with a real SSE stream
// that sleeps between deltas, and logs the time each frame left the socket.
//
// The scenario comes from a tag in the newest user text:
//   [scenario:answer]        thinking + text, end_turn
//   [scenario:refusal]       thinking + text, then stop_reason "refusal"
//   [scenario:cut]           text, then the socket closes before message_stop
//   [scenario:tool-refusal]  text + a complete `write` tool_use, then stop_reason "refusal"
//   [scenario:two-calls]     call 1: text + `write` tool_use (tool_use stop);
//                            call 2 (after the tool result): text, then stop_reason "refusal"
// Requests without a tag (titles, memory) get a short immediate text reply.
import { createServer } from "node:http";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    const text = (Array.isArray(parts) ? parts : [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    if (text) return text;
  }
  return "";
}

function userTexts(message) {
  const parts = typeof message?.content === "string" ? [{ type: "text", text: message.content }] : message?.content;
  return (Array.isArray(parts) ? parts : []).filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text);
}

// The newest tagged user message names the scenario; tool results after it belong to that turn.
function readTurn(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== "user") continue;
    const match = userTexts(messages[i]).join("\n").match(/\[scenario:([a-z-]+)\]/);
    if (!match) continue;
    const toolResult = messages.slice(i + 1).some(
      (message) => message?.role === "user" && Array.isArray(message.content) && message.content.some((part) => part?.type === "tool_result"),
    );
    return { scenario: match[1], toolResult };
  }
  return { scenario: undefined, toolResult: false };
}

function splitText(text, parts) {
  const words = text.split(" ");
  const size = Math.ceil(words.length / parts);
  const chunks = [];
  for (let i = 0; i < words.length; i += size) {
    chunks.push(`${i === 0 ? "" : " "}${words.slice(i, i + size).join(" ")}`);
  }
  return chunks;
}

const ANSWER =
  "Streaming check: this reply is sent in six pieces, one every few hundred milliseconds, so a live view should grow while the model is still writing.";
const REFUSED_PARTIAL =
  "REFUSED_PARTIAL_MARKER This text was generated before the classifier stopped the reply and must not stay on screen.";
const TOOL_PREAMBLE = "I will write the file now.";
const CALL_ONE = "CALL_ONE_MARKER Step one is done; writing the first file.";
const CALL_TWO_PARTIAL = "CALL_TWO_PARTIAL_MARKER Step two started, then the classifier stopped it.";

/**
 * @param {{ delayMs?: number, workspaceDir: string, log?: (entry: object) => void }} options
 */
export function createAnthropicSseStub(options) {
  const delayMs = options.delayMs ?? 600;
  const requests = [];
  const sends = [];
  const log = options.log ?? (() => {});

  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      void handle(request, response, raw).catch((error) => {
        log({ type: "stub-error", error: String(error) });
        response.destroy();
      });
    });
  });

  async function handle(request, response, raw) {
    if (request.method !== "POST" || !request.url?.startsWith("/v1/messages")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "stub" } }));
      return;
    }
    const body = JSON.parse(raw || "{}");
    const { scenario, toolResult } = readTurn(body);
    const requestIndex = requests.length;
    const record = {
      index: requestIndex,
      receivedAt: Date.now(),
      model: body.model,
      scenario: scenario ?? "untagged",
      toolResult,
      lastUser: lastUserText(body).slice(0, 120),
      fallbacks: body.fallbacks,
    };
    requests.push(record);
    log({ type: "stub-request", ...record });

    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let socketClosed = false;
    response.on("close", () => {
      socketClosed = true;
    });
    const send = async (event, wait = 0) => {
      if (wait > 0) await sleep(wait);
      if (socketClosed) return;
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      const entry = {
        request: requestIndex,
        at: Date.now(),
        type: event.type,
        delta: event.delta?.type,
        text: event.delta?.text ?? event.delta?.thinking ?? event.delta?.partial_json,
        stop: event.delta?.stop_reason,
      };
      sends.push(entry);
    };
    const start = () =>
      send({
        type: "message_start",
        message: {
          id: `msg_stub_${requestIndex}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 120, output_tokens: 0 },
        },
      });
    const textBlock = async (index, text, parts) => {
      await send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const piece of splitText(text, parts)) {
        await send({ type: "content_block_delta", index, delta: { type: "text_delta", text: piece } }, delayMs);
      }
      await send({ type: "content_block_stop", index });
    };
    const thinkingBlock = async (index, parts) => {
      await send({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      for (const piece of splitText("The user wants to see whether the reply streams; think briefly, then answer in several pieces.", parts)) {
        await send({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: piece } }, delayMs);
      }
      await send({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "c3R1Yi1zaWduYXR1cmU=" } });
      await send({ type: "content_block_stop", index });
    };
    const writeTool = async (index, id, path, content) => {
      await send({ type: "content_block_start", index, content_block: { type: "tool_use", id, name: "write", input: {} } });
      const json = JSON.stringify({ path, content });
      const third = Math.ceil(json.length / 3);
      for (let i = 0; i < json.length; i += third) {
        await send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(i, i + third) } }, delayMs);
      }
      await send({ type: "content_block_stop", index });
    };
    const finish = async (stopReason, extra = {}) => {
      await send({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null, ...extra }, usage: { output_tokens: 40 } }, delayMs);
      await send({ type: "message_stop" });
      response.end();
    };
    const refusal = () =>
      finish("refusal", {
        stop_details: { type: "refusal", category: "cyber", explanation: "Stub classifier refusal for the streaming repro." },
      });

    await start();
    switch (toolResult && scenario === "two-calls" ? "two-calls-second" : (scenario ?? "untagged")) {
      case "answer":
        await thinkingBlock(0, 3);
        await textBlock(1, ANSWER, 6);
        await finish("end_turn");
        return;
      case "refusal":
        await thinkingBlock(0, 2);
        await textBlock(1, REFUSED_PARTIAL, 4);
        await refusal();
        return;
      case "cut":
        await textBlock(0, REFUSED_PARTIAL, 4);
        await sleep(delayMs);
        log({ type: "stub-cut", request: requestIndex, at: Date.now() });
        response.socket?.destroy();
        return;
      case "tool-refusal":
        await textBlock(0, TOOL_PREAMBLE, 2);
        await writeTool(1, "toolu_refused_write", "REFUSED_TOOL_EXECUTED.txt", "this file must never exist");
        await refusal();
        return;
      case "two-calls":
        await textBlock(0, CALL_ONE, 3);
        await writeTool(1, "toolu_call_one_write", "CALL_ONE_TOOL_EXECUTED.txt", "call one ran");
        await finish("tool_use");
        return;
      case "two-calls-second":
        await textBlock(0, CALL_TWO_PARTIAL, 3);
        await refusal();
        return;
      default:
        await send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        await send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Stub title" } });
        await send({ type: "content_block_stop", index: 0 });
        await send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
        await send({ type: "message_stop" });
        response.end();
    }
  }

  return {
    server,
    requests,
    sends,
    async listen(port = 0) {
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
      const address = server.address();
      return `http://127.0.0.1:${address.port}`;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export const STUB_MARKERS = {
  answer: ANSWER,
  refusedPartial: "REFUSED_PARTIAL_MARKER",
  callOne: "CALL_ONE_MARKER",
  callTwoPartial: "CALL_TWO_PARTIAL_MARKER",
  toolPreamble: TOOL_PREAMBLE,
};
