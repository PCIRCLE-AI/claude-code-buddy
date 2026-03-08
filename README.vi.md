<div align="center">

# 🧠 MeMesh Plugin

### Plugin năng suất cho Claude Code

Bộ nhớ, phân tích tác vụ thông minh và tự động hóa quy trình — tất cả trong một plugin.

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io)

[Cài đặt](#cài-đặt) • [Cách dùng](#cách-dùng) • [Xử lý sự cố](#xử-lý-sự-cố)

[English](README.md) • [繁體中文](README.zh-TW.md) • [简体中文](README.zh-CN.md) • [日本語](README.ja.md) • [한국어](README.ko.md) • [Français](README.fr.md) • [Deutsch](README.de.md) • [Español](README.es.md) • **Tiếng Việt** • [ภาษาไทย](README.th.md) • [Bahasa Indonesia](README.id.md)

</div>

---

## Tại sao tạo dự án này

Dự án này bắt đầu vì tôi muốn giúp nhiều người hơn — đặc biệt là những người mới học lập trình — tận dụng tối đa Claude Code cho vibe coding. Một điều tôi nhận ra: khi dự án lớn dần, rất khó để theo dõi tất cả các quyết định đã được đưa ra qua các phiên làm việc. Vì vậy tôi đã xây dựng một plugin (cùng với Claude Code, tất nhiên) để ghi nhớ giúp bạn.

> **Lưu ý**: Dự án này ban đầu có tên "Claude Code Buddy" và đã được đổi tên thành MeMesh Plugin để tránh các vấn đề về thương hiệu.

## Nó làm được gì?

MeMesh Plugin giúp Claude Code thông minh hơn và năng suất hơn. Không chỉ là bộ nhớ — mà là bộ công cụ hoàn chỉnh:

**Bộ nhớ dự án có thể tìm kiếm** — Tự động lưu các quyết định, mẫu thiết kế và bài học. Tìm kiếm theo ý nghĩa, không chỉ từ khóa. Hỏi "chúng ta đã quyết định gì về auth?" và nhận câu trả lời ngay.

**Phân tích tác vụ thông minh** — Khi bạn gõ `buddy-do "thêm auth"`, MeMesh phân tích tác vụ, lấy ngữ cảnh liên quan từ công việc trước đó, và đưa ra kế hoạch đầy đủ trước khi thực hiện.

**Tự động hóa quy trình** — MeMesh tự động làm việc nền:
- Hiển thị tóm tắt phiên trước khi bắt đầu
- Theo dõi các file đã sửa và kiểm thử
- Nhắc review code trước khi commit
- Định tuyến tác vụ đến model tối ưu

**Học từ lỗi** — Ghi lại lỗi và cách sửa để xây dựng cơ sở tri thức và tránh lặp lại sai lầm.

**Khác gì so với bộ nhớ tích hợp của Claude?**

Claude Code đã có auto memory và CLAUDE.md — tốt cho cài đặt chung. MeMesh bổ sung **công cụ chuyên dụng cho dự án**: bộ nhớ tìm kiếm theo ý nghĩa, phân tích tác vụ với ngữ cảnh trước đó, và quy trình tự động giúp mỗi phiên làm việc hiệu quả hơn.

Hãy nghĩ như thế này:
- **CLAUDE.md** = sách hướng dẫn sử dụng cho Claude
- **MeMesh** = sổ tay tìm kiếm được + trợ lý thông minh phát triển cùng dự án

---

## Cài đặt

**Bạn cần**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) và Node.js 20+

```bash
npm install -g @pcircle/memesh
```

Khởi động lại Claude Code. Xong.

**Kiểm tra hoạt động** — gõ lệnh này trong Claude Code:

```
buddy-help
```

Bạn sẽ thấy danh sách các lệnh.

<details>
<summary>Cài đặt từ mã nguồn (cho người đóng góp)</summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

</details>

---

## Cách dùng

MeMesh thêm 3 lệnh vào Claude Code:

| Lệnh | Chức năng |
|------|-----------|
| `buddy-do "nhiệm vụ"` | Chạy nhiệm vụ với ngữ cảnh bộ nhớ |
| `buddy-remember "chủ đề"` | Tìm kiếm các quyết định và ngữ cảnh trước đó |
| `buddy-help` | Hiển thị các lệnh có sẵn |

**Ví dụ:**

```bash
buddy-do "giải thích codebase này"
buddy-do "thêm xác thực người dùng"
buddy-remember "quyết định thiết kế API"
buddy-remember "tại sao chọn PostgreSQL"
```

Tất cả dữ liệu được lưu trên máy của bạn. Các quyết định được giữ 90 ngày, ghi chú phiên được giữ 30 ngày.

---

## Nền tảng hỗ trợ

| Nền tảng | Trạng thái |
|----------|-----------|
| **macOS** | ✅ Hoạt động |
| **Linux** | ✅ Hoạt động |
| **Windows** | ✅ Hoạt động (khuyên dùng WSL2) |

**Hoạt động với:**
- Claude Code CLI (terminal)
- Claude Code VS Code Extension
- Cursor (qua MCP)
- Các editor tương thích MCP khác

**Claude Desktop (Cowork)**: Các lệnh cơ bản hoạt động, nhưng tính năng bộ nhớ cần phiên bản CLI. Xem [chi tiết Cowork](docs/COWORK_SUPPORT.md).

---

## Xử lý sự cố

**MeMesh không hiển thị?**

```bash
# Kiểm tra đã cài đặt chưa
npm list -g @pcircle/memesh

# Kiểm tra phiên bản Node.js (cần 20+)
node --version

# Chạy lại setup
memesh setup
```

Sau đó khởi động lại Claude Code hoàn toàn.

Thêm trợ giúp: [Hướng dẫn xử lý sự cố](docs/TROUBLESHOOTING.md)

---

## Tìm hiểu thêm

- **[Bắt đầu](docs/GETTING_STARTED.md)** — Hướng dẫn cài đặt từng bước
- **[Hướng dẫn sử dụng](docs/USER_GUIDE.md)** — Hướng dẫn đầy đủ với ví dụ
- **[Lệnh](docs/COMMANDS.md)** — Tất cả các lệnh có sẵn
- **[Kiến trúc](docs/ARCHITECTURE.md)** — Cách hoạt động bên trong
- **[Đóng góp](CONTRIBUTING.md)** — Muốn giúp? Bắt đầu tại đây
- **[Hướng dẫn phát triển](docs/DEVELOPMENT.md)** — Cho người đóng góp

---

## Giấy phép

MIT — Xem [LICENSE](LICENSE)

---

<div align="center">

Có vấn đề? [Mở Issue](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new) — chúng tôi phản hồi nhanh.

[Báo lỗi](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=bug&template=bug_report.yml) • [Yêu cầu tính năng](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions)

</div>
