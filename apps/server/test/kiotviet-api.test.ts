import { afterEach, describe, expect, it, vi } from "vitest";
import { createKiotVietOrchidDraft, findKiotVietUser, parseKiotVietPrice, readKiotVietOrderSlip, verifyKiotVietRetailConnection } from "../src/kiotviet-api.js";

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
  it("resolves a cashier by exact login over the KiotViet API", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "test-token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [
        { id: 9, userName: "someone", givenName: "Other" },
        { id: 77, userName: "Trolyanam", givenName: "Trợ Lý" },
      ], total: 2 }) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(findKiotVietUser({
      retailer: input.retailer, clientId: input.clientId, clientSecret: input.clientSecret,
      username: "Trolyanam",
    })).resolves.toEqual({ id: 77, username: "Trolyanam", name: "Trợ Lý" });
    expect(fetchMock.mock.calls[1]![0]).toBe("https://public.kiotapi.com/users?pageSize=100&currentItem=0");
  });

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
        saleTax: { taxId: 2, value: 5 },
      } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 22, code: "KH22", name: "Chị Mai" }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 42, code: "DH12345" }) });
    vi.stubGlobal("fetch", fetchMock);
    const result = await createKiotVietOrchidDraft({
      ...input, branchId: 55291, cashierUserId: 77, customer: "Chị Mai", channelName: "Hot 4",
      stems: 5, color: "vàng", pot: "chậu lan", price: "1.000.000đ", delivery: "10:00 18/10/2026",
    });
    expect(result).toMatchObject({ orderId: 42, code: "DH12345", customerName: "Chị Mai" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1]![0]).toBe("https://public.kiotapi.com/products/code/SP00016");
    const [url, options] = fetchMock.mock.calls[3]!;
    expect(url).toBe("https://public.kiotapi.com/orders");
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({ branchId: 55291, cashierId: 77, totalPayment: 0, makeInvoice: false,
      customer: { id: 22, code: "KH22", name: "Chị Mai" }, orderDelivery: { partnerDeliveryId: 107020 } });
    expect(body.description).toContain("Khách chat: Chị Mai; nguồn Hot 4 / Zalo.");
    expect(body).not.toHaveProperty("soldById");
    expect(body.orderDetails).toEqual([expect.objectContaining({
      productId: 916, productCode: "SP00016", quantity: 5, price: 200_000,
      orderDetailTaxs: [{ taxId: 1 }],
    })]);
    expect(body.description).toContain("Chị Mai");
    expect(body.description).not.toMatch(/\b(?:UID|ID)\s+\d+/i);
  });

  it("uses zero price and calls out missing price in a draft", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "test-token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 916, code: "SP00016", saleTax: { taxId: 2 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 22, code: "KH22", name: "Chị Mai" }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: 42, code: "DH12345" } }) });
    vi.stubGlobal("fetch", fetchMock);
    await createKiotVietOrchidDraft({
      ...input, branchId: 55291, customer: "Chị Mai", channelName: "Hot 4",
      stems: 5, color: "vàng", pot: "chậu lan", price: null, delivery: "10:00 18/10/2026",
    });
    const body = JSON.parse(fetchMock.mock.calls[3]![1].body);
    expect(body.orderDetails[0].price).toBe(0);
    expect(body.description).toContain("giá bán");
    expect(body.description).toContain("Giá hoa: chưa chốt");
  });

  it("never posts if the product code differs", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "test-token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 916, code: "OTHER" }) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(createKiotVietOrchidDraft({
      ...input, branchId: 55291, customer: "Chị Mai", channelName: "Hot 4",
      stems: 5, color: "vàng", pot: "chậu lan", price: null, delivery: "10:00 18/10/2026",
    })).rejects.toThrow("SP00016");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports KiotViet's validation message without storing contact details", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "test-token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 916, code: "SP00016" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 22, code: "KH22", name: "Chị Mai" }] }) })
      .mockResolvedValueOnce({ ok: false, status: 420, json: async () => ({
        message: "Sai dòng thuế cho 0901234567\nliên hệ mai@example.com",
      }) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(createKiotVietOrchidDraft({
      ...input, branchId: 55291, customer: "Chị Mai", channelName: "Hot 4",
      stems: 5, color: "vàng", pot: "chậu lan", price: "1.000.000đ", delivery: null,
    })).rejects.toThrow("HTTP 420): Sai dòng thuế cho [số điện thoại] liên hệ [email]");
  });

  it("uses the 0% tax row accepted by KiotViet for a draft order", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "test-token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 916, code: "SP00016", saleTax: { taxId: 2 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 22, code: "KH22", name: "Chị Mai" }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 42, code: "DH12345" }) });
    vi.stubGlobal("fetch", fetchMock);
    await createKiotVietOrchidDraft({
      ...input, branchId: 55291, customer: "Chị Mai", channelName: "Hot 4",
      stems: 5, color: "vàng", pot: "chậu lan", price: "1.000.000đ", delivery: "10:00 18/10/2026",
    });
    const body = JSON.parse(fetchMock.mock.calls[3]![1].body);
    expect(body.orderDetails[0].orderDetailTaxs).toEqual([{ taxId: 1 }]);
    expect(body.orderDetails).toHaveLength(1);
    expect(body.makeInvoice).toBe(false);
  });

  it("matches the phone, adds quoted shipping and company VAT, and records delivery", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 916, code: "SP00016" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 123, code: "KH123", name: "Anh Nam", contactNumber: "0901234567" }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 921, code: "SP00021" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 922, code: "SP00022" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 50, code: "DH50" }) });
    vi.stubGlobal("fetch", fetchMock);
    await createKiotVietOrchidDraft({ ...input, branchId: 55291, customer: "Anh Nam 0901234567",
      channelName: "Hot 1", stems: 5, color: "vàng", pot: "chậu sứ",
      price: "1.000.000đ", delivery: "09:00 19/10/2026", address: "12 Lê Lợi, TP.HCM",
      shippingFee: "50k", vatFee: "100k", companyInvoice: true, cardText: "Chúc mừng",
      instructions: "Gửi lễ tân", recipientPhone: "0911111111" });
    expect(fetchMock.mock.calls[2]![0]).toContain("contactNumber=0901234567");
    const body = JSON.parse(fetchMock.mock.calls[5]![1].body);
    expect(body.customer.id).toBe(123);
    expect(body.orderDetails.map((x: { productCode: string; quantity: number; price: number }) =>
      [x.productCode, x.quantity, x.price])).toEqual([
      ["SP00016", 5, 200_000], ["SP00021", 1, 50_000], ["SP00022", 1, 100_000],
    ]);
    expect(body.orderDetails.every((x: { orderDetailTaxs: unknown[] }) =>
      JSON.stringify(x.orderDetailTaxs) === JSON.stringify([{ taxId: 1 }]))).toBe(true);
    expect(body.orderDelivery).toMatchObject({ partnerDeliveryId: 107020,
      address: "12 Lê Lợi, TP.HCM", contactNumber: "0911111111",
      expectedDelivery: "2026-10-19T02:00:00.000Z" });
    expect(body.description).toContain("Bảng chữ: Chúc mừng");
    expect(body.description).toContain("Lưu ý: Gửi lễ tân");
    expect(body.makeInvoice).toBe(false);
  });

  it("uses the named fallback customer and leaves delivery time open when promised later", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 916, code: "SP00016" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 30509890, code: "KH011293", name: "Chưa tìm ra tên" }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 50, code: "DH50" }) });
    vi.stubGlobal("fetch", fetchMock);
    await createKiotVietOrchidDraft({ ...input, branchId: 55291, customer: "Khách lạ",
      channelName: "Hot 1", stems: 5, color: "vàng", pot: "chậu sứ",
      price: "1.000.000đ", delivery: null, companyInvoice: false, vatFee: "100k" });
    const body = JSON.parse(fetchMock.mock.calls[4]![1].body);
    expect(body.customer.id).toBe(30509890);
    expect(body.orderDetails).toHaveLength(1);
    expect(body.orderDelivery).not.toHaveProperty("expectedDelivery");
    expect(body.description).toContain("Giao: khách báo sau");
  });

  it("reads the saved Kiot order before publishing its image", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 50, code: "DH50", total: 1_000_000,
        customerName: "Chị Mai", description: "Chậu 5 cành, màu vàng", orderDetails: [
          { productCode: "SP00016", productName: "LAN HỒ ĐIỆP", quantity: 5, price: 200_000 },
        ], orderDelivery: { partnerDeliveryId: 107020, expectedDelivery: "2026-10-19T09:00:00",
          partnerDelivery: { code: "DT000001", name: "Anh Sang" } } }) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(readKiotVietOrderSlip({ ...input, orderId: 50, code: "DH50" })).resolves.toMatchObject({
      total: 1_000_000, customer: "Chị Mai", partner: "Anh Sang",
      details: [{ code: "SP00016", quantity: 5, price: 200_000 }],
    });
    expect(fetchMock.mock.calls[1]![0]).toBe("https://public.kiotapi.com/orders/50");
  });

  it("fills missing slip fields only after -cn and preserves staff customer, cashier, date and address", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 916, code: "SP00016" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 921, code: "SP00021" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 42, code: "DH42", status: 1,
        branchId: 55291, totalPayment: 0, purchaseDate: "2026-10-18T00:53:37",
        customerId: 99, customerCode: "KH99", customerName: "Khách nhân viên đã chọn", soldById: 66,
        description: "Chậu: 10 cành. Màu: vàng. Giao: 09:00 19/10/2026. Địa chỉ: 495 La Xuan Oai. Giá hoa: chưa chốt. Cần bổ sung: giá bán. Khách chat: Chị Mai; nguồn Hot 1 / Zalo UID 12345.",
        orderDetails: [{ productId: 916, productCode: "SP00016", quantity: 10, price: 0 }],
        orderDelivery: { expectedDelivery: "2026-10-19T09:00:00", address: "495 La Xuan Oai" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 42, code: "DH42" }) });
    vi.stubGlobal("fetch", fetchMock);
    await createKiotVietOrchidDraft({ ...input, branchId: 55291, cashierUserId: 77, customer: "Chị Mai",
      channelName: "Hot 1", stems: 10, color: "vàng", pot: "chậu thấp", price: "1.600.000đ",
      shippingFee: "135.000đ", delivery: "09:00 26/10/2026", address: "495 La Xuan Oai",
      existing: { orderId: 42, code: "DH42", fillMissing: true } });
    const [url, options] = fetchMock.mock.calls[4]!;
    expect(url).toBe("https://public.kiotapi.com/orders/42");
    expect(options.method).toBe("PUT");
    const body = JSON.parse(options.body);
    expect(body.id).toBe(42);
    expect(body.orderDelivery).toMatchObject({ type: 1, partnerDeliveryId: 107020,
      partnerDelivery: { code: "DT000001", name: "Anh Sang" },
      expectedDelivery: "2026-10-19T09:00:00" });
    expect(body.makeInvoice).toBe(false);
    expect(body.orderDetails.map((x: {productCode:string})=>x.productCode)).toEqual(["SP00016", "SP00021"]);
    expect(body.customer).toMatchObject({ id: 99, name: "Khách nhân viên đã chọn" });
    expect(body.cashierId).toBe(77);
    expect(body.soldById).toBe(66);
    expect(body.orderDetails[0].price).toBe(160000);
    expect(body.description).toContain("Khách chat: Chị Mai; nguồn Hot 1 / Zalo.");
    expect(body.description).not.toContain("UID 12345");
  });
});
