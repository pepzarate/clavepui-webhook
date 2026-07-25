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

// Pool separado para queries tenant-scoped (withHotelContext). Debe conectar
// con un rol SIN privilegios de superusuario/BYPASSRLS — si no, FORCE ROW
// LEVEL SECURITY no tiene ningún efecto y el aislamiento no se aplica de
// verdad (ver verificarRolTenantSeguro()).
const tenantPool = new Pool({
  connectionString: config.db.tenantConnectionString,
  ssl: config.db.ssl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

tenantPool.on('error', (err) => {
  logger.error('Error en tenantPool de PostgreSQL', { error: err.message });
});

/**
 * Verifica en cada arranque que el rol usado para queries tenant-scoped no
 * pueda saltarse RLS. Si puede (superusuario o BYPASSRLS), el aislamiento
 * multi-tenant es una ilusión aunque las policies existan — se corta el
 * arranque en vez de servir tráfico sin protección real.
 */
async function verificarRolTenantSeguro() {
  const { rows } = await tenantPool.query(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;`
  );
  const rol = rows[0];
  if (!rol || rol.rolsuper || rol.rolbypassrls) {
    throw new Error(
      'El rol de tenantPool puede saltarse Row Level Security ' +
      '(rolsuper o rolbypassrls = true). Configura DATABASE_URL_TENANT ' +
      'apuntando a un rol restringido — ver clavepui_tenant.'
    );
  }
}

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

    await client.query(`
      ALTER TABLE hoteles
      ADD COLUMN IF NOT EXISTS gov_pui_clave TEXT;
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS check_ins (
        id              SERIAL PRIMARY KEY,
        hotel_id        INTEGER NOT NULL REFERENCES hoteles(id),
        curp            TEXT NOT NULL,
        nombre          TEXT,
        primer_apellido TEXT,
        segundo_apellido TEXT,
        fecha_nacimiento TEXT,
        lugar_nacimiento TEXT,
        sexo_asignado   TEXT,
        telefono        TEXT,
        correo          TEXT,
        fecha_checkin   TIMESTAMPTZ DEFAULT NOW(),
        estado_pui      TEXT DEFAULT 'pendiente',
        intentos_pui    INTEGER DEFAULT 0,
        ultimo_error    TEXT,
        registrado_por  TEXT,
        creado_en       TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      ALTER TABLE check_ins
      ADD COLUMN IF NOT EXISTS numero_habitacion TEXT;
    `);

    await client.query(`
      ALTER TABLE check_ins
      ADD COLUMN IF NOT EXISTS folio_pms TEXT;
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_check_ins_folio_unico
      ON check_ins(hotel_id, folio_pms)
      WHERE folio_pms IS NOT NULL;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_check_ins_hotel_id
      ON check_ins(hotel_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_check_ins_curp
      ON check_ins(curp);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_check_ins_fecha
      ON check_ins(fecha_checkin);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id            SERIAL PRIMARY KEY,
        hotel_id      INTEGER NOT NULL REFERENCES hoteles(id),
        nombre        TEXT NOT NULL,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        rol           TEXT NOT NULL DEFAULT 'recepcionista',
        activo        BOOLEAN DEFAULT TRUE,
        creado_en     TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_usuarios_hotel_id
      ON usuarios(hotel_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_usuarios_email
      ON usuarios(email);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS huespedes_frecuentes (
        id                SERIAL PRIMARY KEY,
        hotel_id          INTEGER NOT NULL REFERENCES hoteles(id),
        curp              TEXT NOT NULL,
        nombre            TEXT,
        primer_apellido   TEXT,
        segundo_apellido  TEXT,
        fecha_nacimiento  TEXT,
        lugar_nacimiento  TEXT,
        sexo_asignado     TEXT,
        veces_hospedado   INTEGER NOT NULL DEFAULT 1,
        primera_visita    TIMESTAMPTZ DEFAULT NOW(),
        ultima_visita     TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_huespedes_frecuentes_hotel_curp
      ON huespedes_frecuentes(hotel_id, curp);
    `);

    // ── Row Level Security — aislamiento multi-tenant a nivel de BD ─────────
    // FORCE es necesario porque el rol de conexión es dueño de las tablas,
    // y Postgres exime a los dueños de RLS por defecto salvo que se fuerce.
    for (const tabla of ['check_ins', 'reportes_activos', 'usuarios', 'huespedes_frecuentes']) {
      await client.query(`ALTER TABLE ${tabla} ENABLE ROW LEVEL SECURITY;`);
      await client.query(`ALTER TABLE ${tabla} FORCE ROW LEVEL SECURITY;`);
      await client.query(`DROP POLICY IF EXISTS hotel_isolation ON ${tabla};`);
      await client.query(`
        CREATE POLICY hotel_isolation ON ${tabla}
        USING (
          current_setting('app.bypass_tenant_rls', true) = 'on'
          OR hotel_id = NULLIF(current_setting('app.current_hotel_id', true), '')::int
        )
        WITH CHECK (
          current_setting('app.bypass_tenant_rls', true) = 'on'
          OR hotel_id = NULLIF(current_setting('app.current_hotel_id', true), '')::int
        );
      `);
    }

    await verificarRolTenantSeguro();

    logger.info('Base de datos inicializada correctamente');
  } catch (err) {
    logger.error('Error inicializando base de datos', { error: err.message });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Ejecuta fn(client) dentro de una transacción con el contexto de tenant
 * seteado vía set_config(..., true) — local a la transacción, nunca se
 * filtra entre requests que reusan la misma conexión del pool.
 * Las policies de RLS de check_ins/usuarios/reportes_activos exigen este
 * contexto (o el de withAdminContext) para devolver filas.
 */
async function withHotelContext(hotelId, fn) {
  const client = await tenantPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_hotel_id', $1, true)`,
      [String(hotelId)]
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Igual que withHotelContext pero para operaciones legítimamente
 * cross-tenant (rutas /admin/*, alta de usuarios, login por email).
 * Protegido río arriba por x-admin-token o por ser el único punto de
 * entrada donde el hotel_id todavía no se conoce.
 */
async function withAdminContext(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.bypass_tenant_rls', 'on', true)`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, tenantPool, initDb, withHotelContext, withAdminContext };