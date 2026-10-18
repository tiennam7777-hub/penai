# MISA meInvoice: hóa đơn từ Inbox

Trang quản trị MISA meInvoice xác minh tài khoản và mã số thuế bằng OAuth, lưu mật khẩu mã hóa. Nút **Kiểm tra kết nối đã lưu** dùng thông tin đang lưu, không thay đổi mật khẩu. Xác minh đăng nhập và đọc dữ liệu chưa chứng minh quyền ghi hóa đơn nháp.

Khách có thể yêu cầu hóa đơn trong hội thoại. Nhân viên dùng `-xhd` trong DM Zalo Hot 1/4/6 để yêu cầu tạo nháp. Lệnh nhập trong Inbox web được xử lý nội bộ. Lệnh gửi từ điện thoại đã đi qua Zalo trước khi PenAI thu hồi; PenAI chỉ xử lý khi thu hồi thành công.

Trước khi lập nháp, PenAI kiểm tra lịch sử chat, mã số thuế người mua, tên pháp lý đầy đủ và địa chỉ tra từ MISA. Phải hỏi khách xác nhận đúng tên công ty, có câu trả lời đồng ý sau đó; tên người mua chỉ điền nếu khách yêu cầu. Giá shop chốt chưa gồm VAT. Phải có tin báo đúng VAT 5% cho hàng thường hoặc 8% cho lan ghép lũa và tin khách đồng ý sau đó. Không suy diễn từ lời AI, dữ liệu thiếu hoặc thông tin hóa đơn cũ không hiện trong lịch sử.

Hàng thường dùng HH00001, tên Hoa Lan Hồ Điệp, đơn vị **Cây**, số lượng bằng số cành thực bán. Giá hoa cùng phí ship và phụ thu chậu cao thực bán được cộng vào giá trước thuế rồi chia theo số cành. Đơn giá trên 250.000đ/cành hoặc không chia ra đơn giá nguyên đồng sẽ dừng để nhân viên/kế toán kiểm tra. Lan ghép lũa thực bán dùng HH00002, đơn vị **Chậu**, số lượng 1, VAT 8%. Không đổi mã hàng, số cành hay số tiền hóa đơn chỉ để đạt đơn giá hoặc thuế suất mong muốn. Yêu cầu ghi hóa đơn cao hơn giá trị thực bán sẽ dừng; cần điều chỉnh đơn hàng thực tế trước khi lập nháp.

API MISA `POST /api/v2/SAInvoice/Insert` lưu hóa đơn; PenAI chỉ nhận thành công sau khi `GET /api/v2/SAInvoice/Get/{id}` xác minh `PublishStatus = 0`. Một yêu cầu chỉ POST một lần; lỗi hoặc hết giờ chờ phải đối chiếu MISA trước khi thử lại. PenAI không ghi nhận thanh toán hay ký/phát hành từ lệnh `-xhd`.

Hiện `misa_credentials.draft_enabled = false`: chưa thử POST/GET với hóa đơn thật có kiểm soát. Vì thế `-xhd` chưa tạo nháp, và chức năng gửi bản xem trước cho khách chưa hoạt động. `-xuat` được giữ làm lệnh nội bộ nhưng luôn báo chưa bật, không gọi API phát hành. Chỉ triển khai ký/phát hành sau khi HSM/ký từ xa được cấu hình và kiểm tra riêng với một hóa đơn nháp hợp lệ.
