import { describe, expect, it } from "vitest";
import { canChat, hasRole, usesAgentGrants } from "@penai/shared";
import { memberAllowed, moderatorAllowed } from "../src/web-auth.js";

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
      ["GET", "/v1/orchid-stem-report"], ["GET", "/v1/orchid-stem-report.xlsx"],
      ["GET", "/v1/inbox/orchid-after-hours"], ["PUT", "/v1/inbox/orchid-after-hours"],
    ]) expect(moderatorAllowed(method!, path!)).toBe(true);
    for (const [method, path] of [
      ["GET", "/v1/channels"], ["POST", "/v1/channels"],
      ["PATCH", "/v1/channels/abc"], ["DELETE", "/v1/channels/abc"],
      ["PUT", "/v1/channels/abc/personal/demo-threads"],
      ["GET", "/v1/channels/abc/personal/status"],
      ["GET", "/v1/users"], ["GET", "/v1/vault"],
      ["PATCH", "/v1/agents/abc"],
      ["POST", "/v1/orchid-stem-report"],
      ["POST", "/v1/inbox/orchid-after-hours"],
    ]) expect(moderatorAllowed(method!, path!)).toBe(false);
  });

  it("có đủ thao tác Inbox như quản trị trên mọi kênh", () => {
    const channel = "cdf2a276-fa3d-4fe3-a46b-3ce1162a7678";
    const tag = "02e94d65-474b-4aa7-9e78-b0ed44729439";
    for (const base of ["/v1/inbox", "/v1/zalo-inbox"]) {
      for (const [method, suffix] of [
        ["GET", "tags"], ["POST", "tags"],
        ["PUT", `tags/${tag}/color`], ["DELETE", `tags/${tag}`],
        ["PUT", "threads/12345/tags"], ["PUT", "threads/12345/visibility"],
        ["PUT", "threads/12345/note"],
        ["GET", "threads/12345/explore"], ["GET", "threads/12345/senders"],
        ["GET", "threads/12345/messages/42/context"],
        ["GET", "threads/12345/messages/by-msg-id/42"],
        ["POST", "threads/12345/delegate"],
        ["POST", "threads/12345/messages/42/state"],
        ["POST", "sync-contacts"], ["PUT", "settings"],
      ]) expect(moderatorAllowed(method!, `${base}/${channel}/${suffix}`)).toBe(true);
      expect(moderatorAllowed("GET", `${base}/channels`)).toBe(true);
      expect(moderatorAllowed("GET", `${base}/events`)).toBe(true);
      expect(moderatorAllowed("POST", `${base}/${channel}-other/threads/12345/send`)).toBe(false);
      expect(moderatorAllowed("POST", `${base}/not-an-inbox-channel/threads/12345/send`)).toBe(false);
    }
  });

  it("mọi vai trò trực Inbox đọc và quản lý cùng tin nhắn nhanh, không mở route khác", () => {
    const channel = "cdf2a276-fa3d-4fe3-a46b-3ce1162a7678";
    const id = "02e94d65-474b-4aa7-9e78-b0ed44729439";
    for (const base of ["/v1/inbox", "/v1/zalo-inbox"]) {
      for (const [method, suffix] of [
        ["GET", "quick-replies"], ["POST", "quick-replies"],
        ["PUT", `quick-replies/${id}`], ["DELETE", `quick-replies/${id}`],
      ]) {
        expect(memberAllowed(method!, `${base}/${channel}/${suffix}`)).toBe(true);
        expect(moderatorAllowed(method!, `${base}/${channel}/${suffix}`)).toBe(true);
      }
      expect(memberAllowed("POST", `${base}/${channel}/settings`)).toBe(false);
      expect(moderatorAllowed("POST", `${base}/not-an-inbox-channel/quick-replies`)).toBe(false);
    }
  });

  it("thành viên được gọi API bật tắt trợ lý ngoài giờ, không được gọi API quản trị Inbox", () => {
    expect(memberAllowed("GET", "/v1/inbox/orchid-after-hours")).toBe(true);
    expect(memberAllowed("PUT", "/v1/inbox/orchid-after-hours")).toBe(true);
    expect(memberAllowed("POST", "/v1/inbox/orchid-after-hours")).toBe(false);
    expect(memberAllowed("PUT", "/v1/inbox/orchid-after-hours/other")).toBe(false);
  });
});
