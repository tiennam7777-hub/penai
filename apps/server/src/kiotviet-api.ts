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
  customerPhone?: string | null;
  zaloUid: string;
  channelName: string;
  stems: number;
  color: string;
  pot: string;
  price: string | null;
  delivery: string | null;
  address?: string | null;
  recipientPhone?: string | null;
  cardText?: string | null;
  instructions?: string | null;
  shippingFee?: string | null;
  vatFee?: string | null;
  companyInvoice?: boolean;
  existing?: { orderId: number; code: string; fillMissing: true };
}): Promise<{ orderId: number; code: string; customerName: string; description: string }> {
  const signal = AbortSignal.timeout(20_000);
  const token = await accessToken(input.clientId, input.clientSecret, signal);
  const headers = { Retailer: input.retailer, Authorization: `Bearer ${token}` };
  const product = await orchidProduct(headers, signal);
  const customer = await findOrderCustomer(headers, input.customer, signal, input.customerPhone);
  const totalPrice = parseKiotVietPrice(input.price);
  const shipping = parseKiotVietPrice(input.shippingFee ?? null);
  const vat = input.companyInvoice ? parseKiotVietPrice(input.vatFee ?? null) : null;
  if (input.shippingFee && shipping === null) throw new Error("Phí ship đã báo khách chưa rõ số tiền");
  if (input.companyInvoice && input.vatFee && vat === null) throw new Error("Tiền Thuế GTGT đã báo khách chưa rõ số tiền");
  const missing = [
    ...(totalPrice === null ? ["giá bán"] : []),
    ...(!input.address ? ["địa chỉ giao"] : []),
    ...(!input.delivery ? ["thời gian giao"] : []),
    ...(!input.recipientPhone ? ["số điện thoại người nhận"] : []),
  ];
  const clean = (s: string) => s.replace(/[\r\n\t]+/g, " ").trim().slice(0, 500);
  const description = [
    `Chậu: ${clean(input.pot)} ${input.stems} cành. Màu: ${clean(input.color)}.`,
    `Giao: ${clean(input.delivery ?? "khách báo sau")}. Địa chỉ: ${clean(input.address ?? "khách báo sau")}.`,
    ...(input.cardText ? [`Bảng chữ: ${clean(input.cardText)}.`] : []),
    ...(input.recipientPhone ? [`SĐT người nhận: ${clean(input.recipientPhone)}.`] : []),
    ...(input.instructions ? [`Lưu ý: ${clean(input.instructions)}.`] : []),
    `Giá hoa: ${clean(input.price ?? "chưa chốt")}.`,
    ...(missing.length ? [`Cần bổ sung: ${missing.join(", ")}.`] : []),
    `Khách chat: ${clean(input.customer)}; nguồn ${clean(input.channelName)} / Zalo UID ${clean(input.zaloUid)}.`,
  ].join(" ");
  const details = [{
    productId: Number(product.id), productCode: "SP00016",
    productName: String(product.fullName ?? product.name ?? "LAN HỒ ĐIỆP (Cây)"),
    quantity: input.stems,
    price: totalPrice === null ? 0 : Math.round((totalPrice / input.stems) * 100) / 100,
    note: `${clean(input.pot)} ${input.stems} cành, màu ${clean(input.color)}`,
    orderDetailTaxs: [{ taxId: 1 }], // VAT 0%; quoted amount is the final flower price.
  }];
  for (const [code, amount] of [["SP00021", shipping], ["SP00022", vat]] as const) {
    if (amount === null) continue;
    const extra = await productByCode(headers, code, signal);
    details.push({ productId: Number(extra.id), productCode: code,
      productName: String(extra.fullName ?? extra.name ?? code), quantity: 1, price: amount,
      note: code === "SP00021" ? "Phí ship đã báo khách" : "Thuế GTGT đã báo khách; khách lấy hóa đơn công ty",
      orderDetailTaxs: [{ taxId: 1 }],
    });
  }
  const expectedDelivery = input.delivery ? parseVietnamDelivery(input.delivery) : null;
  if (input.delivery && !expectedDelivery) throw new Error("Giờ giao không hợp lệ");
  if (input.retailer !== "orchidsworld42") throw new Error("Chưa xác minh đối tác Anh Sang cho gian hàng này");
  const body = {
    purchaseDate: new Date().toISOString(),
    branchId: input.branchId,
    ...(input.cashierUserId ? { cashierId: input.cashierUserId } : {}),
    description,
    customer: { id: customer.id, code: customer.code, name: customer.name },
    totalPayment: 0,
    makeInvoice: false,
    orderDetails: details,
    orderDelivery: {
      type: 1,
      partnerDeliveryId: 107020, // DT000001 Anh Sang, confirmed in this retailer's order history.
      partnerDelivery: { code: "DT000001", name: "Anh Sang" },
      receiver: customer.name,
      ...(input.recipientPhone ? { contactNumber: input.recipientPhone } : {}),
      ...(input.address ? { address: input.address } : {}),
      ...(expectedDelivery ? { expectedDelivery } : {}),
    },
  };
  if (input.existing) {
    const currentResponse = await fetch(`https://public.kiotapi.com/orders/${input.existing.orderId}`, { headers, signal });
    if (!currentResponse.ok) throw new Error(`Không đọc được phiếu ${input.existing.code} để cập nhật`);
    const currentPayload = await currentResponse.json() as Record<string, unknown>;
    const current = (currentPayload.data && typeof currentPayload.data === "object"
      ? currentPayload.data : currentPayload) as Record<string, unknown>;
    if (current.id !== input.existing.orderId || current.code !== input.existing.code || current.status !== 1 ||
        current.branchId !== input.branchId || Number(current.totalPayment ?? 0) !== 0) {
      throw new Error(`Phiếu ${input.existing.code} đã thay đổi; cần nhân viên kiểm tra trước khi cập nhật`);
    }
    const oldDelivery = current.orderDelivery && typeof current.orderDelivery === "object"
      ? current.orderDelivery as Record<string, unknown> : {};
    if (!Number.isSafeInteger(current.customerId) || Number(current.customerId) <= 0) {
      throw new Error(`Phiếu ${input.existing.code} thiếu mã khách hiện tại; không ghi đè khách nhân viên đã chọn`);
    }
    // Retail GET omits creator/cashier; use the account configured for this integration.
    const creatorId = current.cashierId ?? current.createdBy ?? input.cashierUserId;
    if (!Number.isSafeInteger(creatorId) || Number(creatorId) <= 0) {
      throw new Error(`KiotViet không trả mã người tạo phiếu ${input.existing.code}; dừng để giữ người nhân viên đã chọn`);
    }
    const oldLines = Array.isArray(current.orderDetails) ? current.orderDetails as Array<Record<string, unknown>> : [];
    if (!oldLines.length) throw new Error(`Phiếu ${input.existing.code} thiếu dòng hàng hiện tại`);
    const mergedLines = oldLines.map((line) => ({ ...line }));
    const flowerLine = mergedLines.find((line) => line.productCode === "SP00016");
    if (flowerLine && Number(flowerLine.price ?? 0) === 0 && totalPrice !== null) {
      flowerLine.price = Math.round((totalPrice / Number(flowerLine.quantity ?? input.stems)) * 100) / 100;
    }
    for (const newLine of details.slice(1)) {
      if (!mergedLines.some((line) => line.productCode === newLine.productCode)) mergedLines.push(newLine);
    }
    let oldNote = String(current.description ?? "").replace(/\s*Cần bổ sung:[^.]*\./i, "").trim();
    if (input.delivery) oldNote = oldNote.replace(/Giao: khách báo sau\./i, `Giao: ${clean(input.delivery)}.`);
    if (input.address) oldNote = oldNote.replace(/Địa chỉ: khách báo sau\./i, `Địa chỉ: ${clean(input.address)}.`);
    if (input.price) oldNote = oldNote.replace(/Giá hoa: chưa chốt\./i, `Giá hoa: ${clean(input.price)}.`);
    const additions: string[] = [];
    for (const [label, value] of [["Bảng chữ", input.cardText], ["SĐT người nhận", input.recipientPhone],
      ["Lưu ý", input.instructions]] as const) {
      if (value && !new RegExp(`${label}:`, "i").test(oldNote)) additions.push(`${label}: ${clean(value)}.`);
    }
    if (!/Khách chat:/i.test(oldNote)) additions.push(`Khách chat: ${clean(input.customer)}; nguồn ${clean(input.channelName)} / Zalo UID ${clean(input.zaloUid)}.`);
    const mergedDelivery = { ...oldDelivery };
    if (!mergedDelivery.type) mergedDelivery.type = 1;
    if (!mergedDelivery.partnerDeliveryId) mergedDelivery.partnerDeliveryId = 107020;
    if (!mergedDelivery.partnerDelivery) mergedDelivery.partnerDelivery = { code: "DT000001", name: "Anh Sang" };
    if (!mergedDelivery.receiver && input.recipientPhone) mergedDelivery.receiver = String(current.customerName ?? customer.name);
    if (!mergedDelivery.contactNumber && input.recipientPhone) mergedDelivery.contactNumber = input.recipientPhone;
    if (!mergedDelivery.address && input.address) mergedDelivery.address = input.address;
    if (!mergedDelivery.expectedDelivery && expectedDelivery) mergedDelivery.expectedDelivery = expectedDelivery;
    const updateBody: Record<string, unknown> = {
      ...body, id: input.existing.orderId,
      purchaseDate: String(current.purchaseDate ?? body.purchaseDate),
      customer: { id: current.customerId, code: current.customerCode, name: current.customerName },
      orderDetails: mergedLines, orderDelivery: mergedDelivery,
      description: [oldNote, ...additions].filter(Boolean).join(" "),
      cashierId: creatorId,
    };
    for (const key of ["soldById", "discount", "discountRatio", "discountAfterTax", "method",
      "saleChannelId", "pricingMode", "usingCod", "invoiceOrderSurcharges"] as const) {
      if (current[key] !== undefined && current[key] !== null) updateBody[key] = current[key];
    }
    if (current.SaleChannelId !== undefined && current.SaleChannelId !== null) updateBody.saleChannelId = current.SaleChannelId;
    const response = await fetch(`https://public.kiotapi.com/orders/${input.existing.orderId}`, {
      method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(updateBody), signal,
    });
    if (!response.ok) throw new Error(`KiotViet từ chối cập nhật phiếu đặt hàng (HTTP ${response.status})`);
    const payload = await response.json() as Record<string, unknown>;
    const order = (payload.data && typeof payload.data === "object" ? payload.data : payload) as Record<string, unknown>;
    if (order.id !== input.existing.orderId || order.code !== input.existing.code) {
      throw new Error(`KiotViet có thể đã cập nhật phiếu ${input.existing.code} nhưng không trả mã đúng; cần đối chiếu thủ công`);
    }
    return { orderId: input.existing.orderId, code: input.existing.code,
      customerName: String(current.customerName), description: String(updateBody.description) };
  }
  // Never retry POST automatically. A timeout can occur after KiotViet accepted the order.
  const response = await fetch("https://public.kiotapi.com/orders", {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal,
  });
  if (!response.ok) throw new Error(`KiotViet từ chối tạo phiếu đặt hàng (HTTP ${response.status})`);
  const payload = await response.json() as Record<string, unknown>;
  const order = (payload.data && typeof payload.data === "object" ? payload.data : payload) as Record<string, unknown>;
  if (!Number.isSafeInteger(order.id) || Number(order.id) <= 0 || typeof order.code !== "string" || !order.code) {
    // A successful HTTP response with an unknown body may still have created an order.
    throw new Error("KiotViet có thể đã tạo đơn nhưng không trả mã đơn; cần đối chiếu thủ công");
  }
  return { orderId: Number(order.id), code: order.code, customerName: customer.name, description };
}

