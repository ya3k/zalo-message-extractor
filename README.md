# Zalo Ingestion MVP — Worker + Adapter + Message/Media Storage

Dự án thu thập, chuẩn hóa và lưu trữ tin nhắn từ tài khoản Zalo cá nhân của quản lý, tập trung vào các nhóm khách hàng được phép truy cập theo nguyên tắc ủy quyền tối thiểu (Least Privilege).

Luồng dữ liệu:
```
Zalo Personal Account
      ↓
zca-js Worker (Single-account, session lifecycle, egress check)
      ↓
Zalo Adapter (Anti-corruption layer, schema mapping)
      ↓
Normalized Message (Versioned internal schema)
      ↓
[Fast Path] JSON Message Storage (Atomic write, idempotency per account/group/msgId)
      ↓
[Async Path] Persistent Media Queue (Filesystem job queue, bounded concurrency, backoff retry)
      ↓
Media Storage (SHA-256, atomic write, duplicate check) → Update Normalized Message
```

> [!WARNING]
> **CẢNH BÁO BẢO MẬT & RỦI RO NỀN TẢNG:**
> - `zca-js` là một thư viện không chính thức (reverse engineering giao thức Zalo Web).
> - Zalo không cung cấp API công khai cho tài khoản cá nhân. Việc sử dụng thư viện tự động có nguy cơ bị phát hiện, tạm khóa tính năng hoặc khóa tài khoản vĩnh viễn nếu thao tác bất thường hoặc gửi request dồn dập.
> - **Chỉ đọc dữ liệu (Read-Only):** Worker tuyệt đối không gửi tin nhắn, không tham gia nhóm, không thay đổi hay xóa dữ liệu trên Zalo.
> - **Ủy quyền tối thiểu:** Worker chỉ thu thập tin nhắn từ các nhóm được cấu hình trong `ALLOWED_GROUP_IDS`. Mọi nhóm khác đều bị bỏ qua tự động.
> - Tuyệt đối không commit các file credentials: `.env`, `session.json`, `qr.png`, hoặc các thư mục dữ liệu `storage/`, `output/`.

---

## 1. Yêu cầu hệ thống

- **Node.js**: >= 18.0.0 (đã kiểm thử và chạy ổn định trên Node.js v25.6.1 LTS/Current).
- **Package Manager**: `npm` (đi kèm Node.js).
- Điện thoại có cài ứng dụng Zalo để quét mã QR xác thực lần đầu.

---

## 2. Cài đặt

Điều hướng vào thư mục dự án và cài đặt dependencies:

```bash
cd zalo-message-extractor
npm install
```

Thư viện giao tiếp Zalo: `zca-js@2.2.0`. Không cần sửa bất kỳ file nào trong `node_modules/`.

---

## 3. Cấu hình biến môi trường

Sao chép file `.env.example` thành `.env`:

```bash
cp .env.example .env
```

Nội dung cấu hình chi tiết:

```env
# Định danh nội bộ tài khoản
ACCOUNT_ID=acc_manager_01

# Đường dẫn lưu session token sau khi quét QR
SESSION_PATH=./session.json
QR_PATH=./qr.png

# Danh sách ID các nhóm ĐƯỢC PHÉP TRUY CẬP (phân cách bằng dấu phẩy)
ALLOWED_GROUP_IDS=482139729931377144

# Cấu hình IP egress (tùy chọn)
EGRESS_PROXY_URL=
EXPECTED_EGRESS_IP=
VERIFY_EGRESS_IP=false

# Thư mục lưu trữ
STORAGE_DIR=./storage
MEDIA_DIR=./storage/media
OUTPUT_DIR=./output

# Vận hành và đồng bộ
MESSAGE_COUNT=20
RATE_LIMIT_DELAY_MS=1500
MAX_RETRIES=3
AUTO_DOWNLOAD_MEDIA=true
MAX_MEDIA_SIZE_BYTES=26214400
```

---

## 4. Hướng dẫn vận hành

### Bước 1: Kiểm tra IP egress (tùy chọn)

```bash
npm run verify-egress
```
Script sẽ gửi request kiểm tra IP công khai và so sánh với `EXPECTED_EGRESS_IP` nếu được cấu hình.

### Bước 2: Đăng nhập QR và lấy danh sách nhóm

```bash
npm run list-groups
```
- Nếu chưa có `session.json`, file ảnh `qr.png` sẽ được tạo và tự động mở trên Windows.
- Dùng app Zalo trên điện thoại quét mã QR và chọn **Xác nhận đăng nhập**.
- Session được mã hóa lưu tự động vào `session.json` (chế độ quyền 0600).
- Hệ thống in danh sách tất cả các nhóm kèm trạng thái `[ĐƯỢC PHÉP TRUY CẬP]` hoặc `[CHƯA CẤU HÌNH]`.
- Chọn các ID nhóm cần thiết và điền vào `ALLOWED_GROUP_IDS` trong `.env`.

### Bước 3: Chạy Ingestion Worker

