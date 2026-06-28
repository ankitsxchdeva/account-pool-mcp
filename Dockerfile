# Container image for the account-pool-mcp stdio server.
# Used by MCP directories (e.g. Glama) to start the server and run introspection,
# and usable directly:  docker run -i --rm -v "$PWD:/data" account-pool-mcp
FROM node:20-bookworm-slim AS build
WORKDIR /app
# build toolchain for better-sqlite3 (falls back to source build if no prebuilt binary)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    APM_DB_PATH=/data/account-pool.db \
    APM_ACCOUNTS_FILE=/data/accounts.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY examples ./examples
RUN mkdir -p /data
# stdio MCP server: clients talk to it over stdin/stdout
ENTRYPOINT ["node", "dist/index.js"]
