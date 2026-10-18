# MISA meInvoice: hóa đơn nháp từ Inbox

Trang quản trị **MISA meInvoice** nhận mã số thuế, tài khoản, mật khẩu, ký hiệu hóa đơn, mức thuế GTGT và cách hiểu giá khách chốt. PenAI kiểm tra đăng nhập bằng API web MISA trước khi lưu mật khẩu mã hóa. Không ghi mật khẩu vào log hoặc trả lại cho trình duyệt.

Lệnh `-xhd` chỉ dành cho người trực trong DM Zalo Hot 1/4/6 đã gắn Agent kinh doanh. Từ Inbox web, lệnh được xử lý nội bộ và không gửi cho khách. Nếu gõ trên điện thoại, Zalo đã gửi mã trước khi PenAI nhận được; PenAI chỉ thực hiện lệnh sau khi thu hồi thành công.

PenAI chỉ thử lưu hóa đơn khi tìm thấy yêu cầu xuất hóa đơn mới từ khách và đủ MST, tên, địa chỉ, email người mua, mặt hàng cùng giá hàng đã chốt. Các thông tin “như cũ” chỉ được dùng nếu hiện rõ trong lịch sử hội thoại. Lệnh không tự tạo khách hàng, không đánh dấu đã thanh toán, không ký, không phát hành, không gửi email hóa đơn. Một yêu cầu khách chỉ được POST một lần; nếu lỗi hoặc hết giờ chờ thì phải đối chiếu MISA trước khi xử lý lại.

API web MISA v2 có đường dẫn `POST /api/v2/SAInvoice/Insert` để lưu hóa đơn chưa phát hành. Nút `-xhd` mặc định **tắt** sau khi cấu hình kết nối. Chỉ bật `misa_credentials.draft_enabled` sau khi xác minh được lệnh thử lưu và đọc đúng trạng thái `PublishStatus = 0` trên tài khoản sản xuất. Bản v3 tạo XML qua `/api/v3/.../createinvoice` không tương đương hóa đơn nháp lưu trong giao diện.
