FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY web/package.json web/
RUN npm ci --workspace web

COPY web/ web/
WORKDIR /app/web
RUN npm run build

FROM nginx:alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
