# The whole system in one image: the React screens are built, then served by the API server.
# Built on the hotel's mini PC by deploy/install.sh; nothing is pulled from our hosted servers at run time.
FROM node:20.18-bookworm-slim AS client
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
RUN npm run build

FROM node:20.18-bookworm-slim
ENV NODE_ENV=production PORT=4000
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server/ ./
COPY --from=client /app/client/dist /app/client/dist
USER node
EXPOSE 4000
CMD ["node", "src/server.js"]
