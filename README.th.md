🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>เลเยอร์หน่วยความจำ AI สากลที่เบาที่สุด</strong><br />
    ไฟล์ SQLite เดียว รองรับทุก LLM ไม่ต้องพึ่งคลาวด์
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

AI ของคุณลืมทุกอย่างระหว่าง session **MeMesh แก้ปัญหานี้ได้**

ติดตั้งครั้งเดียว ตั้งค่าใน 30 วินาที แล้วทุกเครื่องมือ AI ที่คุณใช้ — Claude, GPT, LLaMA หรือ MCP client ใดก็ตาม — จะมีหน่วยความจำที่คงทน ค้นหาได้ และพัฒนาอย่างต่อเนื่อง ไม่ต้องใช้คลาวด์ ไม่ต้องใช้ Neo4j ไม่ต้องใช้ฐานข้อมูลเวกเตอร์ แค่ไฟล์ SQLite เดียวเท่านั้น

```bash
npm install -g @pcircle/memesh
```

---

## แดชบอร์ด

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh Search" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-browse.png" alt="MeMesh Browse" width="100%" />
</p>

รัน `memesh` เพื่อเปิดแดชบอร์ดแบบโต้ตอบที่มี 5 แท็บ ได้แก่ ค้นหา เรียกดู วิเคราะห์ จัดการ และตั้งค่า

---

## เริ่มต้นอย่างรวดเร็ว

```bash
# บันทึกความจำ
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"

# ค้นหาความจำ (โหมดอัจฉริยะ: ค้น "login security" ก็พบ "OAuth" ได้)
memesh recall "login security"

# เก็บถาวรความจำที่ล้าสมัย (ลบแบบนุ่มนวล — ไม่มีอะไรหายไปตลอดกาล)
memesh forget --name "old-auth-design"

# เปิดแดชบอร์ด
memesh

# เริ่ม HTTP API (สำหรับ Python SDK และการเชื่อมต่อภายนอก)
memesh serve
```

### Python

```python
from memesh import MeMesh

m = MeMesh()  # connects to localhost:3737
m.remember("auth", "decision", observations=["Use OAuth 2.0 with PKCE"])
results = m.recall("auth")
```

### ทุก LLM (รูปแบบ OpenAI function calling)

```bash
memesh export-schema --format openai
# → JSON array of tools, paste into your OpenAI/Claude/Gemini API call
```

---

## ทำไมต้อง MeMesh?

โซลูชันหน่วยความจำ AI ส่วนใหญ่ต้องการ Neo4j ฐานข้อมูลเวกเตอร์ API key และเวลาตั้งค่ากว่า 30 นาที MeMesh ใช้เพียง**คำสั่งเดียว**

| | **MeMesh** | Mem0 | Zep | Anthropic Memory |
|---|---|---|---|---|
| **ติดตั้ง** | `npm i -g` (5 วินาที) | pip + Neo4j + VectorDB | pip + Neo4j | ในตัว (คลาวด์) |
| **จัดเก็บ** | ไฟล์ SQLite เดียว | Neo4j + Qdrant | Neo4j | คลาวด์ |
| **ค้นหา** | FTS5 + scoring + LLM ขยายคำค้น | Semantic + BM25 | Temporal graph | ค้นหาด้วยคีย์ |
| **ความเป็นส่วนตัว** | 100% ในเครื่อง เสมอ | ตัวเลือกคลาวด์ | Self-host | คลาวด์ |
| **ความต้องการ** | 6 | 20+ | 10+ | 0 (แต่ผูกกับคลาวด์) |
| **ออฟไลน์** | ใช่ | ไม่ | ไม่ | ไม่ |
| **แดชบอร์ด** | ในตัว (5 แท็บ) | ไม่มี | ไม่มี | ไม่มี |
| **ราคา** | ฟรี | ฟรี/เสียเงิน | ฟรี/เสียเงิน | รวมกับ API |

---

## ฟีเจอร์

### เครื่องมือหน่วยความจำ 6 อย่าง

