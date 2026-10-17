import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyKiotVietRetailConnection } from "../src/kiotviet-api.js";

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
