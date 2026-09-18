# MTGA Stats Website – schlankes Node-Image, keine nativen Abhängigkeiten
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# Server-Abhängigkeiten
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund
# Server, gemeinsames Frontend und Icons
COPY server ./server
COPY web ./web
COPY assets ./assets
RUN mkdir -p /data && chown -R node:node /data /app
USER node
ENV DATA_DIR=/data PORT=3000 HOST=0.0.0.0
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server/src/index.js"]
