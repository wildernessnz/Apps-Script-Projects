#!/bin/bash
# deploy.sh — build and deploy the sync service to Cloud Run
# Run this once to set up, then CI/CD handles subsequent deploys.
#
# Prerequisites:
#   gcloud auth login
#   gcloud config set project YOUR_PROJECT_ID

set -e

PROJECT_ID=$(gcloud config get-value project)
REGION="australia-southeast1"          # Change to your preferred region
SERVICE_NAME="wilderness-data-sync"
IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

echo "Project: ${PROJECT_ID}"
echo "Region:  ${REGION}"
echo "Image:   ${IMAGE}"

# --- 1. Build and push container image ---
gcloud builds submit --tag "${IMAGE}" ./sync-service

# --- 2. Deploy to Cloud Run ---
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --platform managed \
  --no-allow-unauthenticated \          # Only Cloud Scheduler can invoke it
  --set-env-vars "GCP_PROJECT_ID=${PROJECT_ID}" \
  --service-account "data-sync@${PROJECT_ID}.iam.gserviceaccount.com" \
  --memory "512Mi" \
  --timeout "3600"                      # 1 hour max — enough for large syncs

SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --region "${REGION}" \
  --format "value(status.url)")

echo ""
echo "Service deployed: ${SERVICE_URL}"

# --- 3. Create Cloud Scheduler jobs ---
# Adjust cron schedules to suit your data freshness needs.

# Fleetio — every 30 min during business hours (NZ time = UTC+13 in summer)
gcloud scheduler jobs create http fleetio-sync \
  --location "${REGION}" \
  --schedule "*/30 6-18 * * 1-5" \
  --uri "${SERVICE_URL}/sync/fleetio" \
  --http-method POST \
  --oidc-service-account-email "data-sync@${PROJECT_ID}.iam.gserviceaccount.com" \
  --time-zone "Pacific/Auckland" \
  || echo "Fleetio scheduler job already exists, skipping"

# HubSpot — every 15 min
gcloud scheduler jobs create http hubspot-sync \
  --location "${REGION}" \
  --schedule "*/15 * * * *" \
  --uri "${SERVICE_URL}/sync/hubspot" \
  --http-method POST \
  --oidc-service-account-email "data-sync@${PROJECT_ID}.iam.gserviceaccount.com" \
  --time-zone "Pacific/Auckland" \
  || echo "HubSpot scheduler job already exists, skipping"

# Xero — every hour (Xero rate limits are tighter)
gcloud scheduler jobs create http xero-sync \
  --location "${REGION}" \
  --schedule "0 * * * *" \
  --uri "${SERVICE_URL}/sync/xero" \
  --http-method POST \
  --oidc-service-account-email "data-sync@${PROJECT_ID}.iam.gserviceaccount.com" \
  --time-zone "Pacific/Auckland" \
  || echo "Xero scheduler job already exists, skipping"

echo ""
echo "Done. Scheduler jobs created. Check Cloud Scheduler in the console."
echo ""
echo "Next: run setup-secrets.sh to populate Secret Manager"
