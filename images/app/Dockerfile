FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS dashboard-build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/package.json
COPY services/gateway/package.json services/gateway/package.json
COPY services/woocommerce-mcp/package.json services/woocommerce-mcp/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
RUN npm ci --ignore-scripts --cache=/tmp/npm-cache
COPY apps/dashboard apps/dashboard
RUN npm run build:dashboard

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/package.json
COPY services/gateway/package.json services/gateway/package.json
COPY services/woocommerce-mcp/package.json services/woocommerce-mcp/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
RUN npm ci --omit=dev --ignore-scripts --cache=/tmp/npm-cache && rm -rf /tmp/npm-cache
COPY --chown=node:node packages packages
COPY --chown=node:node services services
COPY --chown=node:node scripts/bootstrap-cluster.ts scripts/bootstrap-cluster.ts
# The store provisioner mounts the same readiness probe into each store.
COPY --chown=node:node charts/storelink/files/health.php charts/storelink/files/health.php
COPY --from=dashboard-build --chown=node:node /app/apps/dashboard/dist apps/dashboard/dist
USER node
ENV NODE_ENV=production BIND_ADDRESS=0.0.0.0
CMD ["node", "services/gateway/src/main.ts"]
