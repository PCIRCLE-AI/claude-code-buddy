<div align="center">

<img src="https://img.shields.io/badge/%F0%9F%A7%A0-MeMesh-blueviolet?style=for-the-badge" alt="MeMesh" />

# MeMesh

### Các phiên lập trình AI của bạn xứng đáng có bộ nhớ.

MeMesh mang đến cho Claude Code bộ nhớ bền vững, có thể tìm kiếm — để mỗi phiên làm việc đều kế thừa từ phiên trước.

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@pcircle/memesh)
[![Downloads](https://img.shields.io/npm/dm/@pcircle/memesh?style=flat-square&color=blue)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple?style=flat-square)](https://modelcontextprotocol.io)

```bash
npm install -g @pcircle/memesh
```

[Bắt đầu](#bắt-đầu) · [Cách hoạt động](#cách-hoạt-động) · [Lệnh](#lệnh) · [Tài liệu](docs/USER_GUIDE.md)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · **Tiếng Việt** · [ภาษาไทย](README.th.md) · [Bahasa Indonesia](README.id.md)

</div>

> **Lưu ý**: Dự án này ban đầu có tên "Claude Code Buddy" và đã được đổi tên thành MeMesh Plugin để tránh các vấn đề về thương hiệu.

---

## Vấn đề

Bạn đang làm việc sâu với Claude Code trên một dự án. Bạn đã đưa ra những quyết định quan trọng cách đây ba phiên — thư viện xác thực nào, tại sao chọn schema cơ sở dữ liệu đó, những mẫu thiết kế nào cần tuân theo. Nhưng Claude không nhớ. Bạn phải lặp lại. Bạn mất ngữ cảnh. Bạn lãng phí thời gian.

**MeMesh giải quyết vấn đề này.** Nó cung cấp cho Claude bộ nhớ bền vững, có thể tìm kiếm, phát triển cùng dự án của bạn.

---

## Cách hoạt động

<table>
<tr>
<td width="50%">

### Trước MeMesh
```
Phiên 1: "Dùng JWT cho auth"
Phiên 2: "Tại sao mình chọn JWT nhỉ?"
Phiên 3: "Khoan, mình đang dùng thư viện auth nào?"
```
Bạn lặp lại các quyết định. Claude quên ngữ cảnh. Tiến độ bị đình trệ.

</td>
<td width="50%">

### Sau MeMesh
```
Phiên 1: "Dùng JWT cho auth" → đã lưu
Phiên 2: buddy-remember "auth" → nhớ lại ngay
Phiên 3: Ngữ cảnh tự động tải khi bắt đầu
```
Mỗi phiên đều tiếp nối từ nơi bạn dừng lại.

</td>
</tr>
</table>

---

## Bạn được gì

**Bộ nhớ dự án có thể tìm kiếm** — Hỏi "chúng ta đã quyết định gì về auth?" và nhận câu trả lời ngay lập tức, khớp theo ngữ nghĩa. Không phải tìm kiếm từ khóa — mà là tìm kiếm theo *ý nghĩa*, sử dụng ONNX embeddings chạy cục bộ.

**Phân tích tác vụ thông minh** — `buddy-do "thêm user auth"` không chỉ đơn giản thực thi. Nó lấy ngữ cảnh liên quan từ các phiên trước, kiểm tra những mẫu thiết kế bạn đã thiết lập, và xây dựng kế hoạch chi tiết trước khi viết một dòng code nào.

**Gợi nhớ chủ động** — MeMesh tự động hiển thị các ký ức liên quan khi bạn bắt đầu phiên, gặp lỗi kiểm thử, hoặc gặp lỗi. Không cần tìm kiếm thủ công.

**Tự động hóa quy trình** — Tóm tắt phiên khi khởi động. Theo dõi thay đổi file. Nhắc review code trước khi commit. Tất cả chạy ngầm trong nền.

**Học từ lỗi** — Ghi lại lỗi và cách sửa để xây dựng cơ sở tri thức. Cùng một lỗi không xảy ra hai lần.

---

## Bắt đầu

**Yêu cầu**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) + Node.js 20+

```bash
npm install -g @pcircle/memesh
```

Khởi động lại Claude Code. Xong.

**Kiểm tra** — gõ trong Claude Code:

```
buddy-help
```

Bạn sẽ thấy danh sách các lệnh có sẵn.

<details>
<summary><strong>Cài đặt từ mã nguồn</strong> (dành cho người đóng góp)</summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

</details>

---

## Lệnh

| Lệnh | Chức năng |
|---------|-------------|
| `buddy-do "tác vụ"` | Thực thi tác vụ với đầy đủ ngữ cảnh bộ nhớ |
| `buddy-remember "chủ đề"` | Tìm kiếm các quyết định và ngữ cảnh trước đó |
| `buddy-help` | Hiển thị các lệnh có sẵn |

**Ví dụ thực tế:**

```bash
# Làm quen với một codebase mới
buddy-do "explain this codebase"

# Xây dựng tính năng với ngữ cảnh từ công việc trước
buddy-do "add user authentication"

# Nhớ lại lý do đưa ra quyết định
buddy-remember "API design decisions"
buddy-remember "why we chose PostgreSQL"
```

Tất cả dữ liệu nằm trên máy bạn với thời gian lưu giữ tự động 90 ngày.

---

## Khác gì so với CLAUDE.md?

| | CLAUDE.md | MeMesh |
|---|-----------|--------|
| **Mục đích** | Hướng dẫn tĩnh cho Claude | Bộ nhớ sống, phát triển cùng dự án |
| **Tìm kiếm** | Tìm kiếm văn bản thủ công | Tìm kiếm ngữ nghĩa theo ý nghĩa |
| **Cập nhật** | Bạn chỉnh sửa thủ công | Tự động ghi lại quyết định khi bạn làm việc |
| **Gợi nhớ** | Luôn được tải (có thể rất dài) | Hiển thị ngữ cảnh liên quan theo yêu cầu |
| **Phạm vi** | Tùy chọn chung | Đồ thị tri thức theo dự án |

**Chúng hoạt động cùng nhau.** CLAUDE.md cho Claude biết *cách* làm việc. MeMesh ghi nhớ *những gì* bạn đã xây dựng.

---

## Nền tảng hỗ trợ

| Nền tảng | Trạng thái |
|----------|--------|
| macOS | ✅ |
| Linux | ✅ |
| Windows | ✅ (khuyên dùng WSL2) |

**Hoạt động với:** Claude Code CLI · VS Code Extension · Cursor (qua MCP) · Bất kỳ editor tương thích MCP nào

---

## Kiến trúc

MeMesh hoạt động như một plugin Claude Code chạy cục bộ, tích hợp thành phần MCP:

- **Knowledge Graph** — Kho lưu trữ thực thể dựa trên SQLite với tìm kiếm toàn văn FTS5
- **Vector Embeddings** — ONNX runtime cho tương đồng ngữ nghĩa (chạy 100% cục bộ)
- **Content Dedup** — Băm SHA-256 bỏ qua tính toán embedding trùng lặp
- **Batch Processing** — Xử lý hàng loạt hiệu quả cho cơ sở tri thức lớn
- **Hook System** — Gợi nhớ chủ động khi bắt đầu phiên, lỗi kiểm thử và lỗi chung

Mọi thứ chạy cục bộ. Không cloud. Không gọi API. Dữ liệu của bạn không bao giờ rời khỏi máy.

---

## Tài liệu

| Tài liệu | Mô tả |
|-----|-------------|
| [Bắt đầu](docs/GETTING_STARTED.md) | Hướng dẫn cài đặt từng bước |
| [Hướng dẫn sử dụng](docs/USER_GUIDE.md) | Hướng dẫn đầy đủ với ví dụ |
| [Lệnh](docs/COMMANDS.md) | Tham chiếu lệnh đầy đủ |
| [Kiến trúc](docs/ARCHITECTURE.md) | Phân tích kỹ thuật chuyên sâu |
| [Đóng góp](CONTRIBUTING.md) | Hướng dẫn đóng góp |
| [Phát triển](docs/DEVELOPMENT.md) | Cài đặt môi trường cho người đóng góp |

---

## Đóng góp

Chúng tôi hoan nghênh đóng góp! Xem [CONTRIBUTING.md](CONTRIBUTING.md) để bắt đầu.

---

## Giấy phép

MIT — Xem [LICENSE](LICENSE)

---

<div align="center">

**Được xây dựng với Claude Code, cho Claude Code.**

[Báo lỗi](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=bug&template=bug_report.yml) · [Yêu cầu tính năng](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions) · [Trợ giúp](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new)

</div>
