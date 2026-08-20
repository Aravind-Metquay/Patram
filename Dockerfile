# One image, two entrypoints: the API and the worker differ only by command.
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# dumb-init reaps zombies and forwards SIGTERM, which is what our graceful
# shutdown handlers are waiting for.
RUN apk add --no-cache dumb-init \
    && addgroup -S app && adduser -S app -G app \
    && mkdir -p /data/jobs && chown -R app:app /data
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER app
EXPOSE 8080
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/api/server.js"]
