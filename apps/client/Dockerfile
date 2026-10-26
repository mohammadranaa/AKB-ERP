# Web image: the built screens served by nginx, which also forwards /api to the API.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/client/package.json apps/client/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @akb/client
COPY apps/client apps/client
RUN pnpm --filter @akb/client build

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/client/dist /usr/share/nginx/html
EXPOSE 8080
