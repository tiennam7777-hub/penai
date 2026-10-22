import { afterEach, expect, it, vi } from "vitest";
import { ZaloPersonalChannel } from "../src/zalo-personal.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("retries an empty Zalo CDN photo before handing it to OC2", async () => {
  vi.useFakeTimers();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(Buffer.alloc(0), { status: 200, headers: { "content-type": "image/jpeg" } }))
    .mockResolvedValueOnce(new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } }));
  vi.stubGlobal("fetch", fetchMock);
  const channel = new ZaloPersonalChannel({
    id: "oc2-retry", name: "OC2", token: "{}", config: {}, requirePairing: false,
    onInbound: async () => ({ kind: "ignore" }),
  });
  const collect = (channel as unknown as {
    collectMedia: (content: unknown, msgType: string, photoEditOnlyGroup: boolean) => Promise<Array<{ kind: string; dataUrl?: string }>>;
  }).collectMedia.bind(channel);
  const pending = collect({ href: "https://f47-photo.talk.zdn.vn/original.jpg" }, "chat.photo", true);
  await vi.advanceTimersByTimeAsync(1_000);
  const media = await pending;
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(media).toMatchObject([{ kind: "photo", dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}` }]);
});
