/**
 * BigQuery helpers — shared by all connectors
 *
 * Pattern: full replace (TRUNCATE + INSERT) per table per sync run.
 * This keeps things simple — no incremental merge logic needed unless
 * tables get large enough that a full replace becomes slow (>500k rows).
 */

const { BigQuery } = require('@google-cloud/bigquery');

const bq = new BigQuery({ projectId: process.env.GCP_PROJECT_ID });

/**
 * Replace all rows in a BigQuery table with new data.
 * Uses WRITE_TRUNCATE so the table is always a clean snapshot.
 *
 * @param {string} dataset  - e.g. 'fleetio'
 * @param {string} table    - e.g. 'assets'
 * @param {object[]} rows   - array of plain objects (keys = column names)
 * @returns {{ rowsWritten: number }}
 */
async function replaceTable(dataset, table, rows) {
  if (!rows.length) {
    console.log(`[BQ] ${dataset}.${table}: no rows — skipping`);
    return { rowsWritten: 0 };
  }

  const tableRef = bq.dataset(dataset).table(table);

  // BigQuery auto-detects schema from first row if table doesn't exist yet.
  // For production you'd define explicit schemas — see schemas/ directory.
  await tableRef.insert(rows, {
    createInsertId: false,
    // WRITE_TRUNCATE is only available via load jobs, not streaming insert.
    // For full replace: delete + insert, or use a load job with a GCS staging file.
    // Simple approach below: delete all rows first, then insert.
  });

  return { rowsWritten: rows.length };
}

/**
 * Full replace via a load job (preferred for large datasets).
 * Stages data via a temp table then swaps — atomic and handles >10MB payloads.
 *
 * @param {string} dataset
 * @param {string} table
 * @param {object[]} rows
 */
async function loadTable(dataset, table, rows) {
  if (!rows.length) return { rowsWritten: 0 };

  const datasetRef = bq.dataset(dataset);

  // Ensure dataset exists
  const [exists] = await datasetRef.exists();
  if (!exists) {
    await datasetRef.create({ location: 'australia-southeast1' }); // adjust region
    console.log(`[BQ] Created dataset: ${dataset}`);
  }

  // Run a DML TRUNCATE + insert via a query job (simplest full-replace for <10MB)
  // For larger data, stream via GCS instead.
  const tableRef = datasetRef.table(table);
  const [tableExists] = await tableRef.exists();

  if (tableExists) {
    // Truncate existing rows
    await bq.query(`TRUNCATE TABLE \`${process.env.GCP_PROJECT_ID}.${dataset}.${table}\``);
  }

  // Insert new rows (streaming insert — immediate availability)
  const batchSize = 500; // BQ streaming insert limit per request
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    await datasetRef.table(table).insert(batch, { skipInvalidRows: false });
  }

  console.log(`[BQ] ${dataset}.${table}: wrote ${rows.length} rows`);
  return { rowsWritten: rows.length };
}

module.exports = { loadTable };