```bash
npm run worker
```
Worker sẽ:
1. Xác minh IP egress (nếu bật).
2. Tái sử dụng session đã lưu (không cần quét lại QR).
3. Lặp qua danh sách `ALLOWED_GROUP_IDS`.
4. Gọi API Zalo Cloud Message V2 (`/api/cm/getrecentv2`) với retry có giới hạn (exponential backoff).
5. Lưu trữ raw response vào `storage/raw/{accountId}/{groupId}/`.
6. Chuẩn hóa qua `ZaloAdapter` thành `NormalizedMessage`.
7. Tải media đính kèm (ảnh, video, file) vào `storage/media/` với mã hóa checksum SHA-256.
8. Ghi dữ liệu bền vững nguyên tử (Atomic write: ghi `.tmp` rồi rename) và khử trùng lặp theo `messageId`.
9. Cập nhật checkpoint đồng bộ vào `storage/checkpoints/{accountId}_{groupId}.json`.

### Bước 4: Chạy Daemon lắng nghe thời gian thực (Real-time Listener 24/7)

Nếu muốn hệ thống **tự động nhận tin nhắn ngay lập tức** khi có người nhắn vào nhóm mà không cần gõ lệnh thủ công:

```bash
npm run listen
```
- Daemon sẽ giữ kết nối WebSocket liên tục với máy chủ Zalo.
- Khi có bất kỳ tin nhắn mới nào phát sinh trong các nhóm thuộc `ALLOWED_GROUP_IDS`, hệ thống tự động nhận diện, tải media (nếu có), chuẩn hóa và ghi vào kho `storage/` trong vài mili-giây.

### Bước 5: Kiểm chứng nhanh một nhóm đơn lẻ (Batch Test)

```bash
npm run test-history
```

---

## 5. Cấu trúc thư mục mã nguồn

```
src/
├── config/
│   ├── account-config.js      # Mô hình hóa cấu hình tài khoản, tách khỏi Worker
│   └── env.js                 # Đọc biến môi trường an toàn
├── client/
│   ├── zalo-client.js         # Khởi tạo Zalo client, QR login, tái sử dụng session
│   ├── custom-history.js      # Adapter Cloud Message V2 (PR #370) qua api.custom()
│   └── egress-verifier.js     # Kiểm tra và xác minh địa chỉ IP egress thực tế
├── adapter/
│   ├── zalo-adapter.js        # Anti-corruption layer mapping dữ liệu thô sang NormalizedMessage
│   └── message-types.js       # Định nghĩa hằng số kiểu tin nhắn và attachment
├── storage/
│   ├── media-storage.js       # FileSystemMediaStorage (atomic write, SHA-256, giới hạn kích thước)
│   ├── message-storage.js     # MessageStorage (ghi nguyên tử, khử trùng lặp theo messageId)
│   └── sync-checkpoint.js     # Quản lý checkpoint/cursor đồng bộ theo từng nhóm
├── worker/
│   └── zalo-worker.js         # Worker điều phối vòng đời thu thập, kiểm soát quyền và rate limit
└── index.js                   # Điểm xuất khẩu chính của thư viện
```

---

## 6. Schema chuẩn hóa (Normalized Message Schema)

Mỗi tin nhắn được chuẩn hóa theo schema nội bộ phiên bản `1.0.0`:

```json
{
  "schemaVersion": "1.0.0",
  "source": "zalo",
  "accountId": "acc_manager_01",
  "groupId": "482139729931377144",
  "messageId": "8367126694360",
  "senderId": "139268688461019000",
  "senderName": "Nguyễn Văn A",
  "content": "Nội dung tin nhắn khách hàng",
  "messageType": "text",
  "sentAt": "2026-10-12T14:19:34.422Z",
  "observedAt": "2026-10-12T14:44:23.555Z",
  "attachments": [
    {
      "attachmentId": "photo_123",
      "type": "image",
      "fileName": "photo_receipt.jpg",
      "mimeType": "image/jpeg",
      "sizeBytes": 1048576,
      "storageKey": "acc_manager_01/482139729931377144/photo_123_a1b2c3d4e5f6.jpg",
      "checksum": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "downloadStatus": "downloaded"
    }
  ],
  "rawMetadata": {
    "cliMsgId": "1791814654137",
    "rawMsgType": "webchat",
    "status": 3,
    "cmd": 12500,
    "ttl": 0,
    "isSelf": false
  }
}
```

---

## 7. Kiểm thử tự động (Automated Tests)

Chạy toàn bộ 55+ unit test độc lập không phụ thuộc tài khoản thật:

```bash
npm test
```

Bao phủ các ca kiểm thử:
- Ánh xạ response thô sang NormalizedMessage.
- Tin nhắn thiếu trường tùy chọn (không tự bịa ID hay timestamp).
- Tin nhắn phi văn bản (`chat.photo`, `share.file`, `chat.video.msg`, `chat.voice`, `chat.sticker`, `chat.link`).
- Attachment thiếu metadata hoặc không có URL tải (`unsupported`).
- Media tải thất bại (ghi nhận trạng thái `failed`, không lưu file rác).
- Khử trùng lặp tin nhắn dựa trên `messageId`.
- Ghi file nguyên tử và xử lý gián đoạn.
- Kiểm soát quyền truy cập nhóm (Scope Access Control) và cơ chế retry khi gặp lỗi tạm thời.
