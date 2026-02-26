FROM oven/bun:1
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run generate-types
CMD ["bun", "run", "start"]
