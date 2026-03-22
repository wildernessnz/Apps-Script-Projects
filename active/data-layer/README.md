# Wilderness Data Layer

Offloads Fleetio, HubSpot, and Xero API work from Apps Script into a GCP-hosted sync service. Apps Script projects read from BigQuery instead of calling vendor APIs directly.

## Architecture

```
Fleetio API ──┐
HubSpot API ──┼──► Cloud Run (sync-service) ──► BigQuery ──► Apps Script → Sheets
Xero API ────┘         ▲
                        │
                  Cloud Scheduler
                  (every 15–60 min)
```

## Directory Structure

```
data-layer/
├── sync-service/          Cloud Run Node.js app
│   ├── index.js           Express routes (/sync/fleetio, /sync/hubspot, /sync/xero)
│   ├── bigquery.js        BQ write helpers (loadTable)
│   ├── secrets.js         Secret Manager access
│   ├── connectors/
│   │   ├── fleetio.js     Fleetio API → BQ (assets, work_orders, issues)
│   │   ├── hubspot.js     HubSpot API → BQ (contacts, deals, companies)
│   │   └── xero.js        Xero API → BQ (invoices, contacts, payments)
│   ├── Dockerfile
│   └── package.json
├── apps-script/
│   ├── DataLayer.js       Drop into any Apps Script project (bqQuery, Fleetio, HubSpot, Xero wrappers)
│   ├── Example_Before_After.js
│   └── appsscript_additions.json   Add BigQuery advanced service to appsscript.json
├── deploy.sh              Build + deploy Cloud Run + create Scheduler jobs
└── setup-secrets.sh       Populate Secret Manager with API credentials
```

## Setup (one-time)

### 1. GCP prerequisites

```bash
# Enable required APIs
gcloud services enable \
  run.googleapis.com \
  bigquery.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  cloudbuild.googleapis.com

# Create a dedicated service account
gcloud iam service-accounts create data-sync \
  --display-name "Wilderness Data Sync"

# Grant it the roles it needs
PROJECT=$(gcloud config get-value project)
for role in \
  roles/bigquery.dataEditor \
  roles/bigquery.jobUser \
  roles/secretmanager.secretAccessor \
  roles/run.invoker; do
  gcloud projects add-iam-policy-binding $PROJECT \
    --member="serviceAccount:data-sync@${PROJECT}.iam.gserviceaccount.com" \
    --role="$role"
done
```

### 2. Store API credentials

```bash
chmod +x setup-secrets.sh
./setup-secrets.sh
```

### 3. Deploy the sync service

```bash
chmod +x deploy.sh
./deploy.sh
```

### 4. Update Apps Script projects

In each Apps Script project:

1. Copy `apps-script/DataLayer.js` into the project as `DataLayer.gs`
2. Merge `appsscript_additions.json` into `appsscript.json` (add BigQuery advanced service + oauth scope)
3. Replace `UrlFetchApp.fetch(vendorApiUrl)` calls with `Fleetio.getX()`, `HubSpot.getX()`, or `Xero.getX()`
4. Replace `populateSheet(name, url, ...)` calls with `populateSheetFromBQ(name, data)`

## BigQuery datasets created

| Dataset   | Tables                                    |
|-----------|-------------------------------------------|
| `fleetio` | `assets`, `contacts`, `issues`, `work_orders` |
| `hubspot` | `contacts`, `companies`, `deals`          |
| `xero`    | `invoices`, `contacts`, `accounts`, `payments` |

## Sync schedule (default)

| Source   | Frequency           | Rationale                        |
|----------|---------------------|----------------------------------|
| Fleetio  | Every 30 min, M–F   | Operational data, business hours |
| HubSpot  | Every 15 min        | Sales team needs fresh data      |
| Xero     | Every hour          | Tighter rate limits (60 req/min) |

Adjust cron expressions in `deploy.sh` to match your needs.

## Costs (rough estimates)

- **Cloud Run**: ~$0 (free tier: 2M requests/month, 360K vCPU-seconds)
- **Cloud Scheduler**: ~$0 (3 jobs free, $0.10/job/month after)
- **BigQuery storage**: ~$0.02/GB/month (active), free for <10GB
- **BigQuery queries**: Free (Apps Script BigQuery service uses your project's free 1TB/month query quota)
- **Secret Manager**: ~$0 (<6 secrets, <10K accesses/month free)

Total estimated cost for this setup: **< $1/month**
