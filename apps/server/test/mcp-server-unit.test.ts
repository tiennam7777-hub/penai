import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { isMcpPublicPath, parseScopes, pkceMatches, validRedirectUri } from "../src/mcp-server.js";
import { isPlatformRejected, loadImageInput, prepareOutboundDocument, readInboxConfig, sniffImage } from "../src/inbox.js";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

describe("MCP server — OAuth helpers", () => {
  it("PKCE S256", () => {
    const verifier = "a".repeat(43) + "-._~";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(pkceMatches(verifier, challenge)).toBe(true);
    expect(pkceMatches(verifier + "x", challenge)).toBe(false);
    expect(pkceMatches("ngan", challenge)).toBe(false);
  });

  it("callback: https hoặc http loopback", () => {
    expect(validRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(validRedirectUri("http://localhost:6274/oauth/callback")).toBe(true);
    expect(validRedirectUri("http://127.0.0.1:33418/callback")).toBe(true);
    expect(validRedirectUri("http://evil.example/cb")).toBe(false);
    expect(validRedirectUri("https://user:pw@x.example/cb")).toBe(false);
    expect(validRedirectUri("https://x.example/cb#frag")).toBe(false);
    expect(validRedirectUri("javascript:alert(1)")).toBe(false);
  });

  it("scope: mặc định đủ bộ, bỏ scope lạ", () => {
    const all = ["zalo:read", "zalo:send", "zalo:messages", "whatsapp:read", "whatsapp:send", "whatsapp:messages"];
    expect(parseScopes(undefined)).toEqual(all);
    expect(parseScopes("zalo:read offline_access")).toEqual(["zalo:read"]);
    expect(parseScopes("openid")).toEqual(all);
    expect(parseScopes("zalo:messages")).toEqual(["zalo:messages"]);
    expect(parseScopes("whatsapp:send zalo:read")).toEqual(["whatsapp:send", "zalo:read"]);
  });

  it("đường dẫn công khai (tự xác thực)", () => {
    expect(isMcpPublicPath("/mcp")).toBe(true);
    expect(isMcpPublicPath("/.well-known/oauth-protected-resource/mcp")).toBe(true);
    expect(isMcpPublicPath("/oauth/token")).toBe(true);
    expect(isMcpPublicPath("/oauth/mcp/callback")).toBe(false);
    expect(isMcpPublicPath("/v1/mcp-server")).toBe(false);
  });
});

describe("Inbox — cấu hình + ảnh gửi đi", () => {
  it("lưu file Word/Excel hợp lệ trong workspace và từ chối file giả hoặc tên không an toàn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "penai-inbox-file-"));
    try {
      const archive = new AdmZip();
      archive.addFile("[Content_Types].xml", Buffer.from("<Types/>"));
      archive.addFile("xl/workbook.xml", Buffer.from("<workbook/>"));
      const zip = archive.toBuffer();
      const path = await prepareOutboundDocument(dir, "workspace-1", "channel-1", {
        name: "Bảng giá.xlsx", contentB64: zip.toString("base64"),
      });
      expect(path).toContain(join("workspace-1", "zalo-inbox", "channel-1"));
      expect(path).toMatch(/Bảng giá\.xlsx$/);
      expect(await readFile(path)).toEqual(zip);
      await expect(prepareOutboundDocument(dir, "workspace-1", "channel-1", {
        name: "../escape.docx", contentB64: zip.toString("base64"),
      })).rejects.toThrow(/Tên file/);
      await expect(prepareOutboundDocument(dir, "workspace-1", "channel-1", {
        name: "not-word.docx", contentB64: Buffer.from("wrong").toString("base64"),
      })).rejects.toThrow(/định dạng/);
      await expect(prepareOutboundDocument(dir, "workspace-1", "channel-1", {
        name: "Bảng giá.xlsx", contentB64: "%%%",
      })).rejects.toThrow(/Nội dung/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("readInboxConfig: mặc định bật lưu, tạm dừng 30 phút", () => {
    expect(readInboxConfig({})).toEqual({ enabled: true, pauseMinutes: 30, mcpReadMessages: false, autoReaction: null, agentReply: true, photoAck: "short" });
    expect(readInboxConfig({ inbox: false, inbox_pause_minutes: 0 })).toMatchObject({ enabled: false, pauseMinutes: 0, mcpReadMessages: false });
    // Tự thả cảm xúc mặc định tắt; công tắc Agent tự trả lời mặc định bật
    expect(readInboxConfig({ auto_reaction: "heart", agent_reply: false })).toMatchObject({ autoReaction: "heart", agentReply: false });
    // Cho AI ngoài đọc tin: chỉ bật khi đặt đúng true
    expect(readInboxConfig({ mcp_read_messages: true }).mcpReadMessages).toBe(true);
    expect(readInboxConfig({ mcp_read_messages: "true" }).mcpReadMessages).toBe(false);
  });

  it("nhận diện ảnh theo byte đầu", () => {
    expect(sniffImage(PNG_1x1)).toEqual({ ext: "png", mime: "image/png" });
    expect(sniffImage(Buffer.from("GIF89a....."))?.ext).toBe("gif");
    expect(sniffImage(Buffer.from("<html>"))).toBeNull();
  });

  it("data URL hợp lệ / giả mạo", async () => {
    const img = await loadImageInput(`data:image/png;base64,${PNG_1x1.toString("base64")}`);
    expect(img.ext).toBe("png");
    await expect(loadImageInput(`data:image/png;base64,${Buffer.from("<svg/>").toString("base64")}`)).rejects.toThrow(/PNG, JPEG/);
    await expect(loadImageInput("data:text/html;base64,AAAA")).rejects.toThrow(/data:image/);
  });

  it("phân biệt lỗi Zalo từ chối (chắc chắn chưa gửi) với lỗi mạng", () => {
    const zalo = Object.assign(new Error("Tham số không hợp lệ"), { name: "ZcaApiError" });
    expect(isPlatformRejected(zalo)).toBe(true);
    expect(isPlatformRejected(Object.assign(new Error("x"), { zaloRejected: true }))).toBe(true);
    expect(isPlatformRejected(new Error("ETIMEDOUT"))).toBe(false);
  });

  it("chặn URL trỏ vào mạng nội bộ (SSRF)", async () => {
    await expect(loadImageInput("http://127.0.0.1:18800/healthz")).rejects.toThrow(/mạng nội bộ/);
    await expect(loadImageInput("http://[::1]/a.png")).rejects.toThrow(/mạng nội bộ/);
    await expect(loadImageInput("http://169.254.169.254/latest")).rejects.toThrow(/mạng nội bộ/);
    await expect(loadImageInput("file:///etc/passwd")).rejects.toThrow(/http/);
  });
});
