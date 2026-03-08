<div align="center">

# 🧠 MeMesh Plugin

### ปลั๊กอินเพิ่มประสิทธิภาพสำหรับ Claude Code

หน่วยความจำ การวิเคราะห์งานอัจฉริยะ และระบบอัตโนมัติ — ทั้งหมดในปลั๊กอินเดียว

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io)

[ติดตั้ง](#ติดตั้ง) • [วิธีใช้](#วิธีใช้) • [แก้ไขปัญหา](#แก้ไขปัญหา)

[English](README.md) • [繁體中文](README.zh-TW.md) • [简体中文](README.zh-CN.md) • [日本語](README.ja.md) • [한국어](README.ko.md) • [Français](README.fr.md) • [Deutsch](README.de.md) • [Español](README.es.md) • [Tiếng Việt](README.vi.md) • **ภาษาไทย** • [Bahasa Indonesia](README.id.md)

</div>

---

## ทำไมถึงสร้างโปรเจกต์นี้

โปรเจกต์นี้เริ่มต้นเพราะผมอยากช่วยให้คนมากขึ้น — โดยเฉพาะคนที่เพิ่งเริ่มเขียนโค้ด — ได้ใช้ประโยชน์จาก Claude Code สำหรับ vibe coding ให้เต็มที่ สิ่งหนึ่งที่ผมสังเกตคือ: เมื่อโปรเจกต์ใหญ่ขึ้น มันยากที่จะติดตามการตัดสินใจทั้งหมดที่ทำไปในแต่ละเซสชัน ผมเลยสร้างปลั๊กอิน (ร่วมกับ Claude Code แน่นอน) ที่จดจำให้คุณ

> **หมายเหตุ**: โปรเจกต์นี้เดิมชื่อ "Claude Code Buddy" และถูกเปลี่ยนชื่อเป็น MeMesh Plugin เพื่อหลีกเลี่ยงปัญหาเครื่องหมายการค้า

## มันทำอะไรได้?

MeMesh Plugin ทำให้ Claude Code ฉลาดขึ้นและมีประสิทธิภาพมากขึ้น ไม่ใช่แค่หน่วยความจำ — เป็นชุดเครื่องมือครบครัน:

**หน่วยความจำโปรเจกต์ที่ค้นหาได้** — บันทึกการตัดสินใจ รูปแบบ และบทเรียนที่ได้เรียนรู้โดยอัตโนมัติ ค้นหาด้วยความหมาย ไม่ใช่แค่คีย์เวิร์ด ถามว่า "เราตัดสินใจเรื่อง auth ยังไง?" แล้วได้คำตอบทันที

**วิเคราะห์งานอัจฉริยะ** — เมื่อคุณพิมพ์ `buddy-do "เพิ่มระบบ auth"` MeMesh จะวิเคราะห์งาน ดึงบริบทที่เกี่ยวข้องจากงานที่ผ่านมา และให้แผนที่สมบูรณ์ก่อนลงมือทำ

**ระบบอัตโนมัติ** — MeMesh ทำงานเบื้องหลังให้คุณ:
- แสดงสรุปการทำงานครั้งก่อนเมื่อเริ่มเซสชัน
- ติดตามไฟล์ที่แก้ไขและทดสอบ
- เตือนให้รีวิวโค้ดก่อน commit
- กำหนดเส้นทางงานไปยังโมเดลที่เหมาะสม

**เรียนรู้จากข้อผิดพลาด** — บันทึกข้อผิดพลาดและการแก้ไขเพื่อสร้างฐานความรู้และไม่ทำผิดซ้ำ

**ต่างจากหน่วยความจำในตัวของ Claude ยังไง?**

Claude Code มี auto memory และ CLAUDE.md อยู่แล้ว — เหมาะสำหรับการตั้งค่าทั่วไป MeMesh เพิ่ม**เครื่องมือเฉพาะโปรเจกต์**: หน่วยความจำที่ค้นหาด้วยความหมาย การวิเคราะห์งานพร้อมบริบทที่ผ่านมา และเวิร์กโฟลว์อัตโนมัติที่ทำให้ทุกเซสชันมีประสิทธิภาพมากขึ้น

ลองคิดแบบนี้:
- **CLAUDE.md** = คู่มือการใช้งานสำหรับ Claude
- **MeMesh** = สมุดบันทึกที่ค้นหาได้ + ผู้ช่วยอัจฉริยะที่เติบโตไปกับโปรเจกต์ของคุณ

---

## ติดตั้ง

**สิ่งที่ต้องมี**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) และ Node.js 20+

