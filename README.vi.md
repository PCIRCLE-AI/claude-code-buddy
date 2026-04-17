🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>Lớp bộ nhớ AI phổ quát nhẹ nhất.</strong><br />
    Một file SQLite. Mọi LLM. Không cần đám mây.
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@pcircle/memesh"><img src="https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=3b82f6&label=npm" alt="npm" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="MIT" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-22c55e?style=flat-square" alt="Node" /></a>
    <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-a855f7?style=flat-square" alt="MCP" /></a>
    <a href="https://pypi.org/project/memesh/"><img src="https://img.shields.io/badge/pip-memesh-3b82f6?style=flat-square" alt="PyPI" /></a>
  </p>
</p>

---

AI của bạn quên sạch mọi thứ giữa các phiên làm việc. **MeMesh giải quyết vấn đề đó.**

Cài đặt một lần, cấu hình trong 30 giây, và mọi công cụ AI bạn dùng — Claude, GPT, LLaMA, hay bất kỳ MCP client nào — đều có bộ nhớ bền vững, có thể tìm kiếm và không ngừng tiến hóa. Không cần đám mây. Không cần Neo4j. Không cần cơ sở dữ liệu vector. Chỉ một file SQLite.

```bash
npm install -g @pcircle/memesh
```

---

## Bảng điều khiển

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh Search" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-browse.png" alt="MeMesh Browse" width="100%" />
</p>

Chạy `memesh` để mở bảng điều khiển tương tác với các tab Tìm kiếm, Duyệt, Phân tích, Quản lý và Cài đặt.

---

## Bắt đầu nhanh

```bash
# Lưu một ký ức
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"

# Tìm kiếm ký ức (Chế độ Thông minh: tìm "login security" vẫn ra "OAuth")
memesh recall "login security"

# Lưu trữ ký ức lỗi thời (xóa mềm — không bao giờ mất vĩnh viễn)
memesh forget --name "old-auth-design"

# Mở bảng điều khiển
memesh

# Khởi động HTTP API (dành cho Python SDK và tích hợp bên ngoài)
memesh serve
```

### Python

```python
from memesh import MeMesh

m = MeMesh()  # connects to localhost:3737
m.remember("auth", "decision", observations=["Use OAuth 2.0 with PKCE"])
results = m.recall("auth")
```

### Bất kỳ LLM nào (định dạng OpenAI function calling)

```bash
memesh export-schema --format openai
# → JSON array of tools, paste into your OpenAI/Claude/Gemini API call
```

---

## Tại sao chọn MeMesh?

Hầu hết các giải pháp bộ nhớ AI yêu cầu Neo4j, cơ sở dữ liệu vector, API key và hơn 30 phút thiết lập. MeMesh chỉ cần **một lệnh duy nhất**.

| | **MeMesh** | Mem0 | Zep | Anthropic Memory |
|---|---|---|---|---|
| **Cài đặt** | `npm i -g` (5 giây) | pip + Neo4j + VectorDB | pip + Neo4j | Tích hợp sẵn (cloud) |
| **Lưu trữ** | Một file SQLite | Neo4j + Qdrant | Neo4j | Đám mây |
| **Tìm kiếm** | FTS5 + chấm điểm + mở rộng LLM | Ngữ nghĩa + BM25 | Đồ thị thời gian | Tra cứu theo khóa |
| **Quyền riêng tư** | 100% cục bộ, luôn luôn | Tùy chọn cloud | Tự lưu trữ | Đám mây |
| **Phụ thuộc** | 6 | 20+ | 10+ | 0 (nhưng bị khóa cloud) |
| **Ngoại tuyến** | Có | Không | Không | Không |
| **Bảng điều khiển** | Tích hợp (5 tab) | Không có | Không có | Không có |
| **Giá** | Miễn phí | Miễn phí/Trả phí | Miễn phí/Trả phí | Đi kèm API |

---

## Tính năng

