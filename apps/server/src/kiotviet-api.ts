/** Verify KiotViet Retail API credentials without logging or returning either secret. */
async function accessToken(clientId: string, clientSecret: string, signal: AbortSignal): Promise<string> {
  const response = await fetch("https://id.kiotviet.vn/connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      scopes: "PublicApi.Access", grant_type: "client_credentials",
      client_id: clientId, client_secret: clientSecret,
    }),
    signal,
  });
  if (!response.ok) throw new Error("KiotViet từ chối Client ID hoặc Mã bảo mật");
  const payload = await response.json() as { access_token?: unknown };
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("KiotViet không trả Access Token");
  }
  return payload.access_token;
}

export async function verifyKiotVietRetailConnection(input: {
  retailer: string;
  clientId: string;
  clientSecret: string;
  branchName: string;
}): Promise<{ branchId: number; branchName: string }> {
  const signal = AbortSignal.timeout(15_000);
  let token: string;
  try {
    token = await accessToken(input.clientId, input.clientSecret, signal);
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

/** Kiot keeps this as an order slip. We never create an invoice or mark a payment. */
export async function createKiotVietOrchidDraft(input: {
  retailer: string;
  clientId: string;
  clientSecret: string;
  branchId: number;
  cashierUserId?: number;
  customer: string;
  zaloUid: string;
  channelName: string;
  stems: number;
  color: string;
  pot: string;
  price: string | null;
  delivery: string;
}): Promise<{ orderId: number; code: string }> {
  const signal = AbortSignal.timeout(20_000);
  const token = await accessToken(input.clientId, input.clientSecret, signal);
  const headers = { Retailer: input.retailer, Authorization: `Bearer ${token}` };
  const product = await orchidProduct(headers, signal);
  const totalPrice = parseKiotVietPrice(input.price);
  const missing = [
    ...(totalPrice === null ? ["giá bán"] : []),
    "số điện thoại và địa chỉ nhận (nhân viên kiểm tra)",
  ];
  const clean = (s: string) => s.replace(/[\r\n\t]+/g, " ").trim().slice(0, 250);
  const description = [
    `PenAI - đơn nháp chờ kiểm tra; nguồn ${clean(input.channelName)} / Zalo UID ${clean(input.zaloUid)}.`,
    `Khách: ${clean(input.customer)}. ${clean(input.pot)} ${input.stems} cành, màu ${clean(input.color)}.`,
    `Hẹn giao: ${clean(input.delivery)}. Giá trao đổi: ${clean(input.price ?? "chưa chốt")}.`,
    `Cần bổ sung/kiểm tra: ${missing.join(", ")}. Không phải hóa đơn; chưa ghi nhận thanh toán.`,
  ].join(" ");
  const body = {
    purchaseDate: new Date().toISOString(),
    branchId: input.branchId,
    ...(input.cashierUserId ? { cashierId: input.cashierUserId } : {}),
    description,
    totalPayment: 0,
    makeInvoice: false,
    orderDetails: [{
      productId: Number(product.id),
      productCode: "SP00016",
      productName: String(product.fullName ?? product.name ?? "LAN HỒ ĐIỆP (Cây)"),
      quantity: input.stems,
      price: totalPrice === null ? 0 : Math.round((totalPrice / input.stems) * 100) / 100,
      note: `${clean(input.pot)} ${input.stems} cành, màu ${clean(input.color)}; ${totalPrice === null ? "GIÁ CHƯA CHỐT" : `tổng giá đã trao đổi ${totalPrice}đ`}`,
    }],
  };
  // Never retry POST automatically. A timeout can occur after KiotViet accepted the order.
  const response = await fetch("https://public.kiotapi.com/orders", {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal,
  });
  if (!response.ok) throw new Error(`KiotViet từ chối tạo đơn nháp (HTTP ${response.status})`);
  const payload = await response.json() as Record<string, unknown>;
  const order = (payload.data && typeof payload.data === "object" ? payload.data : payload) as Record<string, unknown>;
  if (!Number.isSafeInteger(order.id) || Number(order.id) <= 0 || typeof order.code !== "string" || !order.code) {
    // A successful HTTP response with an unknown body may still have created an order.
    throw new Error("KiotViet có thể đã tạo đơn nhưng không trả mã đơn; cần đối chiếu thủ công");
  }
  return { orderId: Number(order.id), code: order.code };
}

/** Resolve a login name to KiotViet's numeric user ID; never use the account password. */
export async function findKiotVietUser(input: {
  retailer: string; clientId: string; clientSecret: string; username: string;
}): Promise<{ id: number; username: string; name: string }> {
  const signal = AbortSignal.timeout(20_000);
  const token = await accessToken(input.clientId, input.clientSecret, signal);
  const headers = { Retailer: input.retailer, Authorization: `Bearer ${token}` };
  const key = (s: string) => s.trim().toLocaleLowerCase("vi-VN");
  const target = key(input.username);
  for (let currentItem = 0; currentItem < 1_000; currentItem += 100) {
    const response = await fetch(`https://public.kiotapi.com/users?pageSize=100&currentItem=${currentItem}`, { headers, signal });
    if (!response.ok) throw new Error(`Không đọc được danh sách người dùng KiotViet (HTTP ${response.status})`);
    const payload = await response.json() as { data?: unknown; total?: unknown };
    const users = Array.isArray(payload.data) ? payload.data : [];
    const matches = users.filter((user): user is { id: number; userName: string; givenName?: string } =>
      !!user && typeof user === "object" &&
      Number.isSafeInteger((user as { id?: unknown }).id) &&
      typeof (user as { userName?: unknown }).userName === "string" &&
      key((user as { userName: string }).userName) === target);
    if (matches.length > 1) throw new Error(`Có nhiều tài khoản KiotViet tên ${input.username}`);
    if (matches.length === 1) {
      const user = matches[0]!;
      return { id: user.id, username: user.userName, name: user.givenName ?? user.userName };
    }
    if (users.length < 100 || (typeof payload.total === "number" && currentItem + 100 >= payload.total)) break;
  }
  throw new Error(`Không tìm thấy tài khoản KiotViet ${input.username} qua API`);
}

export async function checkKiotVietOrchidProduct(input: {
  retailer: string; clientId: string; clientSecret: string;
}): Promise<{ id: number; code: string; name: string }> {
  const signal = AbortSignal.timeout(15_000);
  const token = await accessToken(input.clientId, input.clientSecret, signal);
  const product = await orchidProduct({ Retailer: input.retailer, Authorization: `Bearer ${token}` }, signal);
  return { id: Number(product.id), code: "SP00016", name: String(product.fullName ?? product.name ?? "LAN HỒ ĐIỆP (Cây)") };
}

async function orchidProduct(headers: { Retailer: string; Authorization: string }, signal: AbortSignal): Promise<Record<string, unknown>> {
  const productResponse = await fetch("https://public.kiotapi.com/products/code/SP00016", { headers, signal });
  if (!productResponse.ok) throw new Error("Không đọc được mã hàng SP00016 từ KiotViet");
  const productPayload = await productResponse.json() as Record<string, unknown>;
  const product = (productPayload.data && typeof productPayload.data === "object"
    ? productPayload.data : productPayload) as Record<string, unknown>;
  if (product.code !== "SP00016" || !Number.isSafeInteger(product.id) || Number(product.id) <= 0 ||
      product.isActive === false || product.allowsSale === false) {
    throw new Error("Mã SP00016 không còn là hàng bán hợp lệ; cần kiểm tra KiotViet");
  }
  return product;
}

/** Parse only an unambiguous VND total. An unknown price stays 0 in the draft. */
export function parseKiotVietPrice(raw: string | null): number | null {
  if (!raw) return null;
  const text = raw.trim().toLocaleLowerCase("vi-VN");
  if (/ship|phí|cọc|trả trước|tạm ứng/.test(text)) return null;
  const normalized = text.replace(/\s+/g, "");
  const million = normalized.match(/^(\d+)(?:[,.](\d{1,2}))?(?:triệu|tr|trieu)$/);
  if (million) return Number(million[1]) * 1_000_000 + Number((million[2] ?? "").padEnd(2, "0")) * 10_000;
  const thousand = normalized.match(/^(\d+)(?:[,.](\d{1,2}))?(?:nghìn|ngàn|k)$/);
  if (thousand) return Number(thousand[1]) * 1_000 + Number((thousand[2] ?? "").padEnd(2, "0")) * 10;
  const numeric = normalized.replace(/(?:vnd|đ|₫)$/i, "");
  if (!/^\d{1,3}(?:[.,]\d{3})+$|^\d{4,10}$/.test(numeric)) return null;
  const amount = Number(numeric.replace(/[.,]/g, ""));
  return Number.isSafeInteger(amount) && amount > 0 && amount < 1_000_000_000 ? amount : null;
}
