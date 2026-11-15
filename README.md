# Quản lí chi tiêu gia đình — bản triển khai độc lập

Trang web quản lí **chi phí sinh hoạt và thu nhập** dùng chung cho **nhiều gia đình**: mỗi gia đình đăng kí một tài khoản riêng, dữ liệu tách biệt hoàn toàn, và cùng một tài khoản đăng nhập được trên nhiều máy cùng lúc.

Bản này **độc lập hoàn toàn** với app dùng thử trong Muse: code thuần Node.js, không cần cài thêm thư viện nào (không có dependencies, `npm install` cũng không cần).

## Tính năng

- **Tài khoản nhiều gia đình:** đăng kí (tên gia đình + tên đăng nhập + mật khẩu), đăng nhập / đăng xuất, đổi mật khẩu. Mật khẩu băm bằng `scrypt` kèm muối riêng — không lưu mật khẩu dạng rõ. Mỗi phiên đăng nhập là một token riêng cho từng máy (đăng xuất chỉ thoát máy đó). Tên đăng nhập trùng bị từ chối, sai mật khẩu bị từ chối.
- **Thu / chi:** thêm / sửa / xoá từng khoản với số tiền (¥), ngày, danh mục, ghi chú, người thu/chi, cách trả. Xem theo tháng (chuyển tháng ‹ ›), tổng **Thu / Chi / Còn lại** của tháng.
- **Biểu đồ:** biểu đồ cột so sánh Thu (xanh) – Chi (đỏ) của **6 tháng gần nhất** (chạm vào cột để nhảy tới tháng đó); biểu đồ tròn (vòng) **chi theo danh mục** trong từng tháng, kèm số tiền và % từng mục.
- **Hạn mức tháng:** mục riêng thu gọn, chỉ hiện những mục **đã đặt hạn mức** (thanh tiến độ + cảnh báo); mỗi hạn mức có **ngưỡng cảnh báo % tự chọn** (1–100%, mặc định 80%); thêm hạn mức cho mục khác, sửa, xoá.
- **Danh sách tuỳ chỉnh:** danh mục thu / chi, tên người nhập, cách trả đều thêm / đổi tên / xoá được (xoá chỉ ẩn khỏi danh sách chọn, khoản cũ giữ nguyên chữ). Tên gõ mới trong form nhập được **nhớ lại cho lần nhập sau**; danh mục tự đặt (nút “＋ Tự đặt tên”) dùng lại được ở khắp nơi, kể cả đặt hạn mức.
- **Thu chi cố định hàng tháng:** nhập một lần các mục như tiền nhà, điện, nước, gas kèm **ngày quyết toán**; app tự ghi vào sổ đúng ngày đó của từng tháng (tháng thiếu ngày thì lùi về ngày cuối tháng), mỗi tháng đúng một lần, ghi chú “Cố định hàng tháng”. Sửa mục chỉ áp dụng cho tháng chưa ghi; xoá mục thì dừng ghi từ tháng sau.
- **Thiết lập thanh toán:** mỗi cách trả đặt được **Trả ngay** (mặc định: Tiền mặt, Ngân hàng) hoặc **Tháng sau** (mặc định: PayPay, Thẻ tín dụng), áp dụng cả cách trả tự thêm. Khoản chi vẫn tính vào tháng nhập, nhưng dưới phần tổng kết có **ghi chú nổi bật**: tổng tiền tháng này trả bằng cách “Tháng sau” sẽ thanh toán vào tháng sau, tách riêng từng cách trả; từng khoản cũng gắn nhãn “trả tháng sau”.
- **Reset toàn bộ:** mục riêng ở cuối trang, liệt kê số lượng thật sẽ xoá của **gia đình đang đăng nhập**; phải xác nhận 2 bước và **gõ đúng XÓA HẾT** (không cần dấu) mới xoá. Chỉ xoá dữ liệu của gia đình đó, gia đình khác không ảnh hưởng.
- Cài lên màn hình chính điện thoại như app (PWA: manifest + service worker). Giao diện tiếng Việt, mobile-first.