### 6 Công cụ bộ nhớ

| Công cụ | Chức năng |
|------|-------------|
| **remember** | Lưu trữ kiến thức kèm quan sát, quan hệ và thẻ nhãn |
| **recall** | Tìm kiếm thông minh với chấm điểm đa nhân tố và mở rộng truy vấn bằng LLM |
| **forget** | Lưu trữ mềm (không xóa vĩnh viễn) hoặc xóa các quan sát cụ thể |
| **consolidate** | Nén ký ức dài dòng bằng LLM |
| **export** | Chia sẻ ký ức dạng JSON giữa các dự án hoặc thành viên nhóm |
| **import** | Nhập ký ức với chiến lược gộp (bỏ qua / ghi đè / nối thêm) |

### 3 Phương thức truy cập

| Phương thức | Lệnh | Phù hợp nhất |
|--------|---------|----------|
| **CLI** | `memesh` | Terminal, scripting, CI/CD |
| **HTTP API** | `memesh serve` | Python SDK, bảng điều khiển, tích hợp |
| **MCP** | `memesh-mcp` | Claude Code, Claude Desktop, mọi MCP client |

### 4 Hook tự động thu thập

| Hook | Kích hoạt | Nội dung thu thập |
|------|---------|-----------------|
| **Session Start** | Mỗi phiên làm việc | Tải các ký ức hàng đầu theo mức độ liên quan |
| **Post Commit** | Sau `git commit` | Ghi lại commit kèm thống kê diff |
| **Session Summary** | Khi Claude dừng | File đã chỉnh sửa, lỗi đã sửa, quyết định đã đưa ra |
| **Pre-Compact** | Trước khi nén | Lưu kiến thức trước khi mất ngữ cảnh |

### Tính năng thông minh

- **Tiến hóa kiến thức** — `forget` lưu trữ, không xóa. Quan hệ `supersedes` thay thế quyết định cũ bằng quyết định mới. Lịch sử được bảo toàn.
- **Gợi nhớ thông minh** — LLM mở rộng truy vấn tìm kiếm thành các thuật ngữ liên quan. "login security" tìm được "OAuth PKCE".
- **Chấm điểm đa nhân tố** — Kết quả được xếp hạng theo mức liên quan (35%) + độ mới (25%) + tần suất (20%) + độ tin cậy (15%) + hiệu lực thời gian (5%).
- **Phát hiện mâu thuẫn** — Cảnh báo khi các ký ức mâu thuẫn nhau.
- **Suy giảm tự động** — Ký ức lỗi thời (30+ ngày không dùng) dần giảm hạng. Không bao giờ bị xóa.
- **Không gian tên** — Phạm vi `personal`, `team`, `global` để tổ chức và chia sẻ.

---

## Kiến trúc

```
                    ┌─────────────────┐
                    │   Core Engine   │
                    │  (6 operations) │
                    └────────┬────────┘
           ┌─────────────────┼─────────────────┐
           │                 │                 │
     CLI (memesh)    HTTP API (serve)    MCP (memesh-mcp)
           │                 │                 │
           └─────────────────┼─────────────────┘
                             │
                    SQLite + FTS5 + sqlite-vec
                    (~/.memesh/knowledge-graph.db)
```

**Lõi** độc lập với framework — cùng một logic `remember`/`recall`/`forget` chạy giống hệt nhau dù được gọi từ terminal, HTTP hay MCP.

**Phụ thuộc**: `better-sqlite3`, `sqlite-vec`, `@modelcontextprotocol/sdk`, `zod`, `express`, `commander`

---

## Phát triển

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory
npm install
npm run build
npm test -- --run    # 289 tests
```

Phát triển bảng điều khiển:
```bash
cd dashboard
npm install
npm run dev          # Vite dev server with hot reload
npm run build        # Build to single HTML file
```

---

## Giấy phép

MIT — [PCIRCLE AI](https://pcircle.ai)
