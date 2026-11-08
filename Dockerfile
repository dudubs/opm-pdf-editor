# syntax=docker/dockerfile:1
# Our fork of pdf.js (vendor/pdfjs) -> a pdfjs-dist compatible package.
FROM node:24 AS pdfjs
WORKDIR /pdfjs
COPY vendor/pdfjs/package.json vendor/pdfjs/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY vendor/pdfjs ./
RUN npx gulp dist

FROM oven/bun:1 AS build
WORKDIR /app
COPY --from=pdfjs /pdfjs/build/dist ./vendor/pdfjs/build/dist
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN bun run typecheck && bun run build

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data PUBLIC_DIR=/app/dist/public
COPY --from=build /app/src/server.ts ./src/server.ts
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD bun -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "src/server.ts"]
