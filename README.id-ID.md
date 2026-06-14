<div align="center">
  <img src="./images/previews/banner-doktainer-feature.png" alt="Maskot Doktainer (DOKTA)" width="780"/>
  
# Doktainer - Kelola Docker, Sederhanakan Semuanya

![GitHub forks](https://img.shields.io/github/forks/DoktainerApp/doktainer)
![GitHub forks](https://img.shields.io/github/stars/DoktainerApp/doktainer)<br>
[![Discord](https://img.shields.io/discord/1497461926609948733?color=5865f2&label=Discord&style=flat-square)](https://discord.gg/3HF85Cd6fp)
[![Docker Pulls](https://img.shields.io/docker/pulls/doktainer/doktainer.svg?logo=docker&label=Docker%20pulls)](https://hub.docker.com/r/doktainer/doktainer)<br>
[![GHCR](https://img.shields.io/badge/GHCR-doktainer%2Fdoktainer-blue?logo=github)](https://github.com/DoktainerApp/doktainer/pkgs/container/doktainer)
[![License](https://img.shields.io/github/license/DoktainerApp/doktainer.svg)](https://github.com/DoktainerApp/doktainer/blob/main/LICENSE)

  </div>

Doktainer adalah platform open-source dan self-hosted untuk mengelola server, aplikasi, container, domain, SSL, backup, dan operasi deployment dari satu panel web.

Proyek ini menggunakan arsitektur monolith modular modern:

- frontend dengan Next.js App Router
- API backend dengan Fastify
- database PostgreSQL melalui Prisma ORM
- deployment lokal dan server menggunakan Docker Compose

Doktainer ditujukan untuk tim atau individu yang ingin memiliki panel deployment sendiri tanpa bergantung pada vendor cloud tertentu, sekaligus tetap memegang kendali penuh atas server dan data mereka.

## Fitur Utama

- Manajemen server dan akses pengguna dalam satu panel.
- Manajemen aplikasi dan container berbasis Docker.
- Dukungan untuk domain, SSL, jaringan, keamanan, log, metrik, dan akses terminal.
- Organisasi, akses berbasis peran, API key, dan konfigurasi pengaturan pengguna.
- Integrasi Git provider, tujuan penyimpanan, notifikasi, dan backup.
- UI panel modern dengan Next.js dan API backend yang berjalan terpisah saat runtime.
- Dukungan untuk pengembangan lokal dan deployment Docker ke VPS atau server online.

## Tech Stack

- Next.js 16
- React 19
- Fastify 5
- Prisma 6
- PostgreSQL 16
- TypeScript 5
- Docker Compose

## Struktur Proyek

- `src/app` untuk route dan halaman frontend berbasis Next.js App Router.
- `src/components` untuk komponen UI bersama.
- `src/lib` untuk utilitas frontend dan helper runtime bersama.
- `src/server` untuk API backend Fastify, service, middleware, dan library server.
- `prisma` untuk skema database dan migrasi Prisma.
- `scripts` untuk script helper internal seperti pengecekan Prisma client.
- `tests` untuk test yang relevan dengan codebase ini.

## Kebutuhan Sistem

### Minimum untuk pengembangan

- Node.js 22 atau versi yang kompatibel dengan dependensi proyek ini.
- npm 10 atau versi yang disertakan pada rilis Node.js modern.
- PostgreSQL 16 atau service PostgreSQL yang kompatibel.
- Docker Desktop atau Docker Engine + Docker Compose v2 jika ingin melakukan deployment dengan container.

### Port default

- `3000` untuk frontend Next.js
- `4000` untuk backend Fastify
- `5432` untuk PostgreSQL

## Quick Start Lokal

### 1. Clone repository

```bash
git clone https://github.com/DoktainerApp/doktainer.git
cd doktainer
```

### 2. Install dependensi

```bash
npm install
```

### 3. Siapkan environment

Salin file environment contoh dan sesuaikan nilainya.

```bash
cp .env.example .env
```

Untuk Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Nilai minimum yang perlu diperhatikan:

```env
NODE_ENV=development
PORT=4000
HOST=0.0.0.0
DATABASE_URL=postgresql://doktainer:doktainerdb@postgres:5432/doktainer?schema=public
JWT_SECRET=change-this-to-a-secure-secret-with-32-chars-min
ENCRYPTION_KEY=change-this-to-a-secure-32-char-key
FRONTEND_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
NEXT_PUBLIC_WS_URL=ws://localhost:4000
```

Catatan penting:

- `JWT_SECRET` harus memiliki panjang minimal 32 karakter, jika tidak backend akan gagal berjalan.
- `DATABASE_URL` harus valid. Jika salah, autentikasi dan startup backend akan gagal lebih awal.
- `ENCRYPTION_KEY` sebaiknya diganti sebelum digunakan di environment nyata.

### 4. Siapkan database

Pastikan PostgreSQL berjalan, lalu generate Prisma client dan sinkronkan skema:

```bash
npm run db:generate
npm run db:push
```

Jika menggunakan workflow migrasi pengembangan, Anda juga dapat menjalankan:

```bash
npm run db:migrate
```

### 5. Jalankan server pengembangan

```bash
npm run dev
```

Setelah berhasil:

- frontend tersedia di `http://localhost:3000`
- backend tersedia di `http://localhost:4000`
- health check backend tersedia di `http://localhost:4000/health`

## Menjalankan Secara Lokal dalam Mode Production Tanpa Docker

Jika ingin menjalankan mode production di mesin lokal:

```bash
npm run build
npm run start
```

Perintah ini akan:

- membangun frontend Next.js
- mengompilasi backend TypeScript ke folder `dist`
- menjalankan frontend production dan backend production secara bersamaan

## Instalasi Online / VPS dengan Docker

Pendekatan ini paling cocok untuk server online, instance VPS, atau environment self-hosted. Proyek ini sudah menyediakan:

- `Dockerfile`
- `docker-compose.yml`
- `docker-compose.build.yml`
- `docker-entrypoint.sh`
- `.env.docker`

### Deployment yang direkomendasikan

Gunakan alur ini jika Anda membangun image langsung dari source proyek di server.

1. Salin proyek ke server.
2. Edit `.env.docker` sesuai kebutuhan.
3. Jalankan:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Jika ingin menggunakan image dari registry, sesuaikan `DOKTAINER_IMAGE` di `.env.docker` dan pastikan strategi deployment tetap konsisten dengan definisi Compose yang aktif.

### Service yang dijalankan

Setup Docker Compose default akan menjalankan:

- `postgres` untuk database PostgreSQL
- `app` untuk frontend Next.js dan backend Fastify dalam satu container aplikasi

Mapping port default:

- `3000:3000` untuk frontend
- `4000:4000` untuk backend
- `5432:5432` untuk PostgreSQL

### Langkah deployment Docker yang direkomendasikan

1. Salin proyek ke server/VPS Linux.
2. Pastikan Docker dan Docker Compose v2 sudah terpasang.
3. Edit `.env.docker` dan ganti secret default.
4. Jalankan perintah build/deploy Compose.
5. Periksa log container.
6. Verifikasi `http://SERVER-IP:3000` dan `http://SERVER-IP:4000/health`.
7. Siapkan reverse proxy dan HTTPS untuk penggunaan production publik.

Contoh untuk melihat log:

```bash
docker compose logs -f app
docker compose logs -f postgres
```

Menghentikan service:

```bash
docker compose down
```

Menghentikan service dan menghapus volume database:

```bash
docker compose down -v
```

## Konfigurasi Runtime Docker

File `.env.docker` adalah sumber environment utama untuk deployment container. Variabel paling penting adalah:

```env
POSTGRES_DB=doktainer
POSTGRES_USER=doktainer
POSTGRES_PASSWORD=replace-this-password
POSTGRES_PORT=5432

NODE_ENV=production
HOST=0.0.0.0
PORT=4000
DATABASE_URL=postgresql://doktainer:replace-this-password@postgres:5432/doktainer?schema=public

JWT_SECRET=replace-this-with-a-secure-32-char-secret
ENCRYPTION_KEY=replace-this-with-a-secure-32-char-key

NEXT_PUBLIC_PANEL_NAME=DOKTAINER
NEXT_PUBLIC_VERSION=v0.1.1
NEXT_PUBLIC_BATCH=Batch-20260606
NEXT_PUBLIC_API_PORT=4000
```

Catatan penting deployment:

- Untuk deployment production, `NEXT_PUBLIC_API_URL` sebaiknya dibiarkan kosong agar browser menggunakan same-origin `/api/v1`.
- Jika Doktainer berjalan di belakang Nginx, Traefik, Caddy, atau Cloudflare Tunnel, aktifkan `TRUST_PROXY=true`.
- Atur `FRONTEND_URL` atau `NEXT_PUBLIC_PANEL_URL` hanya jika Anda benar-benar ingin memaksa satu URL publik kanonis.
- Jangan gunakan `localhost`, `0.0.0.0`, atau host Docker internal sebagai URL production publik.

## Reverse Proxy dan HTTPS

Untuk penggunaan online, sangat disarankan menempatkan Doktainer di belakang reverse proxy seperti:

- Nginx
- Traefik
- Caddy
- Cloudflare Tunnel

Tujuannya adalah untuk:

- menyediakan HTTPS
- meneruskan header host dan protokol dengan benar
- menyederhanakan akses publik dengan domain Anda sendiri
- mengurangi paparan backend langsung ke internet

Jika menggunakan reverse proxy, periksa dua hal berikut:

- set `TRUST_PROXY=true`
- set `FRONTEND_URL=https://your-domain.com` jika Anda membutuhkan URL absolut yang konsisten

## Workflow Pengembangan yang Tersedia

Script utama proyek:

```bash
npm run dev
npm run build
npm run start
npm run lint
npm run test
npm run db:generate
npm run db:push
npm run db:migrate
npm run db:studio
```

Ringkasan fungsi:

- `npm run dev` menjalankan frontend dan backend dalam mode development.
- `npm run build` membangun frontend dan mengompilasi backend.
- `npm run start` menjalankan output build production.
- `npm run lint` menjalankan ESLint.
- `npm run test` menjalankan test suite TypeScript.
- `npm run db:generate` membuat Prisma client.
- `npm run db:push` menyinkronkan skema ke database.
- `npm run db:migrate` membuat dan menerapkan migrasi development.
- `npm run db:studio` membuka Prisma Studio.

## Troubleshooting

### Login atau register gagal

Jika login atau registrasi mengembalikan `Internal Server Error`, hampir selalu mulai dari pengecekan berikut:

1. pastikan `DATABASE_URL` benar
2. pastikan PostgreSQL benar-benar berjalan
3. pastikan `JWT_SECRET` valid dan memiliki panjang minimal 32 karakter
4. jalankan ulang `npm run db:generate`, lalu `npm run db:push`

### Backend gagal berjalan

Kemungkinan penyebab umum:

- port `4000` sudah digunakan oleh proses lain
- koneksi PostgreSQL gagal
- `JWT_SECRET` kosong atau terlalu pendek

### Container app langsung berhenti

Periksa:

- `DATABASE_URL` di `.env.docker`
- password Postgres di `POSTGRES_PASSWORD`
- log container dengan `docker compose logs -f app`

Docker entrypoint proyek ini akan:

- menunggu sampai database dapat diakses
- menjalankan `prisma migrate deploy` jika migrasi tersedia
- fallback ke `prisma db push` jika belum ada migrasi
- menjalankan backend dan frontend dalam satu container

## Catatan Arsitektur

Doktainer di folder ini menggunakan model repository monolith modular dengan dua runtime utama:

- Next.js untuk antarmuka web pada port `3000`
- API Fastify pada port `4000`

Keduanya digabungkan dalam satu proyek untuk menyederhanakan pengembangan dan deployment, sekaligus menjaga pemisahan frontend dan backend tetap jelas pada level runtime.

## Lisensi

Doktainer menggunakan lisensi MIT. Lihat file `LICENSE` di root repository untuk detail lisensi.

#### Penggunaan Non-Komersial Saja

Software ini bebas digunakan, dimodifikasi, dan didistribusikan hanya untuk **tujuan non-komersial**. Penggunaan untuk aktivitas yang menghasilkan pendapatan atau di dalam organisasi profit dilarang keras berdasarkan ketentuan ini.

#### Lisensi Komersial

Jika ingin menggunakan Doktainer untuk tujuan komersial, operasional bisnis, atau sebagai bagian dari layanan berbayar, Anda harus memperoleh lisensi komersial terpisah. Silakan hubungi author untuk informasi lebih lanjut.

---

<p align="center">Dibuat dengan cinta oleh KodekaTeam</p>
