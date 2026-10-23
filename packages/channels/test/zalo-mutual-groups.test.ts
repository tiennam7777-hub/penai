import { describe, expect, it, vi } from "vitest";
import { ZaloPersonalChannel } from "../src/zalo-personal.js";

describe("Zalo mutual groups", () => {
  it("counts only groups containing the customer and reuses a recent group snapshot", async () => {
    const channel = new ZaloPersonalChannel({
      id: "zp-mutual", name: "Zalo", token: "{}", config: {}, requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
    });
    const api = {
      getAllGroups: vi.fn(async () => ({ gridVerMap: { "group-1": 1, "group-2": 1 } })),
      getGroupInfo: vi.fn(async () => ({ gridInfoMap: {
        "group-1": { name: "Đại lý", memberIds: ["customer-1", "staff"], hasMoreMember: 0 },
        "group-2": { name: "Nội bộ", memberIds: ["staff"], hasMoreMember: 0 },
      } })),
    };
    Object.assign(channel, { api });

    expect(await channel.mutualGroups("customer-1")).toEqual({
      groups: [{ id: "group-1", name: "Đại lý" }], incomplete: false,
    });
    expect(await channel.mutualGroups("customer-2")).toEqual({ groups: [], incomplete: false });
    expect(api.getAllGroups).toHaveBeenCalledTimes(1);
    expect(api.getGroupInfo).toHaveBeenCalledTimes(1);
  });
});