```bash
npm install -g @pcircle/memesh
```

รีสตาร์ท Claude Code เสร็จแล้ว

**ตรวจสอบการติดตั้ง** — พิมพ์ใน Claude Code:

```
buddy-help
```

ถ้าเห็นรายการคำสั่ง แสดงว่าติดตั้งสำเร็จ

<details>
<summary>ติดตั้งจากซอร์สโค้ด (สำหรับผู้ร่วมพัฒนา)</summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

</details>

---

## วิธีใช้

MeMesh เพิ่ม 3 คำสั่งใน Claude Code:

| คำสั่ง | ทำอะไร |
|--------|--------|
| `buddy-do "งาน"` | รันงานพร้อมบริบทหน่วยความจำ |
| `buddy-remember "หัวข้อ"` | ค้นหาการตัดสินใจและบริบทที่ผ่านมา |
| `buddy-help` | แสดงคำสั่งที่ใช้ได้ |

**ตัวอย่าง:**

```bash
buddy-do "อธิบาย codebase นี้"
buddy-do "เพิ่มระบบยืนยันตัวตนผู้ใช้"
buddy-remember "การตัดสินใจออกแบบ API"
buddy-remember "ทำไมถึงเลือก PostgreSQL"
```

ข้อมูลทั้งหมดเก็บไว้ในเครื่องของคุณ การตัดสินใจเก็บไว้ 90 วัน บันทึกเซสชันเก็บไว้ 30 วัน

---

## รองรับแพลตฟอร์ม

| แพลตฟอร์ม | สถานะ |
|-----------|--------|
| **macOS** | ✅ ใช้ได้ |
| **Linux** | ✅ ใช้ได้ |
| **Windows** | ✅ ใช้ได้ (แนะนำ WSL2) |

**ใช้ร่วมกับ:**
- Claude Code CLI (เทอร์มินัล)
- Claude Code VS Code Extension
- Cursor (ผ่าน MCP)
- เอดิเตอร์อื่นที่รองรับ MCP

**Claude Desktop (Cowork)**: คำสั่งพื้นฐานใช้ได้ แต่ฟีเจอร์หน่วยความจำต้องใช้เวอร์ชัน CLI ดู[รายละเอียด Cowork](docs/COWORK_SUPPORT.md)

---

## แก้ไขปัญหา

**MeMesh ไม่แสดง?**

```bash
# ตรวจสอบการติดตั้ง
npm list -g @pcircle/memesh

# ตรวจสอบเวอร์ชัน Node.js (ต้อง 20+)
node --version

# รันเซ็ตอัพใหม่
memesh setup
```

จากนั้นรีสตาร์ท Claude Code ใหม่ทั้งหมด

ข้อมูลเพิ่มเติม: [คู่มือแก้ไขปัญหา](docs/TROUBLESHOOTING.md)

---

## เรียนรู้เพิ่มเติม

- **[เริ่มต้นใช้งาน](docs/GETTING_STARTED.md)** — การตั้งค่าทีละขั้นตอน
- **[คู่มือผู้ใช้](docs/USER_GUIDE.md)** — คู่มือฉบับเต็มพร้อมตัวอย่าง
- **[คำสั่ง](docs/COMMANDS.md)** — คำสั่งทั้งหมดที่ใช้ได้
- **[สถาปัตยกรรม](docs/ARCHITECTURE.md)** — วิธีทำงานเบื้องหลัง
- **[ร่วมพัฒนา](CONTRIBUTING.md)** — อยากช่วย? เริ่มที่นี่
- **[คู่มือพัฒนา](docs/DEVELOPMENT.md)** — สำหรับผู้ร่วมพัฒนา

---

## สัญญาอนุญาต

MIT — ดู [LICENSE](LICENSE)

---

<div align="center">

มีปัญหา? [เปิด Issue](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new) — เราตอบเร็ว

[รายงานบัก](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=bug&template=bug_report.yml) • [ขอฟีเจอร์](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions)

</div>
