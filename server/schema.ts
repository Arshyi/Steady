// Creates the Steady tables in Databricks and fills in the residents.
// Safe to run on every start: nothing is created or inserted twice.

import { sql, lit, SCHEMA } from './databricks.ts'

export interface ResidentSeed {
  id: string
  name: string
  room: string
  simDevice: string
  simFirmware: string
}

/** The wing's residents and the simulated device each one wears */
export const residentSeeds: ResidentSeed[] = [
  { id: '1', name: 'Margaret Ellis', room: '101', simDevice: 'ST-0412', simFirmware: '1.4.2' },
  { id: '2', name: 'Harold Brooks', room: '102', simDevice: 'ST-0388', simFirmware: '1.4.2' },
  { id: '3', name: 'Dorothy Kim', room: '103', simDevice: 'ST-0419', simFirmware: '1.4.2' },
  { id: '4', name: 'Walter Nguyen', room: '104', simDevice: 'ST-0371', simFirmware: '1.3.9' },
  { id: '5', name: 'Evelyn Carter', room: '105', simDevice: 'ST-0402', simFirmware: '1.4.2' },
  { id: '6', name: 'Frank Morales', room: '106', simDevice: 'ST-0395', simFirmware: '1.4.2' },
  { id: '7', name: 'Ruth Patel', room: '107', simDevice: 'ST-0407', simFirmware: '1.4.2' },
  { id: '8', name: 'George Hall', room: '108', simDevice: 'ST-0366', simFirmware: '1.3.9' },
]

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
    detail STRING, handled_at TIMESTAMP, source STRING)`)

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
 * Insert alerts. Each row is SQL for (resident_id, kind, raised_at, detail, handled_at, source).
 * Databricks can't call uuid() inside VALUES, so the IDs are added in a SELECT around it.
 */
export async function insertAlerts(rows: string[]) {
  if (!rows.length) return
  await sql(`INSERT INTO ${SCHEMA}.alerts
    SELECT uuid(), resident_id, kind, CAST(raised_at AS TIMESTAMP), detail, CAST(handled_at AS TIMESTAMP), source
    FROM VALUES ${rows.join(', ')} AS t(resident_id, kind, raised_at, detail, handled_at, source)`)
}

export type Mode = 'simulated' | 'device'

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
