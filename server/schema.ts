// Creates the Steady tables in Databricks and fills in the residents.
// Safe to run on every start: nothing is created or inserted twice.

import { sql, lit, SCHEMA } from './databricks.ts'
import { residentSeeds } from './residents.ts'
import type { Mode } from './types.ts'

export type { Mode } from './types.ts'

export async function setupSchema() {
  await sql(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)

  await sql(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.residents (
    resident_id STRING, name STRING, room STRING, sim_device_id STRING)`)

  // Every device we've seen, simulated or real
  await sql(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.devices (
    device_id STRING, firmware STRING, kind STRING, registered_at TIMESTAMP)`)

  // Which real device each resident wears (simulated devices are fixed in residents.sim_device_id)
  await sql(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.pairings (
    resident_id STRING, device_id STRING, paired_at TIMESTAMP)`)

  // One row per device every few seconds: a summary of the gyroscope and accelerometer
  await sql(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.readings (
    ts TIMESTAMP, resident_id STRING, device_id STRING, source STRING,
    movement DOUBLE COMMENT '0-100, from gyroscope activity',
    gyro_dps DOUBLE COMMENT 'mean gyroscope magnitude, degrees per second',
    accel_g DOUBLE COMMENT 'mean acceleration magnitude, g',
    heart_rate INT, battery INT, rssi INT)`)

  await sql(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.alerts (
    alert_id STRING, resident_id STRING, kind STRING, raised_at TIMESTAMP,
    detail STRING, handled_at TIMESTAMP, source STRING, handled_by STRING)`)

  // Tables created before handled_by existed need the column adding once
  await sql(`ALTER TABLE ${SCHEMA}.alerts ADD COLUMNS (handled_by STRING)`).catch(() => {})

  await sql(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.app_settings (key STRING, value STRING)`)

  const [{ n }] = await sql(`SELECT count(*) AS n FROM ${SCHEMA}.residents`)
  if (Number(n) === 0) {
    await sql(`INSERT INTO ${SCHEMA}.residents VALUES ${residentSeeds
      .map((r) => `(${lit(r.id)}, ${lit(r.name)}, ${lit(r.room)}, ${lit(r.simDevice)})`)
      .join(', ')}`)
    await sql(`INSERT INTO ${SCHEMA}.devices VALUES ${residentSeeds
      .map((r) => `(${lit(r.simDevice)}, ${lit(r.simFirmware)}, 'simulated', current_timestamp())`)
      .join(', ')}`)
  }
}

/**
 * Insert alerts. Each row is SQL for (resident_id, kind, raised_at, detail, handled_at, source, handled_by).
 * Databricks can't call uuid() inside VALUES, so the IDs are added in a SELECT around it.
 */
export async function insertAlerts(rows: string[]) {
  if (!rows.length) return
  await sql(`INSERT INTO ${SCHEMA}.alerts
    SELECT uuid(), resident_id, kind, CAST(raised_at AS TIMESTAMP), detail, CAST(handled_at AS TIMESTAMP), source, handled_by
    FROM VALUES ${rows.join(', ')} AS t(resident_id, kind, raised_at, detail, handled_at, source, handled_by)`)
}

export async function loadMode(): Promise<Mode> {
  const rows = await sql(`SELECT value FROM ${SCHEMA}.app_settings WHERE key = 'mode'`)
  return rows[0]?.value === 'device' ? 'device' : 'simulated'
}

export async function saveMode(mode: Mode) {
  await sql(
    `MERGE INTO ${SCHEMA}.app_settings t USING (SELECT 'mode' AS key, :mode AS value) s ON t.key = s.key
     WHEN MATCHED THEN UPDATE SET value = s.value WHEN NOT MATCHED THEN INSERT *`,
    { mode },
  )
}
