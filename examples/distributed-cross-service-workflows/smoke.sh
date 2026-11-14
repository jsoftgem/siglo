#!/usr/bin/env bash
set -euo pipefail

ORDER_SERVICE_URL="${ORDER_SERVICE_URL:-http://127.0.0.1:3001}"
MONITOR_URL="${MONITOR_URL:-http://127.0.0.1:4200}"

echo "================================================================"
echo "  Dispatching Sample Distributed Orders via cURL"
echo "================================================================"

echo -e "\n1. Dispatching Order for Tenant A (tenant_acme_retail)..."
curl -s -i -X POST "${ORDER_SERVICE_URL}/api/orders" \
  -H "Content-Type: application/json" \
  -H "x-stack-id: stack-acme-order-101" \
  -H "x-tenant-id: tenant_acme_retail" \
  -d '{"orderId":"ORD-ACME-001","sku":"mechanical-keyboard-rgb","quantity":2,"amountCents":15998,"customerEmail":"buyer@acme.com"}'

echo -e "\n\n2. Dispatching Order for Tenant B (tenant_globex_corp)..."
curl -s -i -X POST "${ORDER_SERVICE_URL}/api/orders" \
  -H "Content-Type: application/json" \
  -H "x-stack-id: stack-globex-order-202" \
  -H "x-tenant-id: tenant_globex_corp" \
  -d '{"orderId":"ORD-GLOBEX-002","sku":"datacenter-switch-48p","quantity":1,"amountCents":850000,"customerEmail":"procure@globex.com"}'

echo -e "\n\n================================================================"
echo "  Success! Open ${MONITOR_URL} in your browser to inspect."
echo "================================================================"
