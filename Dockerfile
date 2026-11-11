FROM node:26-bookworm-slim AS build
WORKDIR /app

# npm 12 honors package.json's allowScripts, which keeps better-sqlite3 on
# its bundled prebuilt binary; npm 11 would try to compile it.
RUN npm install -g npm@12

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

RUN cd dist && node --test

RUN find dist \( -name '*.test.js' -o -name '*.test.js.map' \) -delete

RUN npm prune --omit=dev

FROM node:26-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json LICENSE ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY bin ./bin
COPY views ./views
COPY public ./public

RUN mkdir -p /app/data && chown -R node:node /app
USER node

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get({ host: '127.0.0.1', port: process.env.PORT || 3000, timeout: 3000 }, res => process.exit(res.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "./bin/www"]
