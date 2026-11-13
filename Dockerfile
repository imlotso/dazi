FROM node:26-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ libatomic1 && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:26-bookworm-slim
ENV NODE_ENV=production PORT=3001 DATABASE_PATH=/app/data/dazi.sqlite
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/* && mkdir -p /app/data && chown node:node /app/data
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/scripts/backup.mjs ./scripts/backup.mjs
USER node
EXPOSE 3001
CMD ["node", "dist/server/app.js"]
