# Build from the repository root:
#   docker build -f packages/mcp-connector/Dockerfile -t paperclip-mcp-connector .
FROM node:24-alpine AS build
WORKDIR /src
RUN corepack enable
COPY . .
# Install exactly the checked-in lockfile; a stale lockfile fails the build
# instead of being re-resolved inside the image.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@paperclipai/mcp-connector..." \
  && pnpm --filter @paperclipai/mcp-connector build \
  && pnpm --filter @paperclipai/mcp-connector deploy --prod --ignore-scripts /out

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PAPERCLIP_MCP_CONNECTOR_CREDENTIALS_FILE=/data/credentials.json
# Carry only the lockfile-resolved runtime package and its dependencies.
COPY --from=build /out/ ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
ENTRYPOINT ["node", "/app/dist/main.js"]
CMD ["run"]
