# ---- build the React client ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY client client
RUN npm run build

# ---- runtime: Node server + built client + Python for code execution ----
FROM node:22-alpine
RUN apk add --no-cache python3
WORKDIR /app
ENV NODE_ENV=production PORT=3001 DATA_DIR=/data STATIC_DIR=/app/client/dist
COPY package*.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev -w server
COPY server/src server/src
COPY --from=build /app/client/dist client/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3001
CMD ["node", "server/src/main.js"]
