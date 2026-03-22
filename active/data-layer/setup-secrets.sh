#!/bin/bash
# setup-secrets.sh — create Secret Manager entries for all API credentials
# Run once, then update values in the GCP console as needed.
# Never commit actual values to git.

set -e

PROJECT_ID=$(gcloud config get-value project)

create_secret() {
  local name=$1
  local prompt=$2
  echo -n "${prompt}: "
  read -s value
  echo ""
  echo -n "${value}" | gcloud secrets create "${name}" \
    --data-file=- \
    --project="${PROJECT_ID}" \
    2>/dev/null || \
  echo -n "${value}" | gcloud secrets versions add "${name}" \
    --data-file=- \
    --project="${PROJECT_ID}"
  echo "  Saved: ${name}"
}

echo "=== Fleetio ==="
create_secret "fleetio-api-key"       "Fleetio API key"
create_secret "fleetio-account-token" "Fleetio account token"

echo ""
echo "=== HubSpot ==="
create_secret "hubspot-access-token"  "HubSpot private app access token"

echo ""
echo "=== Xero ==="
create_secret "xero-client-id"        "Xero OAuth2 client ID"
create_secret "xero-client-secret"    "Xero OAuth2 client secret"
create_secret "xero-tenant-id"        "Xero tenant (organisation) ID"
create_secret "xero-refresh-token"    "Xero refresh token"

echo ""
echo "Done. All secrets stored in Secret Manager."
echo "Grant the service account access:"
echo "  gcloud projects add-iam-policy-binding ${PROJECT_ID} \\"
echo "    --member='serviceAccount:data-sync@${PROJECT_ID}.iam.gserviceaccount.com' \\"
echo "    --role='roles/secretmanager.secretAccessor'"
