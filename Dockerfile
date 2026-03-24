# Base node image
FROM node:22-alpine AS base
RUN apk add --no-cache openssl tzdata
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install
COPY . .

# Dev stage — runs as root (bind-mounted volumes override anyway)
FROM base AS dev
ENV NODE_ENV=development
CMD ["pnpm", "run", "dev"]

# Prod stage — non-root for security
FROM base AS prod
ENV NODE_ENV=production
RUN addgroup -g 1001 nodejs && adduser -S -u 1001 -G nodejs nodejs
RUN pnpm prune --prod
RUN chown -R nodejs:nodejs /app
USER nodejs
CMD ["pnpm", "start"]

# Worker dev stage
FROM base AS worker-dev
ENV NODE_ENV=development
CMD ["pnpm", "run", "worker:dev"]

# Worker prod stage — non-root for security
FROM base AS worker-prod
ENV NODE_ENV=production
RUN addgroup -g 1001 nodejs && adduser -S -u 1001 -G nodejs nodejs
RUN pnpm prune --prod
RUN chown -R nodejs:nodejs /app
USER nodejs
CMD ["pnpm", "run", "worker"]
