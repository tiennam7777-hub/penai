import type { Channel, PersonalChannel } from "@penai/channels";

type OrderSource = { id: string; kind: string; workspaceId: string; config: Record<string, unknown> };
type ChannelEntry = { channel: Channel; workspaceId: string };

export function isOrchidOrderSourceKind(kind: string): boolean {
  return kind === "zalo_personal" || kind === "facebook_page";
}

/** Messenger has no Zalo groups; explicitly configured fanpages relay notices through a workspace Zalo channel. */
export function orchidOrderNotificationChannel(
  source: OrderSource, channels: ReadonlyMap<string, ChannelEntry>,
): PersonalChannel {
  if (!isOrchidOrderSourceKind(source.kind)) throw new Error("Kênh chưa hỗ trợ chuyển đơn");
  const channelId = source.kind === "facebook_page" ? source.config["orchid_order_zalo_channel_id"] : source.id;
  if (typeof channelId !== "string" || !channelId) throw new Error("Fanpage chưa cấu hình kênh Zalo báo đơn");
  const target = channels.get(channelId);
  const runtime = target?.channel as Partial<PersonalChannel> | undefined;
  if (!target || target.workspaceId !== source.workspaceId || target.channel.kind !== "zalo_personal" ||
      typeof runtime?.sendManual !== "function" || typeof runtime.isConnected !== "function" || !runtime.isConnected()) {
    throw new Error("Kênh Zalo báo đơn chưa kết nối trong đúng workspace");
  }
  return runtime as PersonalChannel;
}

export function orchidOrderSourceNotice(source: { kind: string; name: string }, threadId: string, text: string): string {
  return source.kind === "facebook_page"
    ? `Nguồn: ${source.name.replace(/[\r\n]+/g, " ").trim()} / Messenger; hội thoại: ${threadId}\n${text}` : text;
}