| เครื่องมือ | หน้าที่ |
|------|-------------|
| **remember** | บันทึกความรู้พร้อมการสังเกต ความสัมพันธ์ และแท็ก |
| **recall** | ค้นหาอัจฉริยะด้วยการให้คะแนนหลายปัจจัยและการขยายคำค้นด้วย LLM |
| **forget** | เก็บถาวรแบบนุ่มนวล (ไม่ลบจริง) หรือลบการสังเกตเฉพาะ |
| **consolidate** | บีบอัดความจำที่ยืดเยื้อด้วย LLM |
| **export** | แชร์ความจำในรูปแบบ JSON ระหว่างโปรเจกต์หรือสมาชิกทีม |
| **import** | นำเข้าความจำด้วยกลยุทธ์การรวม (ข้าม / เขียนทับ / ต่อท้าย) |

### 3 วิธีการเข้าถึง

| วิธี | คำสั่ง | เหมาะที่สุดสำหรับ |
|--------|---------|----------|
| **CLI** | `memesh` | เทอร์มินัล สคริปต์ CI/CD |
| **HTTP API** | `memesh serve` | Python SDK แดชบอร์ด การเชื่อมต่อ |
| **MCP** | `memesh-mcp` | Claude Code, Claude Desktop, MCP client ทุกตัว |

### 4 Hook จับข้อมูลอัตโนมัติ

| Hook | ทริกเกอร์ | สิ่งที่จับได้ |
|------|---------|-----------------|
| **Session Start** | ทุก session | โหลดความจำสำคัญตามความเกี่ยวข้อง |
| **Post Commit** | หลัง `git commit` | บันทึก commit พร้อมสถิติ diff |
| **Session Summary** | เมื่อ Claude หยุด | ไฟล์ที่แก้ไข ข้อผิดพลาดที่แก้ไข การตัดสินใจที่เกิดขึ้น |
| **Pre-Compact** | ก่อนการบีบอัด | บันทึกความรู้ก่อน context หาย |

### ฟีเจอร์อัจฉริยะ

- **วิวัฒนาการของความรู้** — `forget` คือการเก็บถาวร ไม่ใช่การลบ ความสัมพันธ์ `supersedes` แทนที่การตัดสินใจเก่าด้วยอันใหม่ ประวัติถูกเก็บรักษาไว้
- **การเรียกคืนอัจฉริยะ** — LLM ขยายคำค้นหาของคุณเป็นคำที่เกี่ยวข้อง "login security" พบ "OAuth PKCE" ได้
- **การให้คะแนนหลายปัจจัย** — ผลลัพธ์เรียงตามความเกี่ยวข้อง (35%) + ความใหม่ (25%) + ความถี่ (20%) + ความน่าเชื่อถือ (15%) + ความถูกต้องตามเวลา (5%)
- **การตรวจจับความขัดแย้ง** — เตือนเมื่อความจำขัดแย้งกัน
- **การสลายตัวอัตโนมัติ** — ความจำที่ล้าสมัย (ไม่ได้ใช้ 30+ วัน) จะลดอันดับลงเรื่อย ๆ แต่ไม่ถูกลบ
- **Namespace** — ขอบเขต `personal`, `team`, `global` สำหรับจัดระเบียบและแชร์

---

## สถาปัตยกรรม

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

**Core** ไม่ขึ้นกับ framework — ตรรกะ `remember`/`recall`/`forget` เดียวกันทำงานเหมือนกันทุกประการ ไม่ว่าจะเรียกจากเทอร์มินัล HTTP หรือ MCP

**ความต้องการ**: `better-sqlite3`, `sqlite-vec`, `@modelcontextprotocol/sdk`, `zod`, `express`, `commander`

---

## การพัฒนา

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory
npm install
npm run build
npm test -- --run    # 289 tests
```

การพัฒนาแดชบอร์ด:
```bash
cd dashboard
npm install
npm run dev          # Vite dev server with hot reload
npm run build        # Build to single HTML file
```

---

## ใบอนุญาต

MIT — [PCIRCLE AI](https://pcircle.ai)
