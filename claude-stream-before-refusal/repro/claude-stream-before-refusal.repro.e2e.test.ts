// Repro for Claude 5.x replies held until message_stop. Copy this file and
// claude-stream-repro-stub.mjs into test/ of an OpenClaw checkout.
// A loopback Anthropic SSE stub sleeps between deltas and logs each frame's send time; a real
// Gateway with a real agent records every `agent`/`chat` event the operator client receives.
//
//   REPRO_OUT=<dir> REPRO_DELAY_MS=600 REPRO_WITH_FLAG=1 \
//     node scripts/run-vitest.mjs run --config test/vitest/vitest.e2e.config.ts \
//     test/claude-stream-before-refusal.repro.e2e.test.ts
//
// REPRO_WITH_FLAG=0 omits the opted-in provider (main rejects the unknown compat key).
// REPRO_SERVE_MS keeps the Gateway up on REPRO_PORT for a browser after the scenarios.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../src/config/types.models.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
// @ts-expect-error The stub is plain ESM without declarations.
import { createAnthropicSseStub, STUB_MARKERS } from "./claude-stream-repro-stub.mjs";
import { useRuntimeProofFixture } from "./runtime-proof.test-support.js";

const createFixture = useRuntimeProofFixture(afterEach);
const TOKEN = "claude-stream-repro-token";
const OUT = process.env.REPRO_OUT ?? path.join(process.cwd(), ".artifacts", "claude-stream-repro");
const DELAY_MS = Number(process.env.REPRO_DELAY_MS ?? 600);
const WITH_FLAG = process.env.REPRO_WITH_FLAG !== "0";
const SERVE_MS = Number(process.env.REPRO_SERVE_MS ?? 0);
const PORT = process.env.REPRO_PORT ? Number(process.env.REPRO_PORT) : undefined;

type Logged = { at: number; event: string; payload: Record<string, unknown> };

function model(id: string, compat?: Record<string, unknown>): ModelDefinitionConfig {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
    ...(compat ? { compat } : {}),
  } as ModelDefinitionConfig;
}

function provider(baseUrl: string, models: ModelDefinitionConfig[]): ModelProviderConfig {
  return {
    baseUrl,
    apiKey: "sk-ant-api03-stream-repro", // pragma: allowlist secret
    api: "anthropic-messages",
    models,
  };
}

