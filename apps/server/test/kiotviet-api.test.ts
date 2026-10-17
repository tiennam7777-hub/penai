import { afterEach, describe, expect, it, vi } from "vitest";
import { createKiotVietOrchidDraft, parseKiotVietPrice, verifyKiotVietRetailConnection } from "../src/kiotviet-api.js";

const input = {
  retailer: "orchidsworld42",
  branchName: "42 Điện Biên Phủ",
  clientId: "client-id-for-test",
  clientSecret: "secret-for-test",
};

afterEach(() => vi.unstubAllGlobals());

describe("KiotViet credential verification", () => {
  it("obtains a token and resolves the exact branch without creating an order", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "test-token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [
        { id: 7, branchName: "188 Hòa Bình" },
        { id: 42, branchName: "42 Điện Biên Phủ" },
      ] }) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(verifyKiotVietRetailConnection(input)).resolves.toEqual({ branchId: 42, branchName: "42 Điện Biên Phủ" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://id.kiotviet.vn/connect/token");
    expect(fetchMock.mock.calls[1]![0]).toBe("https://public.kiotapi.com/branches?pageSize=100");
    expect(fetchMock.mock.calls[1]![1].headers).toMatchObject({ Retailer: "orchidsworld42", Authorization: "Bearer test-token" });
  });

  it("does not use a different branch when the requested branch is missing", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "test-token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 7, branchName: "188 Hòa Bình" }] }) }));
    await expect(verifyKiotVietRetailConnection(input)).rejects.toThrow("42 Điện Biên Phủ");
  });
});

describe("KiotViet orchid order draft", () => {
  it("parses only clear total prices", () => {
    expect(parseKiotVietPrice("1.000.000đ")).toBe(1_000_000);
    expect(parseKiotVietPrice("1,5tr")).toBe(1_500_000);
    expect(parseKiotVietPrice("850k")).toBe(850_000);
    expect(parseKiotVietPrice("1 triệu + 50k ship")).toBeNull();
    expect(parseKiotVietPrice(null)).toBeNull();
  });

  it("creates one unpaid order slip with SP00016 and no invoice", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "test-token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: {
        id: 916, code: "SP00016", fullName: "LAN HỒ ĐIỆP (Cây)", isActive: true, allowsSale: true,
      } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 42, code: "DH12345" }) });
    vi.stubGlobal("fetch", fetchMock);
    const result = await createKiotVietOrchidDraft({
      ...input, branchId: 55291, customer: "Chị Mai", zaloUid: "12345", channelName: "Hot 4",
      stems: 5, color: "vàng", pot: "chậu lan", price: "1.000.000đ", delivery: "10:00 18/10/2026",
    });
    expect(result).toEqual({ orderId: 42, code: "DH12345" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]![0]).toBe("https://public.kiotapi.com/products/code/SP00016");
    const [url, options] = fetchMock.mock.calls[2]!;
    expect(url).toBe("https://public.kiotapi.com/orders");
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({ branchId: 55291, totalPayment: 0, makeInvoice: false });
    expect(body.orderDetails).toEqual([expect.objectContaining({
      productId: 916, productCode: "SP00016", quantity: 5, price: 200_000,
    })]);
    expect(body.description).toContain("Chị Mai");
    expect(body.description).toContain("Zalo UID 12345");
  });

  it("uses zero price and calls out missing price in a draft", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "test-token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 916, code: "SP00016" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: 42, code: "DH12345" } }) });
    vi.stubGlobal("fetch", fetchMock);
    await createKiotVietOrchidDraft({
      ...input, branchId: 55291, customer: "Chị Mai", zaloUid: "12345", channelName: "Hot 4",
      stems: 5, color: "vàng", pot: "chậu lan", price: null, delivery: "10:00 18/10/2026",
    });
    const body = JSON.parse(fetchMock.mock.calls[2]![1].body);
    expect(body.orderDetails[0].price).toBe(0);
    expect(body.description).toContain("giá bán");
    expect(body.orderDetails[0].note).toContain("GIÁ CHƯA CHỐT");
  });

  it("never posts if the product code differs", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "test-token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 916, code: "OTHER" }) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(createKiotVietOrchidDraft({
      ...input, branchId: 55291, customer: "Chị Mai", zaloUid: "12345", channelName: "Hot 4",
      stems: 5, color: "vàng", pot: "chậu lan", price: null, delivery: "10:00 18/10/2026",
    })).rejects.toThrow("SP00016");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
