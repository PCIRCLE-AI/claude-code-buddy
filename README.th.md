🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>ชั้นความจำแบบ local สำหรับ Claude Code และ coding agents ที่รองรับ MCP</strong><br />
    ใช้ SQLite ไฟล์เดียว ไม่ต้องมี Docker และไม่ต้องพึ่ง cloud
  </p>
</p>

> README ภาษาไทยฉบับนี้เป็นเวอร์ชันสรุป หากต้องการข้อมูลที่ครบและอัปเดตที่สุด ให้ยึด [English README](README.md) เป็นหลัก

## MeMesh แก้ปัญหาอะไร?

coding agent มักจะลืมบริบทเมื่อจบ session ไปแล้ว พอเริ่มงานรอบใหม่ ก็ต้องอธิบายการตัดสินใจทางสถาปัตยกรรม บั๊กที่เคยแก้ บทเรียนที่เคยได้ และข้อจำกัดของโปรเจกต์ซ้ำอีกครั้ง

**MeMesh ช่วยเก็บความรู้เหล่านี้ไว้ในเครื่องของคุณ ค้นหาได้ ตรวจสอบได้ และดึงกลับมาใช้ต่อได้**

แพ็กเกจ npm นี้คือ MeMesh เวอร์ชัน plugin / package แบบ local ไม่ใช่ผลิตภัณฑ์ workspace บน cloud และไม่ใช่แพลตฟอร์ม enterprise แบบเต็มรูปแบบ

## เริ่มได้ใน 60 วินาที

### 1. ติดตั้ง

```bash
npm install -g @pcircle/memesh
```

### 2. บันทึกการตัดสินใจหนึ่งรายการ

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### 3. เรียกกลับมาใช้ภายหลัง

```bash
memesh recall "login security"
# → ต่อให้ใช้คำค้นคนละแบบ ก็ยังหา "OAuth 2.0 with PKCE" เจอได้
```

เปิด dashboard:

```bash
memesh
```

## เหมาะกับใคร?

- นักพัฒนาที่ใช้ Claude Code และอยากเก็บบริบทของโปรเจกต์ข้าม session
- ผู้ใช้ระดับสูงที่อยากใช้ความจำ local ชุดเดียวร่วมกันระหว่าง MCP coding agents
- ทีม AI-native ขนาดเล็กที่อยากแชร์ความรู้ของโปรเจกต์ผ่าน export / import
- นักพัฒนา agent ที่อยากเชื่อม memory local ผ่าน CLI, HTTP หรือ MCP

## ทำไมต้อง MeMesh?

- local-first: ข้อมูลอยู่ในไฟล์ SQLite ของคุณเอง
- ติดตั้งง่าย: `npm install -g` แล้วเริ่มใช้ได้เลย
- เชื่อมต่อได้ตรงไปตรงมา: รองรับ CLI, HTTP และ MCP
- เหมาะกับ Claude Code: มี hooks ช่วยดึงบริบทที่เกี่ยวข้องเข้ามาใน workflow
- ตรวจสอบและจัดการได้: มี dashboard ให้ดูและจัดระเบียบ memory
- มีขอบเขตความเชื่อถือที่ปลอดภัยกว่า: memory ที่ import เข้ามายังค้นหาได้ แต่จะไม่ถูก inject เข้า Claude hooks โดยอัตโนมัติ จนกว่าจะมีการตรวจทานหรือบันทึกใหม่ในเครื่อง

## ใน Claude Code จะทำอะไรให้อัตโนมัติ?

ตอนนี้ MeMesh ช่วยใน 5 ช่วงหลัก:

- ตอนเริ่ม session จะโหลด memory ที่เกี่ยวข้องและบทเรียนที่เคยมี
- ก่อนแก้ไฟล์ จะเรียก memory ที่เกี่ยวข้องกับไฟล์หรือโปรเจกต์
- หลัง `git commit` จะบันทึกสิ่งที่เปลี่ยนไป
- ตอนจบ session จะสรุปการแก้ไข ข้อผิดพลาด และ lessons learned
- ก่อน compact context จะเก็บข้อมูลสำคัญกลับเข้า memory local

## Dashboard มีอะไรบ้าง?

Dashboard ตอนนี้มี 7 แท็บ และรองรับ 11 ภาษา:

- Search: ค้นหา memory
- Browse: ดู memory ทั้งหมด
- Analytics: ดูสุขภาพและแนวโน้ม
- Graph: ดูความสัมพันธ์ของความรู้
- Lessons: ทบทวนบทเรียนที่ผ่านมา
- Manage: archive และ restore
- Settings: ตั้งค่า LLM provider และภาษา

## Smart Mode คืออะไร?

MeMesh ใช้งานแบบ offline ได้ตั้งแต่ต้น หากคุณใส่ LLM API key เพิ่ม ก็จะเปิดความสามารถเสริม เช่น

- query expansion
- การสกัดข้อมูลอัตโนมัติที่ดีขึ้น
- การจัดระเบียบและบีบอัดข้อมูลที่ฉลาดขึ้น

ถึงไม่มี API key ก็ยังใช้ฟังก์ชันหลักได้ตามปกติ

## อ่านต่อ

- ฟีเจอร์ทั้งหมด การเปรียบเทียบ API และข้อมูล release: [English README](README.md)
- คู่มือการเชื่อมต่อแพลตฟอร์ม: [docs/platforms/README.md](docs/platforms/README.md)
- เอกสารอ้างอิง API: [docs/api/API_REFERENCE.md](docs/api/API_REFERENCE.md)

## การพัฒนาและการตรวจสอบ

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory
npm install
npm run build
npm test
```
