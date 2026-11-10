# Probe image: non-root like SAM's Instant image (USER node), HTTP + WebSocket echo.
FROM node:22-alpine
RUN apk add --no-cache git
WORKDIR /app
RUN npm init -y >/dev/null && npm install ws@8 >/dev/null
COPY server.mjs .
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
