FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist

EXPOSE 8080
CMD ["node", "dist/api/server.js"]
