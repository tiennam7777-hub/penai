import { describe, expect, it } from "vitest";
import { composeSystemPrompt } from "../src/agent-loop.js";

describe("global concise replies", () => {
  it("applies to every agent after person context without losing substantive answers", () => {
    const prompt = composeSystemPrompt("Bạn là agent bán hàng", {
      person: "AI tự xưng anh, gọi người dùng là em.",
    });
    expect(prompt).toContain("QUY TẮC TRẢ LỜI NGẮN CHO MỌI HỘI THOẠI");
    expect(prompt).toContain("‘Ok em’");
    expect(prompt).toContain("trả lời đủ đúng ý");
    expect(prompt.indexOf("AI tự xưng anh")).toBeLessThan(prompt.indexOf("QUY TẮC TRẢ LỜI NGẮN"));
  });
});
