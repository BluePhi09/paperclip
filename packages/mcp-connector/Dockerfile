# Build from the repository root:
#   docker build -f packages/mcp-connector/Dockerfile -t paperclip-mcp-connector .
FROM node:24-alpine AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@paperclipai/mcp-connector..." \
  && pnpm --filter @paperclipai/mcp-connector build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PAPERCLIP_MCP_CONNECTOR_CREDENTIALS_FILE=/data/credentials.json
COPY --from=build /src/packages/mcp-connector/dist ./dist
RUN npm install --omit=dev --no-audit --no-fund ws@8.21.3 \
  && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
ENTRYPOINT ["node", "/app/dist/main.js"]
CMD ["run"]
