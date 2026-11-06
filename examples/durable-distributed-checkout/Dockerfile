FROM node:24-alpine
WORKDIR /app
COPY . .
RUN npm ci --include=dev --registry=https://registry.npmjs.org \
    && npm run build --workspace=@siglo/core \
    && npm run build --workspace=@siglo/express \
    && npm run build --workspace=@siglo/postgres \
    && npm run build --workspace=@siglo/redis \
    && npm run build --workspace=@siglo/monitor
CMD ["node", "--import", "tsx", "examples/src/durable-distributed-checkout/api-durable.ts"]
