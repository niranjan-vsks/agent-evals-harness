FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && apt-get clean && find /var/lib/apt/lists -type f -delete
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# postinstall runs `prisma generate`, which needs no live database.
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
# migrate deploy applies 0001_init and 0002_invariants before the API accepts traffic.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
