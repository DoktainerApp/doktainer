<div align="center">
  <img src="./images/previews/banner-doktainer-feature.png" alt="Doktainer Mascot (DOKTA)" width="780"/>
  
# Doktainer - Manage Docker, Simplify Everything

![GitHub forks](https://img.shields.io/github/forks/DoktainerApp/doktainer)
![GitHub forks](https://img.shields.io/github/stars/DoktainerApp/doktainer)<br>
[![Discord](https://img.shields.io/discord/1497461926609948733?color=5865f2&label=Discord&style=flat-square)](https://discord.gg/tDUBDCYw9Q)
[![Docker Pulls](https://img.shields.io/docker/pulls/doktainer/doktainer.svg?logo=docker&label=Docker%20pulls)](https://hub.docker.com/r/doktainer/doktainer)<br>
[![GHCR](https://img.shields.io/badge/GHCR-doktainer%2Fdoktainer-blue?logo=github)](https://github.com/DoktainerApp/doktainer/pkgs/container/doktainer)
[![License](https://img.shields.io/npm/l/doktainer.svg)](https://github.com/DoktainerApp/doktainer/blob/main/LICENSE)

  </div>

Doktainer is an open-source, self-hosted platform for managing servers, applications, containers, domains, SSL, backups, and deployment operations from a single web panel.

This project uses a modern modular monolith architecture:

- frontend with Next.js App Router
- backend API with Fastify
- PostgreSQL database via Prisma ORM
- local and server deployment using Docker Compose

Doktainer is intended for teams or individuals who want to own their own deployment panel without depending on a specific cloud vendor, while still retaining full control over their servers and data.

## Key Features

- Server management and user access in one panel.
- Docker-based application and container management.
- Support for domains, SSL, networks, security, logs, metrics, and terminal access.
- Organizations, role-based access, API keys, and user settings configuration.
- Git provider, storage destination, and notification/backup integrations.
- Modern panel UI with Next.js and a backend API that runs separately at runtime.
- Support for local development and Docker deployment to a VPS or online server.

## Tech Stack

- Next.js 16
- React 19
- Fastify 5
- Prisma 6
- PostgreSQL 16
- TypeScript 5
- Docker Compose

## Project Structure

- `src/app` for routes and frontend pages based on the Next.js App Router.
- `src/components` for shared UI components.
- `src/lib` for frontend utilities and shared runtime helpers.
- `src/server` for the Fastify backend API, services, middleware, and server libraries.
- `prisma` for the database schema and Prisma migrations.
- `scripts` for internal helper scripts such as Prisma client checks.
- `tests` for tests relevant to this codebase.

## System Requirements

### Minimum for development

- Node.js 22 or a version compatible with this project's dependencies.
- npm 10 or the version bundled with modern Node.js releases.
- PostgreSQL 16 or a compatible PostgreSQL service.
- Docker Desktop or Docker Engine + Docker Compose v2 if you want to deploy with containers.

### Default ports

- `3000` for the Next.js frontend
- `4000` for the Fastify backend
- `5432` for PostgreSQL

## Local Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/DoktainerApp/doktainer
cd doktainer
```

### 2. Install dependencies

```bash
npm install
```

### 3. Prepare the environment

Copy the example environment file and adjust the values.

```bash
cp .env.example .env
```

For Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Minimum values that need attention:

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

Important notes:

- `JWT_SECRET` must be at least 32 characters long, otherwise the backend will fail to start.
- `DATABASE_URL` must be valid. If it is incorrect, authentication and backend startup will fail early.
- `ENCRYPTION_KEY` should be changed before being used in a real environment.

### 4. Prepare the database

Make sure PostgreSQL is running, then generate the Prisma client and synchronize the schema:

```bash
npm run db:generate
npm run db:push
```

If you use the development migration workflow, you can also run:

```bash
npm run db:migrate
```

### 5. Run the development server

```bash
npm run dev
```

Once it succeeds:

- the frontend is available at `http://localhost:3000`
- the backend is available at `http://localhost:4000`
- the backend health check is available at `http://localhost:4000/health`

## Running Locally in Production Mode Without Docker

If you want to run production mode on a local machine:

```bash
npm run build
npm run start
```

This command will:

- build the Next.js frontend
- compile the TypeScript backend into the `dist` folder
- run the production frontend and production backend together

## Online / VPS Installation With Docker

This approach is best suited for online servers, VPS instances, or self-hosted environments. This project already provides:

- `Dockerfile`
- `docker-compose.yml`
- `docker-compose.build.yml`
- `docker-entrypoint.sh`
- `.env.docker`

### Recommended deployment

Use this flow if you build the image directly from the project source on the server.

1. Copy the project to the server.
2. Edit `.env.docker` as needed.
3. Run:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

If you want to use an image from a registry, adjust `DOKTAINER_IMAGE` in `.env.docker` and make sure your deployment strategy remains consistent with the active Compose definitions.

### Services that are started

The default Docker Compose setup will run:

- `postgres` for the PostgreSQL database
- `app` for the Next.js frontend and Fastify backend in a single application container

Default port mappings:

- `3000:3000` for the frontend
- `4000:4000` for the backend
- `5432:5432` for PostgreSQL

### Recommended Docker deployment steps

1. Copy the project to a Linux server/VPS.
2. Make sure Docker and Docker Compose v2 are installed.
3. Edit `.env.docker` and replace the default secrets.
4. Run the Compose build/deploy command.
5. Check the container logs.
6. Verify `http://SERVER-IP:3000` and `http://SERVER-IP:4000/health`.
7. Set up a reverse proxy and HTTPS for public production use.

Example for viewing logs:

```bash
docker compose logs -f app
docker compose logs -f postgres
```

Stopping the services:

```bash
docker compose down
```

Stopping the services and removing the database volume:

```bash
docker compose down -v
```

## Docker Runtime Configuration

The `.env.docker` file is the main environment source for container deployment. The most important variables are:

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
NEXT_PUBLIC_VERSION=v0.1.0
NEXT_PUBLIC_BATCH=Batch-20260515
NEXT_PUBLIC_API_PORT=4000
```

Important deployment notes:

- For purpose deployment, `NEXT_PUBLIC_API_URL` should be left empty so the browser uses the same-origin `/api/v1`.
- If Doktainer runs behind Nginx, Traefik, Caddy, or Cloudflare Tunnel, enable `TRUST_PROXY=true`.
- Set `FRONTEND_URL` or `NEXT_PUBLIC_PANEL_URL` only if you truly want to force a single canonical public URL.
- Do not use `localhost`, `0.0.0.0`, or an internal Docker host as the public production URL.

## Reverse Proxy and HTTPS

For online use, it is highly recommended to place Doktainer behind a reverse proxy such as:

- Nginx
- Traefik
- Caddy
- Cloudflare Tunnel

The goals are to:

- provide HTTPS
- forward host and protocol headers correctly
- simplify public access with your own domain
- reduce direct backend exposure to the internet

If you use a reverse proxy, check the following two things:

- set `TRUST_PROXY=true`
- set `FRONTEND_URL=https://your-domain.com` if you need consistent absolute URLs

## Available Development Workflow

Main project scripts:

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

Function summary:

- `npm run dev` runs the frontend and backend in development mode.
- `npm run build` builds the frontend and compiles the backend.
- `npm run start` runs the production build output.
- `npm run lint` runs ESLint.
- `npm run test` runs the TypeScript test suite.
- `npm run db:generate` generates the Prisma client.
- `npm run db:push` synchronizes the schema to the database.
- `npm run db:migrate` creates and applies development migrations.
- `npm run db:studio` opens Prisma Studio.

## Troubleshooting

### Login or register fails

If login or registration returns `Internal Server Error`, almost always start with the following checks:

1. make sure `DATABASE_URL` is correct
2. make sure PostgreSQL is actually running
3. make sure `JWT_SECRET` is valid and at least 32 characters long
4. rerun `npm run db:generate`, then `npm run db:push`

### Backend fails to start

Common possible causes:

- port `4000` is already used by another process
- PostgreSQL connection fails
- `JWT_SECRET` is empty or too short

### App container exits immediately

Check:

- `DATABASE_URL` in `.env.docker`
- the Postgres password in `POSTGRES_PASSWORD`
- container logs with `docker compose logs -f app`

This project's Docker entrypoint will:

- wait until the database can be accessed
- run `prisma migrate deploy` if migrations are available
- fall back to `prisma db push` if no migrations exist yet
- start the backend and frontend in a single container

## Architecture Notes

Doktainer in this folder uses a modular monolith repository model with two main runtimes:

- Next.js for the web interface on port `3000`
- Fastify API on port `4000`

Both are combined in a single project to simplify development and deployment, while keeping the frontend and backend separation clear at the runtime level.

## License

Doktainer uses the MIT license. See the `LICENSE` file in the repository root for license details.

#### 🚫 Non-Commercial Use Only

The software is free to use, modify, and distribute for **non-commercial purposes only**. Any use for revenue-generating activities or within for-profit organizations is strictly prohibited under these terms.

#### 💼 Commercial Licensing

If you wish to use Doktainer for commercial purposes, business operations, or as part of a paid service, you must obtain a separate commercial license. Please contact the author for further information.

---

<p align="center">Built with ❤️ by the KodekaTeam</p>
