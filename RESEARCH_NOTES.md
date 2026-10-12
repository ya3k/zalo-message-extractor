# BÁO CÁO NGHIÊN CỨU & KẾT QUẢ THỰC NGHIỆM DỰ ÁN TRÍCH XUẤT TIN NHẮN ZALO

---

## I. TỔNG QUAN KẾT QUẢ THỬ NGHIỆM THỰC TẾ

| Hạng mục | Trạng thái | Ghi chú kỹ thuật |
|---|---|---|
| **Đăng nhập QR & Lưu Session** |  **THÀNH CÔNG** | Tự sinh QR, tự mở ảnh trên Windows, lưu `session.json` dùng lại không cần quét lại |
| **Lấy danh sách nhóm chat** |  **THÀNH CÔNG** | Lấy đủ 45+ nhóm, ID nhóm, tên nhóm qua API Zalo Web |
| **API lịch sử mặc định (`/api/group/history`)** | ❌ **THẤT BẠI (404)** | Zalo đã đóng hoàn toàn endpoint này trên máy chủ |
| **API Cloud Message V2 (`getrecentv2`)** |  **THÀNH CÔNG** | Tích hợp custom adapter theo PR #370, kết nối thành công qua `group_cloud_message` |
| **Trích xuất tin nhắn phát sinh sau đăng nhập** |  **THÀNH CÔNG** | Lấy 100% dữ liệu thực tế: ID, người gửi, nội dung, timestamp, loại tin |
| **Chuẩn hóa & Sắp xếp thời gian** |  **THÀNH CÔNG** | Đã xử lý sort theo `timestamp` tăng dần (`asc`), loại bỏ tin nhắn trùng lặp |
| **Lấy tin nhắn cũ lịch sử từ trước khi đăng nhập** | ⚠️ **BỊ GIỚI HẠN** | Bị máy chủ Zalo chặn bằng cờ `isFiltered: 1` |

---

## II. CHI TIẾT CÁC TÍNH NĂNG ĐÃ LÀM ĐƯỢC (WHAT WORKS)

### 1. Đăng nhập qua mã QR và tái sử dụng phiên
* **Cách thực hiện:** Dùng `loginQR()` của `zca-js`. Khi server Zalo trả về base64 QR, code tự động lưu file `qr.png` và bật ứng dụng xem ảnh của Windows lên màn hình.
* **Tự động lưu Session:** Khi quét thành công, dữ liệu `cookie`, `imei`, `userAgent` được lưu vào `session.json`. Các lần chạy sau tự động tái sử dụng, không làm phiền người dùng quét lại QR.

### 2. Quét toàn bộ danh sách nhóm chat
* **Endpoint:** `${api.zpwServiceMap.group_poll[0]}/api/group/getlg/v4` kết hợp với `getmg-v2`.
* **Kết quả:** Trích xuất toàn bộ 45 nhóm chat của tài khoản, lưu trữ file thô `output/groups-raw.json` và file tổng hợp `output/groups.json`.

### 3. Vượt lỗi 404 bằng Endpoint Cloud Message V2
* **Giải pháp:** Sử dụng tính năng mở rộng `api.custom()` có sẵn của `zca-js` (không sửa `node_modules`).
* **Endpoint mới:** `${api.zpwServiceMap.group_cloud_message[0]}/api/cm/getrecentv2`.
* **Cơ chế:** Tự động fallback: Nếu endpoint cũ trả về 404, hệ thống tự động chuyển sang V2 mà không làm gián đoạn chương trình.

### 4. Bóc tách và Chuẩn hóa dữ liệu tin nhắn thực tế
* **Thực nghiệm:** Đã lấy thành công **8 tin nhắn** thực tế từ nhóm mới tạo (`482139729931377144`).
* **Sắp xếp chuẩn xác:** Dữ liệu được sắp xếp theo thời gian thực tế (`Test 1` -> `Test 2` -> `1` -> `2` -> `3` -> `Test3` -> `4` -> `5`).
* **Schema chuẩn hóa xuất ra tại `output/messages-normalized.json`:**
  - `id`: Mã định danh tin nhắn từ Zalo.
  - `groupId`: ID nhóm.
  - `senderId`: ID người gửi.
  - `senderName`: Tên hiển thị người gửi.
  - `content`: Nội dung tin nhắn text hoặc cấu trúc media.
  - `timestamp`: Thời gian gửi (milliseconds).
  - `type`: Loại tin nhắn (`webchat`).

---

## III. CÁC ĐIỂM CHƯA ĐƯỢC & NGUYÊN NHÂN KỸ THUẬT (WHAT DOESN'T WORK & WHY)

