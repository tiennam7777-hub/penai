import { expect, it, vi } from "vitest";
import { createDefaultToolRegistry } from "@penai/tools";
import type { StoredMessage, WorkspaceContext } from "@penai/shared";
import type { Provider, ChatRequest, ChatResponse, StreamEvent } from "@penai/providers";
import { runAgent } from "../src/agent-loop.js";

it("routes an address-only shipping tool call through the server callback inside the agent loop", async () => {
  const messages: StoredMessage[] = [];
  const ctx: WorkspaceContext = { workspaceId: "test-workspace", userId: "test-user", role: "operator" };
  let call = 0;
  const requests: ChatRequest[] = [];
  const provider: Provider = { name: "shipping-test",
    async chat(req): Promise<ChatResponse> {
      requests.push(req);
      return call++ === 0 ? { content: null, stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: [{ id: "ship", name: "orchid_shipping_quote", args: { destination: "31 Đống Đa, Bình Thạnh", stemCount: 7, customerType: "retail" } }] }
        : { content: "Giao miễn phí.", stopReason: "end", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async *chatStream(req): AsyncIterable<StreamEvent> { yield { type: "done", response: await this.chat(req) }; },
  };
  const quote = vi.fn().mockResolvedValue("Phí ship 0đ; 3,2 km đường bộ.");
  const events = [];
  for await (const event of runAgent({ provider, tools: createDefaultToolRegistry(), workspaceDataDir: ".data/test",
    orchidShippingQuote: quote,
    store: { loadMessages: async () => messages, appendMessage: async (_ctx, _session, input) => {
      const message = { ...input, id: String(messages.length), seq: messages.length + 1 } as StoredMessage;
      messages.push(message); return message;
    } },
  }, { ctx, sessionId: "shipping", agent: { model: "test", maxIterations: 3, systemPrompt: "Tính phí giao." }, userMessage: "31 Đống Đa, Bình Thạnh" })) events.push(event);
  expect(quote).toHaveBeenCalledWith({ destination: "31 Đống Đa, Bình Thạnh", stemCount: 7, customerType: "retail" });
  expect(events.some(e => e.type === "tool_result" && !e.isError)).toBe(true);
  expect(JSON.stringify(requests[1])).toContain("Phí ship 0đ");
});
