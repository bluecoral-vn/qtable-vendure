# ─────────────────────────────────────────────
# QTable Vendure — Multi-stage Production Build
# ─────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json lerna.json tsconfig*.json ./
COPY packages/core/ packages/core/
COPY packages/common/ packages/common/
COPY packages/testing/ packages/testing/
COPY packages/qtable-saas/ packages/qtable-saas/
COPY packages/dev-server/ packages/dev-server/

RUN npm ci --ignore-scripts
RUN npm run build -- --scope @vendure/core --scope @vendure/common --scope @qtable/vendure-saas

# ─────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Copy built artifacts
COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/packages/core/package.json packages/core/
COPY --from=builder /app/packages/common/dist packages/common/dist
COPY --from=builder /app/packages/common/package.json packages/common/
COPY --from=builder /app/packages/qtable-saas/dist packages/qtable-saas/dist
COPY --from=builder /app/packages/qtable-saas/package.json packages/qtable-saas/
COPY --from=builder /app/packages/dev-server/dist packages/dev-server/dist
COPY --from=builder /app/packages/dev-server/package.json packages/dev-server/
COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/package*.json ./

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD wget -q --spider http://localhost:3000/health || exit 1

CMD ["node", "packages/dev-server/dist/index.js"]
