# Images for the control plane and for sandboxes. Build from the repository root:
#
#   docker build --target server  -t managed-agent/server  -f deploy/Dockerfile .
#   docker build --target runtime -t managed-agent/runtime -f deploy/Dockerfile .
#
# The platform has no third-party runtime dependencies; installing only links
# the workspace packages together. Node runs the TypeScript sources directly.

FROM node:24-slim AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile --prod && rm -rf /root/.cache /root/.local/share/pnpm

# The control plane. Listens on 8080; state in MA_DATABASE (mount a volume).
FROM base AS server
ENV MA_HOST=0.0.0.0 MA_PORT=8080 NODE_ENV=production
USER 1000
EXPOSE 8080
CMD ["node", "apps/server/src/main.ts"]

# A sandbox: agent-core plus the tools an agent's shell commands expect. The k8s
# driver runs it as a non-root user with a read-only root filesystem, /workspace
# and /tmp mounted writable.
FROM base AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*
ENV HOME=/tmp NODE_ENV=production
USER 1000
WORKDIR /workspace
CMD ["node", "/app/apps/agent-core/src/main.ts"]
