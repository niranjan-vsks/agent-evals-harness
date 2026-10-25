# Build stage: install, run the Vitest suite, typecheck and build. A red test or a type error fails
# `docker compose build` (cards/P4.md section 8, gate 2): the nginx image has no test runner.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm test
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
