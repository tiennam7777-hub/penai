import { describe, expect, it } from "vitest";
import type { Provider, ChatRequest, ChatResponse } from "@penai/providers";
import type { StoredMessage } from "@penai/shared";
import { classifyOrchidSalesScope, parseOrchidScopeDecision } from "../src/orchid-sales-scope.js";

const answer = (content: string | null): ChatResponse => ({
  content, toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 },
});

describe("orchid sales scope gate", () => {
  it("allows only an exact ALLOW decision; ambiguous output stays silent", () => {
    expect(parseOrchidScopeDecision(" ALLOW \n")).toBe("allow");
    expect(parseOrchidScopeDecision("IGNORE")).toBe("ignore");
    expect(parseOrchidScopeDecision("ALLOW, because it is an order")).toBe("ignore");
    expect(parseOrchidScopeDecision(null)).toBe("ignore");
  });

  it("sends recent order context and mixed-topic instructions only to a non-streaming classifier", async () => {
    let request: ChatRequest | undefined;
    const provider: Provider = {
      name: "test",
      async chat(req) { request = req; return answer("ALLOW"); },
      async *chatStream() { throw new Error("must not stream to customer"); },
    };
    const recentMessages: StoredMessage[] = [{
      id: "1", role: "user", seq: 1,
      content: { kind: "text", text: "Giao chậu lan 8 cành lúc 8 giờ sáng" },
    }];
    const decision = await classifyOrchidSalesScope(provider, "model", {
      text: "Giao tới 42 Điện Biên Phủ nhé, tiện thể thời tiết thế nào?",
      images: ["data:image/png;base64,AAAA"],
      recentMessages,
      quotedProductPhoto: true,
    });
    expect(decision).toBe("allow");
    expect(request?.tools).toBeUndefined();
    expect(request?.system).toContain("Tin có cả nội dung liên quan hoa lan và nội dung khác vẫn là ALLOW");
    expect(request?.messages[0]?.content).toContain("Giao tới 42 Điện Biên Phủ");
    expect(request?.messages[0]?.content).toContain("Giao chậu lan 8 cành");
    expect(request?.messages[0]?.content).toContain("trích dẫn ảnh sản phẩm lan");
    expect(request?.messages[0]).toHaveProperty("images", ["data:image/png;base64,AAAA"]);
  });

  it("keeps clearly unrelated and malformed classifications silent", async () => {
    let response = answer("IGNORE");
    const provider: Provider = {
      name: "test",
      async chat() { return response; },
      async *chatStream() { throw new Error("must not stream"); },
    };
    expect(await classifyOrchidSalesScope(provider, "model", { text: "Dự báo thời tiết ngày mai?" })).toBe("ignore");
    response = { ...answer("ALLOW"), stopReason: "max_tokens" };
    expect(await classifyOrchidSalesScope(provider, "model", { text: "Hoa lan còn không?" })).toBe("ignore");
  });
});
