const { Pool } = require('pg');
const config = require('../config');
const { logger } = require('../middleware/logger');

const pool = new Pool({
  connectionString: config.db.connectionString,
  ssl: config.db.ssl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error('Error en pool de PostgreSQL', { error: err.message });
});

/**
 * Crea las tablas si no existen.
 * Se ejecuta una vez al arrancar el servidor.
 */
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS hoteles (
        id            SERIAL PRIMARY KEY,
        nombre        TEXT NOT NULL,
        rfc           TEXT NOT NULL UNIQUE,
        pui_clave     TEXT NOT NULL UNIQUE,
        activo        BOOLEAN DEFAULT TRUE,
        creado_en     TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Tabla principal: reportes activos recibidos desde la PUI
    await client.query(`
      CREATE TABLE IF NOT EXISTS reportes_activos (
        id                TEXT PRIMARY KEY,
        curp              TEXT NOT NULL,
        nombre            TEXT,
        primer_apellido   TEXT,
        segundo_apellido  TEXT,
        fecha_nacimiento  TEXT,
        fecha_desaparicion TEXT,
        lugar_nacimiento  TEXT,
        sexo_asignado     TEXT,
        telefono          TEXT,
        correo            TEXT,
        raw_payload       JSONB,
        recibido_en       TIMESTAMPTZ DEFAULT NOW(),
        activo            BOOLEAN DEFAULT TRUE
      );
    `);
    await client.query(`
      ALTER TABLE reportes_activos
      ADD COLUMN IF NOT EXISTS hotel_id INTEGER REFERENCES hoteles(id);
    `);
    // Tabla de auditoría: registro legal de todas las interacciones
    await client.query(`
      CREATE TABLE IF NOT EXISTS logs_auditoria (
        id          SERIAL PRIMARY KEY,
        tipo        TEXT NOT NULL,
        endpoint    TEXT NOT NULL,
        ip_origen   TEXT,
        status_code INTEGER,
        mensaje     TEXT,
        creado_en   TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    logger.info('Base de datos inicializada correctamente');
  } catch (err) {
    logger.error('Error inicializando base de datos', { error: err.message });
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb };