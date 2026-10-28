FROM node:22-alpine AS build
WORKDIR /ui
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Unprivileged nginx: runs as a non-root user and listens on 8080.
FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY docker/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /ui/out /usr/share/nginx/html
ENV API_URL=http://ethan:8000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
