FROM oven/bun:1.4.4-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
RUN mkdir /data && chown bun:bun /data
USER bun
VOLUME /data
ENTRYPOINT ["bun", "src/cli.ts"]
CMD ["serve", "--db", "/data/raven.db", "--host", "127.0.0.1", "--port", "7811", "--snapshot-dir", "/data/snapshots"]
