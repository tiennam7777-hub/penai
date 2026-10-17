/** Verify KiotViet Retail API credentials without logging or returning either secret. */
export async function verifyKiotVietRetailConnection(input: {
  retailer: string;
  clientId: string;
  clientSecret: string;
  branchName: string;
}): Promise<{ branchId: number; branchName: string }> {
  const signal = AbortSignal.timeout(15_000);
  let token: string;
  try {
    const response = await fetch("https://id.kiotviet.vn/connect/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        scopes: "PublicApi.Access",
        grant_type: "client_credentials",
        client_id: input.clientId,
        client_secret: input.clientSecret,
      }),
      signal,
    });
    if (!response.ok) throw new Error("KiotViet từ chối Client ID hoặc Mã bảo mật");
    const payload = await response.json() as { access_token?: unknown };
    if (typeof payload.access_token !== "string" || !payload.access_token) {
      throw new Error("KiotViet không trả Access Token");
    }
    token = payload.access_token;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("KiotViet")) throw err;
    throw new Error("Không kết nối được máy chủ xác thực KiotViet");
  }

  try {
    const response = await fetch("https://public.kiotapi.com/branches?pageSize=100", {
      headers: { Retailer: input.retailer, Authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok) throw new Error("KiotViet từ chối truy cập chi nhánh; kiểm tra Retailer và quyền API");
    const payload = await response.json() as { data?: unknown };
    const branches = Array.isArray(payload.data) ? payload.data : [];
    const key = (name: string) => name.normalize("NFC").trim().toLocaleLowerCase("vi-VN");
    const matches = branches.filter((item): item is { id: number; branchName: string } =>
      !!item && typeof item === "object" &&
      typeof (item as { id?: unknown }).id === "number" &&
      typeof (item as { branchName?: unknown }).branchName === "string" &&
      key((item as { branchName: string }).branchName) === key(input.branchName));
    if (matches.length !== 1) throw new Error(`Không tìm thấy đúng một chi nhánh ${input.branchName} trong KiotViet`);
    return { branchId: matches[0]!.id, branchName: matches[0]!.branchName };
  } catch (err) {
    if (err instanceof Error && (err.message.startsWith("KiotViet") || err.message.startsWith("Không tìm"))) throw err;
    throw new Error("Không đọc được danh sách chi nhánh KiotViet");
  }
}
