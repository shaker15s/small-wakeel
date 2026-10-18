# وكيل — production image.
#
# Two stages: the builder compiles the Next standalone bundle (type errors fail
# the build), the runner carries only the standalone output + the SQLite file
# directory. No Rust engines are downloaded: Prisma runs in `engineType=client`
# mode through the libsql driver adapter.
FROM oven/bun:1.3.11-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json bun.lock ./
COPY scripts/prisma-generate.sh ./scripts/prisma-generate.sh
COPY prisma ./prisma
RUN bun install --frozen-lockfile
COPY . .
ENV DATABASE_URL=file:./db/custom.db
RUN bun run db:generate && bun run build

FROM oven/bun:1.3.11-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_URL=file:./db/custom.db
RUN addgroup -S wakil && adduser -S wakil -G wakil
# standalone output already contains the traced node_modules it needs
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/db ./db
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/build/maintenance ./maintenance
RUN mkdir -p /app/db && chown -R wakil:wakil /app
USER wakil
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e 'const token=process.env.WAKIL_HEALTH_TOKEN;if(!token)process.exit(1);const res=await fetch("http://127.0.0.1:3000/api/health",{headers:{authorization:"Bearer "+token}});process.exit(res.ok?0:1)'
CMD ["bun", "server.js"]
