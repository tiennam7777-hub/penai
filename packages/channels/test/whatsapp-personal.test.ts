import { describe, expect, it } from "vitest";
import {
  describeWhatsappContent,
  isPersonalChannelKind,
  isValidThreadId,
  isWhatsappThreadId,
  normalizeWhatsappPhone,
  personalPlatformLabel,
  whatsappThreadToJid,
  WhatsappPersonalChannel,
} from "../src/index.js";

describe("WhatsApp cá nhân — tiện ích", () => {
  it("chuẩn hóa số điện thoại: số Việt Nam bắt đầu bằng 0 → 84…", () => {
    expect(normalizeWhatsappPhone("0938 583 264")).toBe("84938583264");
    expect(normalizeWhatsappPhone("+84 938-583-264")).toBe("84938583264");
    expect(normalizeWhatsappPhone("0084938583264")).toBe("84938583264");
    expect(normalizeWhatsappPhone("6591234567")).toBe("6591234567");
  });

  it("mã hội thoại ↔ JID", () => {
    expect(whatsappThreadToJid("84938583264")).toBe("84938583264@s.whatsapp.net");
    expect(whatsappThreadToJid("120363041234567890@g.us")).toBe("120363041234567890@g.us");
    expect(whatsappThreadToJid("123456789012345@lid")).toBe("123456789012345@lid");
    expect(isWhatsappThreadId("84938583264")).toBe(true);
    expect(isWhatsappThreadId("84938583264-1600000000@g.us")).toBe(true);
    expect(isWhatsappThreadId("status@broadcast")).toBe(false);
    expect(isWhatsappThreadId("../etc/passwd")).toBe(false);
  });

  it("mã hội thoại hợp lệ theo từng nền tảng", () => {
    expect(isValidThreadId("zalo_personal", "8417834533475765420")).toBe(true);
    expect(isValidThreadId("zalo_personal", "84938583264@s.whatsapp.net")).toBe(false);
    expect(isValidThreadId("whatsapp_personal", "120363041234567890@g.us")).toBe(true);
    expect(isValidThreadId("whatsapp_personal", "abc")).toBe(false);
    expect(isPersonalChannelKind("whatsapp_personal")).toBe(true);
    expect(isPersonalChannelKind("whatsapp")).toBe(false);
    expect(personalPlatformLabel("whatsapp_personal")).toBe("WhatsApp");
  });

  it("mô tả nội dung tin cho Inbox", () => {
    expect(describeWhatsappContent({ conversation: "Xin chào" })).toEqual({ contentType: "text", text: "Xin chào" });
    expect(describeWhatsappContent({ extendedTextMessage: { text: "Trả lời" } })).toEqual({ contentType: "text", text: "Trả lời" });
    expect(describeWhatsappContent({ imageMessage: { caption: "Ảnh mẫu" } })).toEqual({ contentType: "photo", text: "Ảnh mẫu" });
    expect(describeWhatsappContent({ documentMessage: { fileName: "bao-gia.pdf", fileLength: 2048 } })).toEqual({
      contentType: "file",
      text: "",
      media: { name: "bao-gia.pdf", size: 2048 },
    });
    // Tin tự hủy / xem một lần bọc nội dung bên trong
    expect(describeWhatsappContent({ ephemeralMessage: { message: { conversation: "Tin tự hủy" } } })).toEqual({
      contentType: "text",
      text: "Tin tự hủy",
    });
    // Tin mẫu của tài khoản doanh nghiệp, lời mời vào nhóm
    expect(
      describeWhatsappContent({ templateMessage: { hydratedTemplate: { hydratedContentText: "Mã xác thực của bạn là 123456" } } }),
    ).toEqual({ contentType: "text", text: "Mã xác thực của bạn là 123456" });
    expect(describeWhatsappContent({ groupInviteMessage: { groupName: "Nhóm bán hàng" } })).toEqual({
      contentType: "other",
      text: "Lời mời vào nhóm: Nhóm bán hàng",
    });
    expect(describeWhatsappContent({ placeholderMessage: {} })).toBeNull();
    // Không phải nội dung trò chuyện
    expect(describeWhatsappContent({ reactionMessage: { text: "❤️" } })).toBeNull();
    expect(describeWhatsappContent({ protocolMessage: {} })).toBeNull();
    expect(describeWhatsappContent(null)).toBeNull();
  });
});

it("WhatsApp image with caption receives a reply, while image without text stays silent", async () => {
  const sent: string[] = [];
  let inboundMedia: unknown;
  const channel = new WhatsappPersonalChannel({
    id: "wa-silent-photo", name: "WhatsApp", token: "{}", config: { auto_reaction: "heart" },
    requirePairing: false,
    onInbound: async (message, hooks) => {
      inboundMedia = message.media;
      hooks?.onStatus?.("thinking");
      hooks?.onBlockReply?.("Phản hồi sớm");
      return { kind: "reply", text: "Giá mẫu này là 1,6 triệu ạ." };
    },
  });
  const internals = channel as unknown as Record<string, unknown>;
  internals.toLog = async () => ({
    entry: { direction: "in", contentType: "photo", text: "Mẫu này giá bao nhiêu?",
      peerKind: "direct", threadId: "84900000000", senderId: "84900000000", senderName: "Khách" },
    chatKey: "direct:84900000000", media: [], mentioned: true,
  });
  internals.isThreadEnabled = () => true;
  internals.sendText = async (_threadId: string, _peerKind: string, text: string) => { sent.push(text); return []; };
  const handle = (channel as unknown as { handleMessage: (sock: unknown, m: unknown, live: boolean) => Promise<void> }).handleMessage.bind(channel);
  await handle({ sendPresenceUpdate: async () => { sent.push("typing"); } }, { key: { id: "photo-1", fromMe: false } }, true);
  expect(inboundMedia).toMatchObject([{ kind: "photo" }]);
  expect(sent).toContain("Phản hồi sớm");
  expect(sent).toContain("Giá mẫu này là 1,6 triệu ạ.");
  sent.length = 0;
  internals.toLog = async () => ({
    entry: { direction: "in", contentType: "photo", text: "",
      peerKind: "direct", threadId: "84900000000", senderId: "84900000000", senderName: "Khách" },
    chatKey: "direct:84900000000", media: [], mentioned: true,
  });
  await handle({ sendPresenceUpdate: async () => { sent.push("typing"); } }, { key: { id: "photo-2", fromMe: false } }, true);
  expect(sent).toEqual([]);
});
