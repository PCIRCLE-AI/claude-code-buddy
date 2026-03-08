<div align="center">

<img src="https://img.shields.io/badge/%F0%9F%A7%A0-MeMesh-blueviolet?style=for-the-badge" alt="MeMesh" />

# MeMesh

### เซสชันเขียนโค้ดกับ AI ของคุณสมควรมีหน่วยความจำ

MeMesh มอบหน่วยความจำถาวรที่ค้นหาได้ให้ Claude Code — ทำให้ทุกเซสชันต่อยอดจากเซสชันก่อนหน้า

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@pcircle/memesh)
[![Downloads](https://img.shields.io/npm/dm/@pcircle/memesh?style=flat-square&color=blue)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple?style=flat-square)](https://modelcontextprotocol.io)

```bash
npm install -g @pcircle/memesh
```

[เริ่มต้นใช้งาน](#เริ่มต้นใช้งาน) · [วิธีการทำงาน](#วิธีการทำงาน) · [คำสั่ง](#คำสั่ง) · [เอกสาร](docs/USER_GUIDE.md)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Tiếng Việt](README.vi.md) · **ภาษาไทย** · [Bahasa Indonesia](README.id.md)

</div>

> **หมายเหตุ**: โปรเจกต์นี้เดิมชื่อ "Claude Code Buddy" และถูกเปลี่ยนชื่อเป็น MeMesh Plugin เพื่อหลีกเลี่ยงปัญหาเครื่องหมายการค้า

---

## ปัญหา

คุณกำลังทำงานโปรเจกต์กับ Claude Code อย่างเข้มข้น คุณตัดสินใจเรื่องสำคัญไปเมื่อสามเซสชันก่อน — จะใช้ไลบรารี auth ตัวไหน ทำไมถึงเลือกสคีมาฐานข้อมูลแบบนั้น ควรใช้รูปแบบอะไร แต่ Claude จำไม่ได้ คุณต้องพูดซ้ำ เสียบริบท เสียเวลา

**MeMesh แก้ปัญหานี้** โดยมอบหน่วยความจำถาวรที่ค้นหาได้ซึ่งเติบโตไปพร้อมกับโปรเจกต์ของคุณ

---

## วิธีการทำงาน

<table>
<tr>
<td width="50%">

### ก่อนใช้ MeMesh
```
Session 1: "Use JWT for auth"
Session 2: "Why did we pick JWT again?"
Session 3: "Wait, what auth library are we using?"
```
คุณต้องทวนการตัดสินใจซ้ำ Claude ลืมบริบท ความคืบหน้าหยุดชะงัก

</td>
<td width="50%">

### หลังใช้ MeMesh
```
Session 1: "Use JWT for auth" → saved
Session 2: buddy-remember "auth" → instant recall
Session 3: Context auto-loaded on start
```
ทุกเซสชันเริ่มต่อจากจุดที่คุณหยุดไว้

</td>
</tr>
</table>

---

## สิ่งที่คุณจะได้รับ

**หน่วยความจำโปรเจกต์ที่ค้นหาได้** — ถามว่า "เราตัดสินใจเรื่อง auth ยังไง?" แล้วได้คำตอบทันทีที่จับคู่ตามความหมาย ไม่ใช่การค้นหาด้วยคีย์เวิร์ด — แต่เป็นการค้นหาด้วย*ความหมาย* ขับเคลื่อนด้วย ONNX embeddings บนเครื่องของคุณ

**การวิเคราะห์งานอัจฉริยะ** — `buddy-do "add user auth"` ไม่ได้แค่รันคำสั่ง มันดึงบริบทที่เกี่ยวข้องจากเซสชันก่อนหน้า ตรวจสอบรูปแบบที่คุณกำหนดไว้ และสร้างแผนที่สมบูรณ์ก่อนเขียนโค้ดแม้แต่บรรทัดเดียว

**การเรียกคืนเชิงรุก** — MeMesh แสดงความทรงจำที่เกี่ยวข้องโดยอัตโนมัติเมื่อคุณเริ่มเซสชัน เจอเทสต์ล้มเหลว หรือพบข้อผิดพลาด ไม่ต้องค้นหาเอง

**ระบบอัตโนมัติของเวิร์กโฟลว์** — สรุปเซสชันเมื่อเริ่มงาน ติดตามการเปลี่ยนแปลงไฟล์ เตือนให้รีวิวโค้ดก่อน commit ทั้งหมดทำงานเงียบๆ ในเบื้องหลัง

**เรียนรู้จากข้อผิดพลาด** — บันทึกข้อผิดพลาดและการแก้ไขเพื่อสร้างฐานความรู้ ข้อผิดพลาดเดิมจะไม่เกิดขึ้นซ้ำ

---

## เริ่มต้นใช้งาน

**สิ่งที่ต้องมี**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) + Node.js 20+

```bash
npm install -g @pcircle/memesh
```

รีสตาร์ท Claude Code เท่านั้นเอง

**ตรวจสอบ** — พิมพ์ใน Claude Code:

```
buddy-help
```

คุณจะเห็นรายการคำสั่งที่ใช้ได้

<details>
<summary><strong>ติดตั้งจากซอร์สโค้ด</strong> (สำหรับผู้ร่วมพัฒนา)</summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

</details>

---

## คำสั่ง

| คำสั่ง | ทำอะไร |
|---------|-------------|
| `buddy-do "task"` | รันงานพร้อมบริบทหน่วยความจำเต็มรูปแบบ |
| `buddy-remember "topic"` | ค้นหาการตัดสินใจและบริบทที่ผ่านมา |
| `buddy-help` | แสดงคำสั่งที่ใช้ได้ |

**ตัวอย่างจริง:**

```bash
# ทำความเข้าใจ codebase ที่ไม่คุ้นเคย
buddy-do "explain this codebase"

# สร้างฟีเจอร์พร้อมบริบทจากงานที่ผ่านมา
buddy-do "add user authentication"

# เรียกดูเหตุผลของการตัดสินใจ
buddy-remember "API design decisions"
buddy-remember "why we chose PostgreSQL"
```

ข้อมูลทั้งหมดอยู่บนเครื่องของคุณ พร้อมการเก็บรักษาอัตโนมัติ 90 วัน

---

## MeMesh ต่างจาก CLAUDE.md อย่างไร?

| | CLAUDE.md | MeMesh |
|---|-----------|--------|
| **วัตถุประสงค์** | คำสั่งคงที่สำหรับ Claude | หน่วยความจำที่มีชีวิตซึ่งเติบโตไปกับโปรเจกต์ |
| **การค้นหา** | ค้นหาข้อความด้วยตนเอง | ค้นหาเชิงความหมายตามความหมาย |
| **การอัปเดต** | คุณแก้ไขเอง | บันทึกการตัดสินใจอัตโนมัติขณะทำงาน |
| **การเรียกคืน** | โหลดทุกครั้ง (อาจยาวมาก) | แสดงบริบทที่เกี่ยวข้องตามต้องการ |
| **ขอบเขต** | การตั้งค่าทั่วไป | กราฟความรู้เฉพาะโปรเจกต์ |

**ทั้งสองทำงานร่วมกัน** CLAUDE.md บอก Claude ว่าต้องทำงาน*อย่างไร* MeMesh จำว่าคุณ*สร้างอะไร*ไปบ้าง

---

## รองรับแพลตฟอร์ม

| แพลตฟอร์ม | สถานะ |
|----------|--------|
| macOS | ✅ |
| Linux | ✅ |
| Windows | ✅ (แนะนำ WSL2) |

**ใช้ร่วมกับ:** Claude Code CLI · VS Code Extension · Cursor (ผ่าน MCP) · เอดิเตอร์ใดก็ได้ที่รองรับ MCP

---

## สถาปัตยกรรม

MeMesh ทำงานเป็นปลั๊กอิน Claude Code บนเครื่อง พร้อมคอมโพเนนต์ MCP ในตัว:

- **Knowledge Graph** — ที่เก็บ entity บน SQLite พร้อมการค้นหาข้อความเต็มรูปแบบ FTS5
- **Vector Embeddings** — ONNX runtime สำหรับความคล้ายคลึงเชิงความหมาย (ทำงานบนเครื่อง 100%)
- **Content Dedup** — แฮช SHA-256 ข้ามการคำนวณ embedding ที่ซ้ำซ้อน
- **Batch Processing** — การดำเนินการจำนวนมากอย่างมีประสิทธิภาพสำหรับฐานความรู้ขนาดใหญ่
- **Hook System** — เรียกคืนเชิงรุกเมื่อเริ่มเซสชัน เทสต์ล้มเหลว และเกิดข้อผิดพลาด

ทุกอย่างทำงานบนเครื่อง ไม่ใช้คลาวด์ ไม่เรียก API ข้อมูลของคุณไม่ออกจากเครื่องเด็ดขาด

---

## เอกสาร

| เอกสาร | คำอธิบาย |
|-----|-------------|
| [เริ่มต้นใช้งาน](docs/GETTING_STARTED.md) | คู่มือการตั้งค่าทีละขั้นตอน |
| [คู่มือผู้ใช้](docs/USER_GUIDE.md) | คู่มือการใช้งานฉบับเต็มพร้อมตัวอย่าง |
| [คำสั่ง](docs/COMMANDS.md) | รายการคำสั่งทั้งหมด |
| [สถาปัตยกรรม](docs/ARCHITECTURE.md) | รายละเอียดเชิงเทคนิคเชิงลึก |
| [ร่วมพัฒนา](CONTRIBUTING.md) | แนวทางการร่วมพัฒนา |
| [การพัฒนา](docs/DEVELOPMENT.md) | การตั้งค่าสำหรับผู้ร่วมพัฒนา |

---

## ร่วมพัฒนา

เรายินดีต้อนรับการร่วมพัฒนา! ดู [CONTRIBUTING.md](CONTRIBUTING.md) เพื่อเริ่มต้น

---

## สัญญาอนุญาต

MIT — ดู [LICENSE](LICENSE)

---

<div align="center">

**สร้างด้วย Claude Code เพื่อ Claude Code**

[รายงานบัก](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=bug&template=bug_report.yml) · [ขอฟีเจอร์](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions) · [ขอความช่วยเหลือ](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new)

</div>
