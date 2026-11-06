ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE}
WORKDIR /app
COPY . .
RUN npm ci --include=dev --registry=https://registry.npmjs.org \
    && npm run build --workspace=@siglo/core \
    && npm run build --workspace=@siglo/opentelemetry \
    && npm run build --workspace=@siglo/kafka \
    && npm run build --workspace=@siglo/postgres \
    && npm run build:ui --workspace=@siglo/monitor \
    && npm run build --workspace=@siglo/monitor \
    && npm run build --workspace=siglo-apm-monitoring
CMD ["node", "--import", "tsx", "examples/zero-code-apm-dashboards/src/order-routing/worker.ts"]