### 1. Endpoint mặc định của thư viện `getGroupChatHistory()` bị lỗi HTTP 404
* **Hiện tượng:** Chạy hàm mặc định của `zca-js@2.2.0` báo lỗi `Request failed with status code 404`.
* **Nguyên nhân:** Endpoint `/api/group/history` là giao thức cũ của Zalo Web, máy chủ Zalo hiện đã xóa bỏ hoặc đổi đường dẫn. Thư viện `zca-js` trên npm chưa kịp merge PR sửa lỗi (PR #370).
* **Đã xử lý:** Đã tự viết module `custom-history.js` giải quyết dứt điểm vấn đề này.

### 2. Không lấy được tin nhắn lịch sử cũ từ trước khi tool đăng nhập
* **Hiện tượng:** Thử lấy tin nhắn từ nhóm cũ (*HomeCare*, *TAIKHOAN.SITE*), server Zalo trả về mã `error: 0` nhưng mảng tin nhắn rỗng: `groupMsgs: []`.
* **Nguyên nhân cốt lõi (Kiến trúc Zalo):**
  - Trong response từ Zalo có cờ: `"isFiltered": 1`.
  - **Zalo không lưu lịch sử chat vĩnh viễn trên Cloud:** Tin nhắn của Zalo được lưu trực tiếp trên bộ nhớ máy (Local Database) của điện thoại.
  - Khi tool đăng nhập QR, Zalo coi tool là một **"Trình duyệt Web mới" (Thiết bị phụ chưa tin cậy)**.
  - Zalo mặc định **chặn toàn bộ tin nhắn phát sinh trước thời điểm đăng nhập web** để bảo vệ quyền riêng tư, trừ khi người dùng thực hiện thao tác đồng bộ P2P từ điện thoại sang.

### 3. Bản sao lưu trên điện thoại không giúp Zalo Web đọc được tin nhắn
* **Hiện tượng:** Điện thoại đã bấm "Sao lưu tin nhắn", trên app điện thoại vẫn xem được, nhưng Zalo Web/Tool vẫn không đọc được.
* **Nguyên nhân:** Tính năng sao lưu của Zalo là lưu file mã hóa lên **Google Drive/iCloud cá nhân** của người dùng, máy chủ Zalo không giữ bản sao mở này để cung cấp qua Web API.

---

## IV. BẢN CHẤT KIẾN TRÚC ZALO VÀ NGUY CƠ BẢO MẬT

1. **Về chính sách:** Zalo **không cung cấp API cho tài khoản cá nhân** (chỉ có API cho Zalo Official Account doanh nghiệp). Mọi giải pháp dùng `zca-js` đều là giả lập ngầm và vi phạm điều khoản sử dụng của Zalo.
2. **Cơ chế chống tự động hóa (Anti-Bot):**
   * Nếu gửi request dồn dập (ví dụ khi bị sập mạng rồi bật lại cố gắng kéo bù hàng trăm tin nhắn liên tục mà không có delay), Zalo sẽ kích hoạt cơ chế khóa tính năng hoặc hủy phiên đăng nhập.
3. **Cơ chế đơn phiên (Single Session):** Mỗi tài khoản Zalo chỉ cho phép **1 phiên Web hoạt động đồng thời**. Nếu người quản lý mở Zalo Web trên trình duyệt khác, phiên của tool có thể bị ngắt kết nối.

---

## V. ĐỀ XUẤT CÁC PHƯƠNG ÁN TRIỂN KHAI TIẾP THEO

### Phương án 1: Trở thành Service Lắng Nghe Thời Gian Thực (Khuyến nghị cho Tool hiện tại)
* **Mục tiêu:** Giám sát và ghi nhận toàn bộ tin nhắn mới của các nhóm từ thời điểm tool vận hành.
* **Cách làm:** Sử dụng `api.listener.on('message', ...)` để chạy nền 24/7.
* **Ưu điểm:**
  - Không bao giờ bị dính cờ `isFiltered`.
  - Nhận tin nhắn ngay lập tức khi vừa phát sinh (real-time).
  - An toàn, tải nhẹ, đúng cơ chế hoạt động của Zalo Web.

### Phương án 2: Tự động hóa bằng Playwright (Nếu bắt buộc phải lấy tin nhắn cũ có đồng bộ)
* **Mục tiêu:** Xây dựng Web App cho người dùng quét QR trên web, bấm "Đồng bộ" trên điện thoại để lấy trọn vẹn cả tin nhắn cũ.
* **Cách làm:** Backend Node.js điều khiển trình duyệt Chromium chạy ngầm (Playwright) mở `chat.zalo.me`, nhận luồng đồng bộ chính thức từ điện thoại vào IndexedDB rồi trích xuất ra JSON.
* **Ưu điểm:** Lấy được 100% lịch sử cũ như trên web, giao diện trực quan cho người dùng.

### Phương án 3: Cơ chế Bù đắp khi sập Service (Catch-up Sync)
* **Cách làm:**
  - Lưu `lastSavedMsgId` vào file `checkpoints.json`.
  - Khi service kết nối lại sau sự cố, chỉ lội ngược tìm các tin nhắn phát sinh giữa `lastSavedMsgId` và hiện tại.
  - Bắt buộc gắn **Rate Limiter (Delay 1.5s - 2s)** giữa các trang để tránh bị Zalo phạt spam.
