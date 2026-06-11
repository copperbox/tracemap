FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci --workspace server

COPY server/ server/
WORKDIR /app/server

EXPOSE 4000 4318
CMD ["npx", "tsx", "src/index.ts"]