/** Read the saved slip back before publishing its image, so the image reflects KiotViet's actual totals. */
export async function readKiotVietOrderSlip(input: {
  retailer: string; clientId: string; clientSecret: string; orderId: number; code: string;
}): Promise<{
  code: string; customer: string; description: string; total: number;
  details: Array<{ code: string; name: string; quantity: number; price: number }>;
  partner: string; expectedDelivery: string | null;
}> {
  const signal = AbortSignal.timeout(20_000);
  const token = await accessToken(input.clientId, input.clientSecret, signal);
  const response = await fetch(`https://public.kiotapi.com/orders/${input.orderId}`, {
    headers: { Retailer: input.retailer, Authorization: `Bearer ${token}` }, signal,
  });
  if (!response.ok) throw new Error(`Không đọc lại được phiếu đặt hàng ${input.code} (HTTP ${response.status})`);
  const payload = await response.json() as Record<string, unknown>;
  const order = (payload.data && typeof payload.data === "object" ? payload.data : payload) as Record<string, unknown>;
  if (order.id !== input.orderId || order.code !== input.code || !Number.isFinite(order.total) ||
      !Array.isArray(order.orderDetails)) throw new Error(`Dữ liệu đọc lại phiếu ${input.code} chưa đầy đủ`);
  const details = order.orderDetails.map((raw) => {
    const line = raw as Record<string, unknown>;
    return { code: String(line.productCode ?? ""), name: String(line.productName ?? ""),
      quantity: Number(line.quantity ?? 0), price: Number(line.price ?? 0) };
  });
  if (!details.some((line) => line.code === "SP00016")) throw new Error(`Phiếu ${input.code} thiếu SP00016`);
  const delivery = order.orderDelivery && typeof order.orderDelivery === "object"
    ? order.orderDelivery as Record<string, unknown> : {};
  const partner = delivery.partnerDelivery && typeof delivery.partnerDelivery === "object"
    ? delivery.partnerDelivery as Record<string, unknown> : {};
  if (Number(delivery.partnerDeliveryId) !== 107020 || partner.code !== "DT000001" || partner.name !== "Anh Sang") {
    throw new Error(`Phiếu ${input.code} chưa gắn đúng đối tác Anh Sang`);
  }
  return { code: input.code, customer: String(order.customerName ?? ""),
    description: String(order.description ?? ""), total: Number(order.total), details,
    partner: String(partner.name ?? "Anh Sang"),
    expectedDelivery: typeof delivery.expectedDelivery === "string" ? delivery.expectedDelivery : null };
}

