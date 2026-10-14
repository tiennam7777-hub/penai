import { describe, expect, it } from "vitest";
import { canChat, hasRole, usesAgentGrants } from "@penai/shared";
import { moderatorAllowed } from "../src/web-auth.js";

describe("moderator capability boundary", () => {
  it("chat theo agent được gán, không kế thừa quyền operator", () => {
    expect(canChat("moderator")).toBe(true);
    expect(usesAgentGrants("moderator")).toBe(true);
    expect(hasRole("moderator", "operator")).toBe(false);
    expect(hasRole("moderator", "viewer")).toBe(false);
  });

  it("cho duyệt, Contacts và Thư viện, chặn cấu hình kênh và trang khác", () => {
    for (const [method, path] of [
      ["GET", "/v1/agents"], ["POST", "/v1/chat"],
      ["GET", "/v1/channel-pairings/pending"], ["GET", "/v1/channels/pending-sources"],
      ["POST", "/v1/channels/abc/pairings/CODE/approve"],
      ["GET", "/v1/channels/abc/personal/observed"],
      ["POST", "/v1/channels/abc/personal/approve-observed"],
      ["PATCH", "/v1/channels/abc/personal/observed-review"],
      ["GET", "/v1/library"], ["PUT", "/v1/library/shared/file"],
      ["DELETE", "/v1/library/shared/entry"],
      ["GET", "/v1/contacts"], ["PUT", "/v1/contacts/abc/profile"],
      ["POST", "/v1/contact-tags"],
    ]) expect(moderatorAllowed(method!, path!)).toBe(true);
    for (const [method, path] of [
      ["GET", "/v1/channels"], ["POST", "/v1/channels"],
      ["PATCH", "/v1/channels/abc"], ["DELETE", "/v1/channels/abc"],
      ["PUT", "/v1/channels/abc/personal/demo-threads"],
      ["GET", "/v1/channels/abc/personal/status"],
      ["GET", "/v1/users"], ["GET", "/v1/vault"],
      ["PATCH", "/v1/agents/abc"],
    ]) expect(moderatorAllowed(method!, path!)).toBe(false);
  });
});