it(
  "records when Claude 5.x deltas reach a Gateway operator client",
  { timeout: 600_000 + Number(process.env.REPRO_SERVE_MS ?? 0) },
  async () => {
    await fs.mkdir(OUT, { recursive: true });
    const fixture = await createFixture("openclaw-claude-stream-repro-", TOKEN);
    const stubLog: object[] = [];
    const stub = createAnthropicSseStub({
      delayMs: DELAY_MS,
      workspaceDir: fixture.workspaceDir,
      log: (entry: object) => stubLog.push(entry),
    });
    const stubUrl = await stub.listen();
    const providers: Record<string, ModelProviderConfig> = {
      buffered: provider(stubUrl, [model("claude-sonnet-5-5")]),
      control: provider(stubUrl, [model("claude-sonnet-4-6")]),
      ...(WITH_FLAG
        ? { streamed: provider(stubUrl, [model("claude-sonnet-5-5", { streamBeforeRefusal: true })]) }
        : {}),
    };
    const agents = {
      main: { model: { primary: "buffered/claude-sonnet-5-5" } },
      control: { model: { primary: "control/claude-sonnet-4-6" } },
      ...(WITH_FLAG ? { streamed: { model: { primary: "streamed/claude-sonnet-5-5" } } } : {}),
    };
    const base = fixture.config({
      providerId: "buffered",
      modelRef: "buffered/claude-sonnet-5-5",
      config: providers.buffered!,
    });
    const cfg = {
      ...base,
      agents: { ...base.agents, ownership: "explicit", entries: agents },
      models: { mode: "replace", providers },
    };
    const events: Logged[] = [];
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      gateway = await startGatewayWithClient({
        cfg,
        configPath: fixture.configPath,
        token: TOKEN,
        clientDisplayName: "claude-stream-repro",
        ...(PORT ? { port: PORT } : {}),
      });
      // A second operator client with the tool-events capability observes tool progress.
      const toolObserver = await connectGatewayClient({
        url: `ws://127.0.0.1:${gateway.port}`,
        token: TOKEN,
        clientDisplayName: "claude-stream-repro-tools",
        caps: ["tool-events"],
        onEvent: (evt) => {
          const payload = (evt.payload ?? {}) as Record<string, unknown>;
          if (evt.event === "agent" && payload.stream === "tool") {
            events.push({ at: Date.now(), event: "tool", payload });
          } else if (evt.event === "agent" || evt.event === "chat") {
            events.push({ at: Date.now(), event: evt.event, payload });
          }
        },
      });
      const client = toolObserver;
      const runs: Array<Record<string, unknown>> = [];
      const plan: Array<[agent: string, scenario: string]> = [
        ["control", "answer"],
        ["main", "answer"],
        ["main", "refusal"],
        ["main", "cut"],
        ["main", "tool-refusal"],
        ["main", "two-calls"],
        ...(WITH_FLAG
          ? ([
              ["streamed", "answer"],
              ["streamed", "refusal"],
              ["streamed", "cut"],
              ["streamed", "tool-refusal"],
              ["streamed", "two-calls"],
            ] as Array<[string, string]>)
          : []),
      ];
      const only = process.env.REPRO_ONLY?.split(",").filter(Boolean);
      const selected = only ? plan.filter(([a, s]) => only.includes(`${a}:${s}`)) : plan;
      for (const [agent, scenario] of selected) {
        const sessionKey = `agent:${agent}:repro-${scenario}`;
        const firstEvent = events.length;
        const firstSend = stub.sends.length;
        const firstRequest = stub.requests.length;
        const sentAt = Date.now();
        const started = await client.request<{ runId?: string; status?: string }>(
          "chat.send",
          {
            sessionKey,
            message: `[scenario:${scenario}] Please answer.`,
            deliver: false,
            idempotencyKey: `repro-${agent}-${scenario}`,
          },
        );
        const waited = await client.request<{ status?: string; error?: unknown }>(
          "agent.wait",
          { runId: started.runId, timeoutMs: 120_000 },
          { timeoutMs: 125_000 },
        );
        // Let terminal chat events and transcript writes settle.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const history = await client.request<{ messages?: unknown[] }>("chat.history", {
          sessionKey,
          limit: 50,
        });
        const runEvents = events.slice(firstEvent).filter(
          (e) => (e.payload.sessionKey ?? sessionKey) === sessionKey || e.event === "agent",
        );
        const sends = stub.sends.slice(firstSend);
        const requests = stub.requests.slice(firstRequest).filter((r: { scenario: string }) => r.scenario === scenario);
        const requestIndexes = new Set(requests.map((r: { index: number }) => r.index));
        const scenarioSends = sends.filter((s: { request: number }) => requestIndexes.has(s.request));
        const contentSends = scenarioSends.filter((s: { type: string }) => s.type === "content_block_delta");
        const providerEnd = scenarioSends.filter((s: { type: string }) => s.type === "message_stop").at(-1)?.at;
        const cut = stubLog.find(
          (entry) => (entry as { type?: string; request?: number }).type === "stub-cut" && requestIndexes.has((entry as { request: number }).request),
        ) as { at: number } | undefined;
        const deltaEvents = runEvents.filter(
          (e) =>
            e.event === "agent" &&
            (e.payload.stream === "assistant" || e.payload.stream === "thinking") &&
            typeof (e.payload.data as { delta?: unknown } | undefined)?.delta === "string" &&
            ((e.payload.data as { delta: string }).delta.length > 0),
        );
        const workspaceFiles = (
          await fs.readdir(path.dirname(fixture.stateDir), { recursive: true }).catch(() => [])
        ).map(String);
        const serializedHistory = JSON.stringify(history.messages ?? []);
        const terminalChat = runEvents.filter((e) => e.event === "chat" && e.payload.state !== "delta").at(-1);
        runs.push({
          agent,
          scenario,
          waitStatus: waited.status,
          providerRequests: requests.length,
          toolResultRequests: requests.filter((r: { toolResult: boolean }) => r.toolResult).length,
          firstProviderDeltaMs: contentSends[0] ? contentSends[0].at - sentAt : null,
          lastProviderDeltaMs: contentSends.at(-1) ? contentSends.at(-1).at - sentAt : null,
          providerEndMs: providerEnd ? providerEnd - sentAt : cut ? cut.at - sentAt : null,
          clientDeltaCount: deltaEvents.length,
          firstClientDeltaMs: deltaEvents[0] ? deltaEvents[0].at - sentAt : null,
          lastClientDeltaMs: deltaEvents.at(-1) ? deltaEvents.at(-1)!.at - sentAt : null,
          clientDeltaOffsetsMs: deltaEvents.map((e) => e.at - sentAt),
          terminalChat: terminalChat
            ? {
                state: terminalChat.payload.state,
                errorKind: terminalChat.payload.errorKind,
                errorMessage: terminalChat.payload.errorMessage,
                messageText: JSON.stringify(terminalChat.payload.message ?? null).slice(0, 200),
              }
            : null,
          toolEvents: runEvents
            .filter((e) => e.event === "tool")
            .map((e) => {
              const data = (e.payload.data ?? {}) as Record<string, unknown>;
              return `${e.at - sentAt}ms ${String(data.phase)} ${String(data.name)} ${String(data.toolCallId ?? "")}`;
            }),
          thinkingWithdrawals: runEvents
            .filter(
              (e) =>
                e.event === "agent" &&
                e.payload.stream === "thinking" &&
                (e.payload.data as { replace?: unknown } | undefined)?.replace === true,
            )
            .map((e) => ({ ms: e.at - sentAt, text: (e.payload.data as { text?: string }).text })),
          withdrawals: runEvents
            .filter(
              (e) =>
                e.event === "agent" &&
                e.payload.stream === "assistant" &&
                (e.payload.data as { replace?: unknown } | undefined)?.replace === true,
            )
            .map((e) => ({ ms: e.at - sentAt, text: (e.payload.data as { text?: string }).text })),
          historyHasRefusedPartial: serializedHistory.includes(STUB_MARKERS.refusedPartial),
          historyHasCallOne: serializedHistory.includes(STUB_MARKERS.callOne),
          historyHasCallTwoPartial: serializedHistory.includes(STUB_MARKERS.callTwoPartial),
          workspaceFiles: workspaceFiles.filter((f) => f.endsWith("_EXECUTED.txt")),
          toolResults: (history.messages ?? [])
            .filter((m) => (m as { role?: string }).role === "toolResult")
            .map((m) => ({
              toolCallId: (m as { toolCallId?: string }).toolCallId,
              isError: (m as { isError?: boolean }).isError,
            })),
        });
        await fs.writeFile(
          path.join(OUT, `events-${agent}-${scenario}.json`),
          JSON.stringify({ sentAt, sends, requests, events: runEvents, history }, null, 2),
        );
      }
      await disconnectGatewayClient(toolObserver).catch(() => undefined);
      await fs.writeFile(path.join(OUT, "summary.json"), JSON.stringify(runs, null, 2));
      await fs.writeFile(path.join(OUT, "stub-log.json"), JSON.stringify(stubLog, null, 2));
      expect(runs.length).toBe(selected.length);
      if (SERVE_MS > 0) {
        await fs.writeFile(
          path.join(OUT, "serve.json"),
          JSON.stringify({ port: gateway.port, token: TOKEN, until: Date.now() + SERVE_MS }),
        );
        await new Promise((resolve) => setTimeout(resolve, SERVE_MS));
      }
    } finally {
      await fixture.close(gateway, stub.server, true);
    }
  },
);
