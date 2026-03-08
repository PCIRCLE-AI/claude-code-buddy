<div align="center">

<img src="https://img.shields.io/badge/%F0%9F%A7%A0-MeMesh-blueviolet?style=for-the-badge" alt="MeMesh" />

# MeMesh Plugin

### Sesi coding AI Anda layak memiliki memori.

MeMesh Plugin memberikan Claude Code memori yang persisten dan dapat dicari — sehingga setiap sesi melanjutkan dari yang terakhir.

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@pcircle/memesh)
[![Downloads](https://img.shields.io/npm/dm/@pcircle/memesh?style=flat-square&color=blue)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple?style=flat-square)](https://modelcontextprotocol.io)

```bash
npm install -g @pcircle/memesh
```

[Mulai Sekarang](#mulai-sekarang) · [Cara Kerja](#cara-kerja) · [Perintah](#perintah) · [Dokumentasi](docs/USER_GUIDE.md)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Tiếng Việt](README.vi.md) · [ภาษาไทย](README.th.md) · **Bahasa Indonesia**

</div>

> **Catatan**: Proyek ini awalnya bernama "Claude Code Buddy" dan telah diganti nama menjadi MeMesh Plugin untuk menghindari masalah merek dagang.

---

## Masalahnya

Anda sedang mengerjakan proyek dengan Claude Code. Anda membuat keputusan penting tiga sesi yang lalu — pustaka auth mana yang dipilih, mengapa memilih skema database itu, pola apa yang harus diikuti. Tapi Claude tidak ingat. Anda mengulang penjelasan. Anda kehilangan konteks. Anda membuang waktu.

**MeMesh memperbaiki ini.** MeMesh memberikan Claude memori yang persisten dan dapat dicari yang berkembang bersama proyek Anda.

---

## Cara Kerja

<table>
<tr>
<td width="50%">

### Sebelum MeMesh
```
Sesi 1: "Gunakan JWT untuk auth"
Sesi 2: "Kenapa kita pilih JWT tadi?"
Sesi 3: "Tunggu, pustaka auth apa yang kita pakai?"
```
Anda mengulang keputusan. Claude lupa konteks. Progres terhenti.

</td>
<td width="50%">

### Setelah MeMesh
```
Sesi 1: "Gunakan JWT untuk auth" → tersimpan
Sesi 2: buddy-remember "auth" → langsung teringat
Sesi 3: Konteks dimuat otomatis saat mulai
```
Setiap sesi melanjutkan dari yang terakhir.

</td>
</tr>
</table>

---

## Yang Anda Dapatkan

**Memori Proyek yang Dapat Dicari** — Tanya "apa yang kita putuskan tentang auth?" dan dapatkan jawaban instan yang dicocokkan secara semantik. Bukan pencarian kata kunci — pencarian berdasarkan *makna*, didukung oleh embedding ONNX lokal.

**Analisis Tugas Cerdas** — `buddy-do "tambahkan auth pengguna"` tidak langsung mengeksekusi. Ia mengambil konteks relevan dari sesi sebelumnya, memeriksa pola yang sudah Anda tetapkan, dan menyusun rencana yang diperkaya sebelum menulis satu baris kode pun.

**Pemanggilan Proaktif** — MeMesh secara otomatis memunculkan memori yang relevan saat Anda memulai sesi, menghadapi kegagalan pengujian, atau menemui error. Tidak perlu pencarian manual.

**Otomasi Alur Kerja** — Ringkasan sesi saat startup. Pelacakan perubahan file. Pengingat code review sebelum commit. Semuanya berjalan diam-diam di latar belakang.

**Belajar dari Kesalahan** — Catat error dan perbaikannya untuk membangun basis pengetahuan. Kesalahan yang sama tidak terjadi dua kali.

---

## Mulai Sekarang

**Prasyarat**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) + Node.js 20+

```bash
npm install -g @pcircle/memesh
```

Restart Claude Code. Selesai.

**Verifikasi** — ketik di Claude Code:

```
buddy-help
```

Anda akan melihat daftar perintah yang tersedia.

<details>
<summary><strong>Instalasi dari source</strong> (kontributor)</summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

</details>

---

## Perintah

| Perintah | Fungsi |
|----------|--------|
| `buddy-do "tugas"` | Jalankan tugas dengan konteks memori penuh |
| `buddy-remember "topik"` | Cari keputusan dan konteks sebelumnya |
| `buddy-help` | Tampilkan perintah yang tersedia |

**Contoh nyata:**

```bash
# Pahami codebase yang baru Anda temui
buddy-do "explain this codebase"

# Bangun fitur dengan konteks dari pekerjaan sebelumnya
buddy-do "add user authentication"

# Ingat kembali mengapa keputusan dibuat
buddy-remember "API design decisions"
buddy-remember "why we chose PostgreSQL"
```

Semua data tetap di mesin Anda dengan retensi otomatis 90 hari.

---

## Apa Bedanya dengan CLAUDE.md?

| | CLAUDE.md | MeMesh |
|---|-----------|--------|
| **Tujuan** | Instruksi statis untuk Claude | Memori hidup yang berkembang bersama proyek |
| **Pencarian** | Pencarian teks manual | Pencarian semantik berdasarkan makna |
| **Pembaruan** | Anda edit secara manual | Otomatis menangkap keputusan saat Anda bekerja |
| **Pemanggilan** | Selalu dimuat (bisa jadi panjang) | Memunculkan konteks relevan sesuai kebutuhan |
| **Cakupan** | Preferensi umum | Grafik pengetahuan khusus proyek |

**Keduanya bekerja bersama.** CLAUDE.md memberi tahu Claude *cara* bekerja. MeMesh mengingat *apa* yang telah Anda bangun.

---

## Dukungan Platform

| Platform | Status |
|----------|--------|
| macOS | ✅ |
| Linux | ✅ |
| Windows | ✅ (WSL2 direkomendasikan) |

**Kompatibel dengan:** Claude Code CLI · VS Code Extension · Cursor (via MCP) · Editor mana pun yang kompatibel MCP

---

## Arsitektur

MeMesh berjalan sebagai plugin Claude Code secara lokal, dengan komponen MCP terintegrasi:

- **Knowledge Graph** — Penyimpanan entitas berbasis SQLite dengan pencarian teks lengkap FTS5
- **Vector Embeddings** — Runtime ONNX untuk kesamaan semantik (berjalan 100% lokal)
- **Content Dedup** — Hashing SHA-256 melewati komputasi embedding yang redundan
- **Batch Processing** — Operasi massal yang efisien untuk basis pengetahuan besar
- **Hook System** — Pemanggilan proaktif saat memulai sesi, kegagalan pengujian, dan error

Semuanya berjalan secara lokal. Tanpa cloud. Tanpa panggilan API. Data Anda tidak pernah meninggalkan mesin Anda.

---

## Dokumentasi

| Dokumen | Deskripsi |
|---------|-----------|
| [Memulai](docs/GETTING_STARTED.md) | Panduan setup langkah demi langkah |
| [Panduan Pengguna](docs/USER_GUIDE.md) | Panduan penggunaan lengkap dengan contoh |
| [Perintah](docs/COMMANDS.md) | Referensi perintah lengkap |
| [Arsitektur](docs/ARCHITECTURE.md) | Penjelasan teknis mendalam |
| [Kontribusi](CONTRIBUTING.md) | Panduan kontribusi |
| [Pengembangan](docs/DEVELOPMENT.md) | Setup pengembangan untuk kontributor |

---

## Kontribusi

Kami menyambut kontribusi! Lihat [CONTRIBUTING.md](CONTRIBUTING.md) untuk memulai.

---

## Lisensi

MIT — Lihat [LICENSE](LICENSE)

---

<div align="center">

**Dibangun dengan Claude Code, untuk Claude Code.**

[Laporkan Bug](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=bug&template=bug_report.yml) · [Minta Fitur](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions) · [Dapatkan Bantuan](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new)

</div>
