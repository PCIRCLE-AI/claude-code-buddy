<div align="center">

# 🧠 MeMesh Plugin

### Plugin produktivitas untuk Claude Code

Memori, analisis tugas cerdas, dan otomasi alur kerja — semua dalam satu plugin.

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io)

[Instalasi](#instalasi) • [Penggunaan](#penggunaan) • [Pemecahan Masalah](#pemecahan-masalah)

[English](README.md) • [繁體中文](README.zh-TW.md) • [简体中文](README.zh-CN.md) • [日本語](README.ja.md) • [한국어](README.ko.md) • [Français](README.fr.md) • [Deutsch](README.de.md) • [Español](README.es.md) • [Tiếng Việt](README.vi.md) • [ภาษาไทย](README.th.md) • **Bahasa Indonesia**

</div>

---

## Mengapa Proyek Ini Ada

Proyek ini dimulai karena saya ingin membantu lebih banyak orang — terutama yang baru belajar coding — untuk mendapatkan manfaat maksimal dari Claude Code untuk vibe coding. Satu hal yang saya perhatikan: ketika proyek semakin besar, sulit untuk melacak semua keputusan yang dibuat antar sesi. Jadi saya membuat plugin (bersama Claude Code, tentu saja) yang mengingat untuk Anda.

> **Catatan**: Proyek ini awalnya bernama "Claude Code Buddy" dan telah diganti nama menjadi MeMesh Plugin untuk menghindari masalah merek dagang.

## Apa yang Bisa Dilakukan?

MeMesh Plugin membuat Claude Code lebih cerdas dan produktif. Bukan hanya memori — ini adalah toolkit lengkap:

**Memori proyek yang bisa dicari** — Otomatis menyimpan keputusan, pola, dan pelajaran. Cari berdasarkan makna, bukan hanya kata kunci. Tanya "apa yang kita putuskan tentang auth?" dan langsung dapat jawaban.

**Analisis tugas cerdas** — Saat Anda ketik `buddy-do "tambahkan auth"`, MeMesh menganalisis tugas, mengambil konteks relevan dari pekerjaan sebelumnya, dan memberikan rencana lengkap sebelum eksekusi.

**Otomasi alur kerja** — MeMesh bekerja otomatis di latar belakang:
- Menampilkan ringkasan sesi terakhir saat memulai
- Melacak file yang diubah dan diuji
- Mengingatkan code review sebelum commit
- Merutekan tugas ke model yang optimal

**Belajar dari kesalahan** — Catat error dan perbaikannya untuk membangun basis pengetahuan dan menghindari kesalahan berulang.

**Apa bedanya dengan memori bawaan Claude?**

Claude Code sudah punya auto memory dan CLAUDE.md — bagus untuk pengaturan umum. MeMesh menambahkan **alat khusus proyek**: memori yang bisa dicari berdasarkan makna, analisis tugas dengan konteks sebelumnya, dan alur kerja otomatis yang membuat setiap sesi lebih produktif.

Bayangkan seperti ini:
- **CLAUDE.md** = buku panduan Anda untuk Claude
- **MeMesh** = buku catatan yang bisa dicari + asisten cerdas yang berkembang bersama proyek

---

## Instalasi

**Yang dibutuhkan**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) dan Node.js 20+

```bash
npm install -g @pcircle/memesh
```

Restart Claude Code. Selesai.

**Cek apakah berhasil** — ketik ini di Claude Code:

```
buddy-help
```

Anda akan melihat daftar perintah.

<details>
<summary>Instalasi dari source code (untuk kontributor)</summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

</details>

---

## Penggunaan

MeMesh menambahkan 3 perintah ke Claude Code:

| Perintah | Fungsi |
|----------|--------|
| `buddy-do "tugas"` | Jalankan tugas dengan konteks memori |
| `buddy-remember "topik"` | Cari keputusan dan konteks sebelumnya |
| `buddy-help` | Tampilkan perintah yang tersedia |

**Contoh:**

```bash
buddy-do "jelaskan codebase ini"
buddy-do "tambahkan autentikasi pengguna"
buddy-remember "keputusan desain API"
buddy-remember "kenapa pilih PostgreSQL"
```

Semua data disimpan secara lokal di komputer Anda. Keputusan disimpan selama 90 hari, catatan sesi selama 30 hari.

---

## Platform yang Didukung

| Platform | Status |
|----------|--------|
| **macOS** | ✅ Berjalan |
| **Linux** | ✅ Berjalan |
| **Windows** | ✅ Berjalan (WSL2 direkomendasikan) |

**Kompatibel dengan:**
- Claude Code CLI (terminal)
- Claude Code VS Code Extension
- Cursor (via MCP)
- Editor lain yang kompatibel MCP

**Claude Desktop (Cowork)**: Perintah dasar berfungsi, tetapi fitur memori membutuhkan versi CLI. Lihat [detail Cowork](docs/COWORK_SUPPORT.md).

---

## Pemecahan Masalah

**MeMesh tidak muncul?**

```bash
# Periksa instalasi
npm list -g @pcircle/memesh

# Periksa versi Node.js (butuh 20+)
node --version

# Jalankan ulang setup
memesh setup
```

Lalu restart Claude Code sepenuhnya.

Bantuan lainnya: [Panduan Pemecahan Masalah](docs/TROUBLESHOOTING.md)

---

## Pelajari Lebih Lanjut

- **[Memulai](docs/GETTING_STARTED.md)** — Panduan setup langkah demi langkah
- **[Panduan Pengguna](docs/USER_GUIDE.md)** — Panduan lengkap dengan contoh
- **[Perintah](docs/COMMANDS.md)** — Semua perintah yang tersedia
- **[Arsitektur](docs/ARCHITECTURE.md)** — Cara kerjanya di balik layar
- **[Kontribusi](CONTRIBUTING.md)** — Mau bantu? Mulai di sini
- **[Panduan Pengembangan](docs/DEVELOPMENT.md)** — Untuk kontributor

---

## Lisensi

MIT — Lihat [LICENSE](LICENSE)

---

<div align="center">

Ada masalah? [Buka Issue](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new) — kami merespons cepat.

[Laporkan Bug](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=bug&template=bug_report.yml) • [Minta Fitur](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions)

</div>