function parseVietnamDelivery(value: string): string | null {
  const m = /^(\d{2}):(\d{2}) (\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!m) return null;
  const [, hh, mm, dd, mo, yyyy] = m;
  const hour = Number(hh), minute = Number(mm), day = Number(dd), month = Number(mo), year = Number(yyyy);
  if (hour > 23 || minute > 59 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utc = Date.UTC(year, month - 1, day, hour - 7, minute);
  const check = new Date(utc + 7 * 3600_000);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return new Date(utc).toISOString();
}

type KiotCustomer = { id: number; code: string; name: string; contactNumber?: string };
async function findOrderCustomer(headers: { Retailer: string; Authorization: string }, name: string, signal: AbortSignal, profilePhone?: string | null): Promise<KiotCustomer> {
  const norm = (s: string) => s.normalize("NFC").toLocaleLowerCase("vi-VN").replace(/\s+/g, " ").trim();
  const rawPhone = (name.match(/(?:\+?84|0)(?:[ .-]?\d){9,10}/)?.[0] ?? profilePhone ?? "").replace(/\D/g, "");
  const phone = rawPhone?.startsWith("84") ? `0${rawPhone.slice(2)}` : rawPhone;
  async function search(param: "name" | "contactNumber", term: string): Promise<KiotCustomer[]> {
    const results: KiotCustomer[] = [];
    for (let offset = 0; offset < 1_000; offset += 100) {
      const response = await fetch(`https://public.kiotapi.com/customers?pageSize=100&currentItem=${offset}&${param}=${encodeURIComponent(term)}`, { headers, signal });
      if (!response.ok) throw new Error(`Không tra được khách hàng KiotViet (HTTP ${response.status})`);
      const payload = await response.json() as { data?: unknown; total?: unknown };
      const page = Array.isArray(payload.data) ? payload.data as KiotCustomer[] : [];
      results.push(...page);
      if (page.length < 100 || (typeof payload.total === "number" && offset + 100 >= payload.total)) break;
    }
    return results;
  }
  if (phone) {
    const matches = (await search("contactNumber", phone)).filter((x) => {
      const number = x.contactNumber?.replace(/\D/g, "");
      return (number?.startsWith("84") ? `0${number.slice(2)}` : number) === phone;
    });
    if (matches.length === 1) return matches[0]!;
  }
  const customerName = rawPhone ? name.replace(name.match(/(?:\+?84|0)(?:[ .-]?\d){9,10}/)?.[0] ?? "", "").trim() : name;
  const byName = (await search("name", customerName)).filter((x) => norm(x.name) === norm(customerName));
  if (byName.length === 1) return byName[0]!;
  const fallback = (await search("name", "Chưa tìm ra tên")).filter((x) => norm(x.name) === norm("Chưa tìm ra tên"));
  if (fallback.length !== 1) throw new Error("Không xác định được khách dự phòng Chưa tìm ra tên");
  return fallback[0]!;
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
  return productByCode(headers, "SP00016", signal);
}

async function productByCode(headers: { Retailer: string; Authorization: string }, code: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const productResponse = await fetch(`https://public.kiotapi.com/products/code/${code}`, { headers, signal });
  if (!productResponse.ok) throw new Error(`Không đọc được mã hàng ${code} từ KiotViet`);
  const productPayload = await productResponse.json() as Record<string, unknown>;
  const product = (productPayload.data && typeof productPayload.data === "object"
    ? productPayload.data : productPayload) as Record<string, unknown>;
  if (product.code !== code || !Number.isSafeInteger(product.id) || Number(product.id) <= 0 ||
      product.isActive === false || product.allowsSale === false) {
    throw new Error(`Mã ${code} không còn là hàng bán hợp lệ; cần kiểm tra KiotViet`);
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
