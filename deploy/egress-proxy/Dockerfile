# The managed egress proxy: each restricted sandbox's own allowlist, enforced.
#
# Node built-ins only, so the image is two files. Build from the app directory:
#
#   docker build -t managed-agent/egress-proxy -f deploy/egress-proxy/Dockerfile apps/egress-proxy
#
# Run it on the sandboxes' egress-less internal network and on one with a way
# out, with the secret the control plane has (MA_EGRESS_PROXY_SECRET):
#
#   docker run -d --name ma-egress --network ma-internal \
#     -e MA_EGRESS_PROXY_SECRET_FILE=/run/secrets/egress managed-agent/egress-proxy
#   docker network connect bridge ma-egress
FROM node:24-alpine

WORKDIR /app
COPY src/proxy.ts src/main.ts ./

USER node
EXPOSE 3128
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD wget -q -O - http://127.0.0.1:3128/healthz || exit 1

ENTRYPOINT ["node", "main.ts"]
