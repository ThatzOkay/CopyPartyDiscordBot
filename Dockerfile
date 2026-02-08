FROM oven/bun:latest AS builder

WORKDIR /app

COPY package.json bun.lockb* ./

RUN bun install

COPY . .

RUN bun run build

FROM debian:bookworm-slim

WORKDIR /app

COPY --from=builder /app/dist ./dist

CMD ["dist/CopyPartySearcher"]