Danh mục mặc định — Thu: Lương / Thưởng / Thu nhập khác. Chi: Ăn uống/siêu thị, Tiền nhà, Điện-gas-nước, Đi lại, Điện thoại/internet, Y tế, Mua sắm, Giải trí, Gửi về nhà, Khác. Cách trả mặc định: Tiền mặt, Ngân hàng, PayPay, Thẻ tín dụng.

## Chạy thử trên máy của bạn

Yêu cầu: Node.js 18 trở lên.

```bash
cd chi-tieu-deploy
node server.js
```

Mở http://localhost:3000 trên trình duyệt, bấm **Đăng kí tài khoản** để tạo tài khoản gia đình đầu tiên.

Biến môi trường:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3000` | Cổng chạy web |
| `DATA_FILE` | `data/db.json` | Đường dẫn file dữ liệu |

Ví dụ: `PORT=8080 DATA_FILE=/var/data/chi-tieu.json node server.js`

## Dữ liệu bắt đầu

File `data/db.json` đi kèm **trống hoàn toàn** (chưa có tài khoản, chưa có khoản thu chi nào) — các gia đình đăng kí mới trên trang đã triển khai. Không có dữ liệu nào được chép từ bản dùng thử sang.

## Đưa lên mạng để nhiều gia đình dùng chung

Nguyên tắc chung cho mọi nền tảng: chạy lệnh `node server.js` (hoặc `npm start`), mở cổng theo biến `PORT` mà nền tảng cấp, và **gắn file dữ liệu vào một ổ đĩa bền (persistent disk/volume)**.

### Render (render.com)

1. Đẩy thư mục này lên một repo GitHub, tạo **Web Service** trỏ vào repo.
2. Build Command: để trống (không có gì để build). Start Command: `node server.js`.
3. Vào mục **Disks**: tạo persistent disk (ví dụ mount tại `/var/data`, gói trả phí mới có disk).
4. Thêm biến môi trường: `DATA_FILE=/var/data/db.json` (PORT do Render tự cấp).

### Railway (railway.app)

1. Tạo project từ repo GitHub, Railway tự chạy `npm start`.
2. Thêm **Volume** gắn vào service (ví dụ mount tại `/var/data`).
3. Thêm biến môi trường: `DATA_FILE=/var/data/db.json`.

### VPS (máy chủ riêng)

```bash
# Cài Node.js 18+, chép thư mục lên máy chủ, rồi:
PORT=3000 DATA_FILE=/var/data/chi-tieu/db.json node server.js
```

Nên chạy bằng `pm2` hoặc `systemd` để tự khởi động lại, và đặt sau reverse proxy (Nginx/Caddy) có HTTPS.

### ⚠️ Cảnh báo về mất dữ liệu

Toàn bộ dữ liệu (tài khoản các gia đình, thu chi, hạn mức, mục cố định, thiết lập) nằm trong **một file JSON duy nhất**. Các gói miễn phí của Render/Railway và nhiều nền tảng khác **không có ổ đĩa bền**: mỗi lần service khởi động lại/redeploy, file dữ liệu sẽ quay về bản gốc trong code — tức là **mất hết dữ liệu đã nhập**. Muốn dùng lâu dài phải:

- Gắn persistent disk/volume như hướng dẫn trên, **hoặc**
- Sao lưu file `db.json` thường xuyên (chỉ cần copy 1 file), và
- Trước khi redeploy/cập nhật code, sao lưu `db.json` đang chạy rồi chép đè lại sau.

## Cấu trúc thư mục

```
chi-tieu-deploy/
├── server.js          # Máy chủ (Node thuần, không dependencies)
├── package.json
├── data/
│   └── db.json        # Dữ liệu (bắt đầu trống)
├── public/
│   ├── index.html     # Giao diện
│   ├── app.js         # Logic phía trình duyệt
│   ├── styles.css
│   ├── manifest.json  # PWA
│   ├── sw.js          # Service worker (cache app shell)
│   └── icon.svg
└── README.md
```
