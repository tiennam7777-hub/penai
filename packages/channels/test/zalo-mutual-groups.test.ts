import { describe, expect, it, vi } from "vitest";
import { ZaloPersonalChannel } from "../src/zalo-personal.js";

describe("Zalo mutual groups", () => {
  it("uses Zalo's related group IDs and caches the result for each customer", async () => {
    const channel = new ZaloPersonalChannel({
      id: "zp-mutual", name: "Zalo", token: "{}", config: {}, requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
    });
    const api = {
      getRelatedFriendGroup: vi.fn(async (id: string) => ({ groupRelateds: { [id]: id === "customer-1" ? ["group-1", "group-2"] : [] } })),
      getGroupInfo: vi.fn(async () => ({ gridInfoMap: {
        "group-1": { name: "Đại lý", memberIds: [] },
        "group-2": { name: "Nội bộ", memberIds: [] },
      } })),
    };
    Object.assign(channel, { api });

    expect(await channel.mutualGroups("customer-1")).toEqual({
      groups: [{ id: "group-1", name: "Đại lý" }, { id: "group-2", name: "Nội bộ" }], incomplete: false,
    });
    expect(await channel.mutualGroups("customer-2")).toEqual({ groups: [], incomplete: false });
    expect(await channel.mutualGroups("customer-1")).toEqual({ groups: [{ id: "group-1", name: "Đại lý" }, { id: "group-2", name: "Nội bộ" }], incomplete: false });
    expect(api.getRelatedFriendGroup).toHaveBeenCalledTimes(2);
    expect(api.getGroupInfo).toHaveBeenCalledTimes(1);
  });
});
