# Always-on runner: docker build -t ballast . && docker run -d --restart unless-stopped \
#   --env-file .secrets/agent.env -e TRADING_MODE=live -v ballast-state:/app/state ballast
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
ENV NODE_ENV=production STATE_PATH=/app/state/agent.live.local.json CACHE_DIR=/app/state/cache
VOLUME ["/app/state"]
CMD ["npx", "tsx", "src/cli/run.ts", "--interval", "60"]
