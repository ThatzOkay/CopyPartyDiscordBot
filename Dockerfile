FROM oven/bun:latest AS builder

WORKDIR /app

COPY package.json bun.lockb* ./

RUN bun install

COPY . .

RUN bun build ./index.ts --target node --outdir dist

FROM oven/bun:latest

WORKDIR /app

COPY --from=builder /app/dist ./dist

CMD ["dist/CopyPartySearcher"]