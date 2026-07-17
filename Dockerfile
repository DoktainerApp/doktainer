FROM node:22-bookworm-slim AS base

WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends curl openssl ca-certificates util-linux gnupg \
	&& curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg \
	&& echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends postgresql-client-17 \
	&& rm -rf /var/lib/apt/lists/*

FROM base AS deps

COPY package*.json ./
RUN npm ci

FROM base AS builder

ARG NEXT_PUBLIC_API_URL=
ARG NEXT_PUBLIC_WS_URL=
ARG NEXT_PUBLIC_API_PORT=4000
ARG NEXT_PUBLIC_PANEL_NAME=DOKTAINER
ARG NEXT_PUBLIC_VERSION=v0.1.6
ARG NEXT_PUBLIC_BATCH=Batch-20260717

ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ENV NEXT_PUBLIC_API_PORT=$NEXT_PUBLIC_API_PORT
ENV NEXT_PUBLIC_PANEL_NAME=$NEXT_PUBLIC_PANEL_NAME
ENV NEXT_PUBLIC_VERSION=$NEXT_PUBLIC_VERSION
ENV NEXT_PUBLIC_BATCH=$NEXT_PUBLIC_BATCH
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npx prisma generate
RUN npm run build

FROM base AS runner

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4000
ENV POSTGRES_HOST=postgres
ENV POSTGRES_DB_PORT=5432
ENV POSTGRES_DB=doktainer
ENV POSTGRES_USER=doktainer
ENV POSTGRES_PASSWORD=doktainerdb
ENV DATABASE_URL=postgresql://doktainer:doktainerdb@postgres:5432/doktainer?schema=public

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh
COPY .env.docker .env

RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 3000 4000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
