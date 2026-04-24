🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>Lớp bộ nhớ cục bộ cho Claude Code và các coding agent tương thích MCP.</strong><br />
    Một tệp SQLite. Không cần Docker. Không cần phụ thuộc vào cloud.
  </p>
</p>

> README tiếng Việt này là bản giới thiệu rút gọn. Để xem nội dung đầy đủ và mới nhất, hãy dùng [English README](README.md) làm bản tham chiếu chính.

## MeMesh giải quyết vấn đề gì?

Coding agent thường mất ngữ cảnh giữa các session. Quyết định kiến trúc, lỗi đã sửa, bài học đã rút ra và các ràng buộc của dự án cứ phải giải thích lại nhiều lần.

**MeMesh giữ lại phần kiến thức đó trên máy cục bộ, cho phép tìm kiếm, xem lại và dùng lại khi cần.**

Gói npm này là phiên bản plugin / package chạy cục bộ của MeMesh. Nó không phải sản phẩm workspace trên cloud hay toàn bộ nền tảng enterprise.

## Bắt đầu trong 60 giây

### 1. Cài đặt

```bash
npm install -g @pcircle/memesh
```

### 2. Lưu một quyết định

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### 3. Gọi lại sau này

```bash
memesh recall "login security"
# → vẫn tìm được "OAuth 2.0 with PKCE" dù dùng cách diễn đạt khác
```

Mở dashboard:

```bash
memesh
```

## Dành cho ai?

- Nhà phát triển dùng Claude Code và muốn giữ ngữ cảnh dự án giữa các session
- Người dùng nâng cao muốn dùng chung một bộ nhớ cục bộ cho nhiều MCP coding agents
- Nhóm AI-native nhỏ muốn chia sẻ kiến thức dự án qua export / import
- Nhà phát triển agent muốn tích hợp bộ nhớ cục bộ qua CLI, HTTP hoặc MCP

## Vì sao chọn MeMesh?

- Local-first: dữ liệu nằm trong tệp SQLite của chính bạn
- Cài đặt gọn nhẹ: `npm install -g` là có thể dùng
- Tích hợp rõ ràng: hỗ trợ CLI, HTTP và MCP
- Hợp với Claude Code: hooks giúp kéo đúng ngữ cảnh vào lúc làm việc
- Dễ kiểm tra và dọn dẹp: dashboard giúp nhìn thấy bộ nhớ, không phải hộp đen
- Ranh giới tin cậy an toàn hơn: bộ nhớ import vẫn tìm kiếm được, nhưng không tự động inject vào Claude hooks nếu chưa được rà soát hoặc lưu lại tại máy cục bộ

## MeMesh tự động làm gì trong Claude Code?

Hiện tại, MeMesh hỗ trợ ở 5 thời điểm:

- khi bắt đầu session, nạp các memory liên quan và bài học đã biết
- trước khi sửa file, gọi lại memory liên quan đến file hoặc dự án
- sau `git commit`, ghi lại thay đổi vừa thực hiện
- khi kết thúc session, tổng hợp lỗi, bản sửa và lessons learned
- trước khi compact context, lưu lại những gì quan trọng vào bộ nhớ cục bộ

## Dashboard có gì?

Dashboard hiện có 7 tab và hỗ trợ 11 ngôn ngữ:

- Search: tìm memory
- Browse: xem toàn bộ memory
- Analytics: theo dõi độ khỏe và xu hướng
- Graph: xem quan hệ kiến thức
- Lessons: xem lại bài học
- Manage: lưu trữ và khôi phục
- Settings: cấu hình LLM provider và ngôn ngữ

## Smart Mode là gì?

Mặc định MeMesh chạy offline. Nếu bạn thêm LLM API key, bạn có thể bật thêm các khả năng như:

- query expansion
- tự động trích xuất tốt hơn
- sắp xếp và nén thông minh hơn

Ngay cả khi không có API key, phần cốt lõi vẫn hoạt động bình thường.

## Tìm hiểu thêm

- Tính năng đầy đủ, so sánh, API và thông tin release: [English README](README.md)
- Hướng dẫn tích hợp: [docs/platforms/README.md](docs/platforms/README.md)
- Tài liệu API: [docs/api/API_REFERENCE.md](docs/api/API_REFERENCE.md)

## Phát triển và kiểm thử

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory
npm install
npm run build
npm test
```
