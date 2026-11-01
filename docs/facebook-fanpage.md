# Kết nối Messenger Fanpage với PenAI

PenAI dùng Messenger Platform API chính thức cho **Fanpage**. Mỗi Page là một
channel `facebook_page` riêng, có thể gắn cùng Agent kinh doanh. Tài khoản
Facebook cá nhân không dùng được luồng này.

## Hiện trạng hai Page (đối chiếu trong Meta ngày 01/11/2026)

| Page | Page ID | Tên hiển thị trong Meta |
| --- | --- | --- |
| `lanhodiep.orchidsworld` | `620530068063788` | NPP Lan Hồ Điệp Đà Lạt Orchids World |
| `lanhodiepdienbienphu` | `240316652835505` | NPP Lan Hồ Điệp Orchids World - CN Hòa Bình |

Cả hai Page đã nằm trong Meta App **Chatbot IM1** (`1082111827116690`), hiện
đang ở chế độ Development. App đã đăng ký `messages` cho cả hai Page và webhook
đang trỏ tới `https://auto.imgroup.vn/webhook/chatbot-messenger-imgroup-v01`.
`pages_messaging` và `pages_manage_metadata` xuất hiện trong danh sách quyền,
nhưng cần kiểm tra cấp độ truy cập và App Review trước khi nhận khách thật.
**Không thay callback hiện tại** khi chưa xác định dịch vụ `auto.imgroup.vn` đang
xử lý gì và lịch chuyển kết nối. Một Meta App dùng một callback Page chung; nếu
chuyển callback sang PenAI, webhook cũ sẽ ngừng nhận sự kiện từ App này.

## Chuẩn bị tại Meta

1. Người quản trị Page cần quyền **MESSAGE** trên Page và quyền quản trị ứng dụng
   tại [Meta for Developers](https://developers.facebook.com/apps/). Tạo một
   ứng dụng loại phù hợp với Messenger, hoặc dùng ứng dụng đã có. Hai Page có
   thể dùng cùng một ứng dụng nhưng phải có **Page ID** và **Page access token**
   riêng cho từng Page.
2. Bật Messenger Platform API, cấp `pages_messaging` và các quyền Meta yêu cầu
   để kết nối Page và webhook. Kiểm tra trạng thái quyền, chế độ Live và App
   Review trong dashboard Meta; quyền dành cho người thử ứng dụng chưa đồng
   nghĩa khách ngoài đời nhắn được.
3. Lấy **App Secret** trong cài đặt ứng dụng. Tạo một **Verify token** ngẫu
   nhiên, riêng tư. Không gửi ba giá trị bí mật này qua chat, email hoặc commit
   vào Git.
4. Trước lúc chuyển webhook, đối chiếu nội dung trả lời tự động đang chạy ở
   `auto.imgroup.vn`, quyền Page token và địa chỉ/giá/quy trình của **từng**
   Page. Agent hiện tại của PenAI mô tả cửa hàng 42 Điện Biên Phủ, có thể không
   phù hợp với hai tên chi nhánh Meta ở trên.

## Tạo hai kênh trong PenAI

Vào **Channels → Thêm kênh → Facebook Fanpage**. Với từng Page, điền:

| Mục | Giá trị |
| --- | --- |
| Tên | Tên để nhân viên nhận ra Page trong Inbox |
| Agent | Nhân Viên Kinh Doanh Orchids World |
| Page ID | ID số của chính Page, không phải URL/username |
| Page access token | Token của đúng Page đó |
| App Secret | Bí mật của ứng dụng Meta |
| Verify token | Chuỗi tự đặt ở bước chuẩn bị |

Kênh mới được tạo với **Agent tự trả lời tắt**. Lưu kênh rồi bấm **Địa chỉ
webhook** để lấy callback URL chung `/webhooks/facebook`. Trong Meta App →
Messenger Webhooks, chọn Page object, nhập callback URL và Verify token, xác
minh, đăng ký ít nhất trường `messages`, rồi subscribe **cả hai Page**. Nếu
dùng chung một ứng dụng Meta, hai kênh cần cùng App Secret và Verify token;
Page ID và Page access token phải riêng. PenAI định tuyến tin theo Page ID.

## Thử rồi bật AI

1. Dùng tài khoản thử có quyền trên Meta App nhắn **một tin mới** vào từng Page.
   Kiểm tra đúng kênh và đúng hội thoại trong Inbox PenAI. Thử một ảnh.
2. Nhân viên trả lời một tin từ Inbox, xác nhận Page nhận đúng tin và khi nhân
   viên vừa trả lời thì Agent không chen vào. Thử chọn **Tắt cho hội thoại này**
   ở Inbox.
3. Đối chiếu quyền `pages_messaging`, trạng thái Live/App Review cho khách thật.
   Sau khi cả hai Page hoạt động đúng, quản trị mới vào **Channels → Sửa** và
   bật **Agent tự trả lời** cho từng Page. Có thể bật từng Page một để theo dõi.

Meta chỉ cho gửi phản hồi thông thường trong cửa sổ nhắn tin sau khi khách chủ
động nhắn Page, theo chính sách hiện hành của Messenger. PenAI dùng loại tin
`RESPONSE`, không tự gửi tin quảng cáo hàng loạt. Tin nhắn không gửi được do
quyền, token hoặc hết cửa sổ sẽ hiện lỗi trong log; cần nhân viên xử lý.

## Giới hạn hiện tại

- Messenger hỗ trợ DM của Page, tin chữ và ảnh. PenAI không mở nhóm Facebook,
  bình luận bài viết hoặc DM tài khoản cá nhân qua kênh này.
- Inbox có thể trả lời, tạm dừng hoặc tắt AI theo hội thoại. Những nghiệp vụ
  đang gắn riêng Hot 1/4/6 Zalo, gồm nút ngoài giờ và báo nhóm Zalo, chưa tự
  áp dụng cho Fanpage.
- PenAI chỉ nhận tin mới từ lúc webhook hoạt động; không nhập lịch sử Messenger.

Tham khảo: [Messenger Platform API do Meta công bố](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api).
