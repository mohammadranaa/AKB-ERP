# API image. Build from the repository root:  docker compose build api
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/client/package.json apps/client/
RUN pnpm install --frozen-lockfile --filter @akb/api
COPY apps/api apps/api
RUN pnpm --filter @akb/api build

FROM node:22-alpine
RUN corepack enable && apk add --no-cache tzdata
ENV NODE_ENV=production
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/client/package.json apps/client/
RUN pnpm install --frozen-lockfile --prod --filter @akb/api && pnpm store prune
COPY --from=build /app/apps/api/dist apps/api/dist
COPY db db
WORKDIR /app/apps/api
USER node
EXPOSE 4000
# Apply any new migrations, then start. Migrations refuse to run if an applied file was edited.
CMD ["sh", "-c", "node dist/src/cli/migrate.js && exec node dist/src/server.js"]
