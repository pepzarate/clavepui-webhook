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

    // Feature flag de la página /checkin-nuevo (rediseño del check-in con
    // OCR de INE), apagado por defecto. hoteles no tiene RLS y solo se lee
    // con pool (rol dueño), así que no necesita GRANT para clavepui_tenant.
    await client.query(`
      ALTER TABLE hoteles
      ADD COLUMN IF NOT EXISTS checkin_v2 BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    // Hotel de prueba (p. ej. "HOTEL PRUEBA CLAVEPUI" en producción, para
    // probar la interfaz con datos ficticios). Con TRUE: sus check-ins nunca
    // se encolan ni se notifican a la PUI, el reencolador y el worker lo
    // ignoran y POST /login (PUI gobierno) lo rechaza. Las métricas o
    // reportes entre hoteles deben filtrar NOT es_prueba.
    await client.query(`
      ALTER TABLE hoteles
      ADD COLUMN IF NOT EXISTS es_prueba BOOLEAN NOT NULL DEFAULT FALSE;
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

    // Bandeja de salida del aviso a la PUI: FALSE mientras el job no esté en
    // la cola de Redis (POST /check-ins inserta con FALSE y lo pone en TRUE
    // al encolar; si Redis no responde, el reencolador de puiQueue.js lo
    // reintenta). DEFAULT TRUE: las filas que ya existían se encolaron en su
    // momento. Sin GRANT nuevo: el GRANT de tabla de abajo cubre la columna.
    await client.query(`
      ALTER TABLE check_ins
      ADD COLUMN IF NOT EXISTS encolado_pui BOOLEAN NOT NULL DEFAULT TRUE;
    `);

    // Cómo se capturó la CURP (estadística de uso, sin datos personales):
    // 'ocr' (INE por cámara), 'qr', 'lector' (USB), 'frecuente' (huésped
    // frecuente) o 'manual'. NULL en los registros anteriores y en los de
    // checkin.astro, que no la manda. editado_tras_escaneo: si el
    // recepcionista corrigió algún campo autollenado antes de registrar.
    // Sin GRANT nuevo: el GRANT de tabla de abajo cubre las columnas.
    await client.query(`
      ALTER TABLE check_ins
      ADD COLUMN IF NOT EXISTS metodo_captura TEXT;
    `);
    await client.query(`
      ALTER TABLE check_ins
      ADD COLUMN IF NOT EXISTS editado_tras_escaneo BOOLEAN;
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'check_ins_metodo_captura_valido') THEN
          ALTER TABLE check_ins ADD CONSTRAINT check_ins_metodo_captura_valido
            CHECK (metodo_captura IS NULL OR metodo_captura IN ('ocr', 'qr', 'lector', 'frecuente', 'manual'));
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_check_ins_pendientes_encolar
      ON check_ins(hotel_id, creado_en)
      WHERE encolado_pui = FALSE;
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

    // Búsqueda de huéspedes por nombre sin importar acentos ("PEREZ" ↔
    // "Pérez"): la INE trae los nombres en mayúsculas sin acentos y la
    // captura manual puede traerlos. unaccent es extensión "trusted" desde
    // PG13 (basta con CREATE sobre la base; en Railway el rol es
    // superusuario). Si no se puede crear, no se corta el arranque: la
    // función de abajo cae a translate(), que cubre vocales con acento,
    // diéresis y Ñ.
    let hayUnaccent = false;
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS unaccent;`);
      hayUnaccent = true;
    } catch (err) {
      logger.warn('No se pudo crear la extensión unaccent; se usa translate()', { error: err.message });
    }
    // Envoltorio IMMUTABLE con el diccionario explícito: unaccent(text) sola
    // es STABLE, y así la función queda lista por si algún día se indexa.
    await client.query(`
      CREATE OR REPLACE FUNCTION clavepui_sin_acentos(texto TEXT) RETURNS TEXT
      LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
        ${hayUnaccent
          ? `SELECT public.unaccent('public.unaccent'::regdictionary, texto)`
          : `SELECT translate(texto, 'áéíóúüñÁÉÍÓÚÜÑàèìòùÀÈÌÒÙ', 'aeiouunAEIOUUNaeiouAEIOU')`}
      $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id           SERIAL PRIMARY KEY,
        hotel_id     INTEGER NOT NULL REFERENCES hoteles(id),
        usuario_id   INTEGER NOT NULL REFERENCES usuarios(id),
        endpoint     TEXT NOT NULL UNIQUE,
        keys_p256dh  TEXT NOT NULL,
        keys_auth    TEXT NOT NULL,
        creado_en    TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_hotel_id
      ON push_subscriptions(hotel_id);
    `);

    // Auditoría de ediciones a check-ins (solo folio_pms/numero_habitacion
    // son editables — nunca CURP ni datos de identidad del huésped).
    await client.query(`
      CREATE TABLE IF NOT EXISTS check_ins_ediciones (
        id              SERIAL PRIMARY KEY,
        check_in_id     INTEGER NOT NULL REFERENCES check_ins(id),
        hotel_id        INTEGER NOT NULL REFERENCES hoteles(id),
        campo           TEXT NOT NULL,
        valor_anterior  TEXT,
        valor_nuevo     TEXT,
        editado_por     TEXT NOT NULL,
        editado_en      TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_check_ins_ediciones_check_in_id
      ON check_ins_ediciones(check_in_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_check_ins_ediciones_hotel_id
      ON check_ins_ediciones(hotel_id);
    `);

    // ── Búsqueda de la PUI, fases 1 y 2 (tarea 4c, Manual Técnico sección 6.4) ──
    // Estado de la búsqueda histórica de cada reporte: 'pendiente' al llegar,
    // 'finalizada' cuando /busqueda-finalizada respondió 200, 'error' si se
    // agotaron los reintentos (el reencolador la vuelve a intentar).
    await client.query(`
      ALTER TABLE reportes_activos
        ADD COLUMN IF NOT EXISTS busqueda_estado TEXT NOT NULL DEFAULT 'pendiente',
        ADD COLUMN IF NOT EXISTS busqueda_intentada_en TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS busqueda_finalizada_en TIMESTAMPTZ;
    `);
    // Los reportes que ya existían cuando se agregó la columna se recibieron
    // antes de que hubiera fases 1 y 2: quedan 'pendiente' y el reencolador
    // los procesa (es lo que pide el manual para cualquier reporte activo).

    // La PUI manda el MISMO id de reporte a todas las instituciones (manual,
    // sección 6, paso 3). Con la llave solo en `id`, la activación del
    // segundo hotel chocaba con el reporte del primero (bajo RLS, error). La
    // llave pasa a (hotel_id, id). Solo si no hay filas sin hotel_id (las de
    // antes del multi-tenant); si las hay, se deja como está y se avisa.
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'reportes_activos'::regclass AND conname = 'reportes_activos_pkey'
            AND pg_get_constraintdef(oid) = 'PRIMARY KEY (id)'
        ) THEN
          IF EXISTS (SELECT 1 FROM reportes_activos WHERE hotel_id IS NULL) THEN
            RAISE WARNING 'reportes_activos tiene filas sin hotel_id: la llave sigue siendo solo (id)';
          ELSE
            ALTER TABLE reportes_activos ALTER COLUMN hotel_id SET NOT NULL;
            ALTER TABLE reportes_activos DROP CONSTRAINT reportes_activos_pkey;
            ALTER TABLE reportes_activos ADD CONSTRAINT reportes_activos_pkey PRIMARY KEY (hotel_id, id);
          END IF;
        END IF;
      END $$;
    `);

    // ON CONFLICT (hotel_id, id) en /activar-reporte funciona con cualquiera
    // de las dos llaves (si la migración de arriba no se pudo aplicar).
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reportes_activos_hotel_id_id
      ON reportes_activos (hotel_id, id);
    `);

    // Bitácora de avisos a la PUI (/notificar-coincidencia), por reporte,
    // fase y check-in. Hace idempotente el envío: un mismo check-in nunca se
    // notifica dos veces en la misma fase para el mismo reporte.
    //   check_in_id = 0 en la fase 1 (un único aviso por reporte).
    //   huella = '' en fases 1 y 2; en la fase 3 es el sha256 del contenido
    //   enviado, para que un registro MODIFICADO (manual: "registros nuevos o
    //   modificados") se vuelva a notificar y uno igual no.
    // estado: enviando | enviada (200) | multiple (300) | rechazada (400) | error
    // Sin datos personales: solo ids, fase, estado y código HTTP.
    await client.query(`
      CREATE TABLE IF NOT EXISTS pui_notificaciones (
        id             SERIAL PRIMARY KEY,
        hotel_id       INTEGER NOT NULL REFERENCES hoteles(id),
        reporte_id     TEXT NOT NULL,
        fase           SMALLINT NOT NULL CHECK (fase IN (1, 2, 3)),
        check_in_id    INTEGER NOT NULL DEFAULT 0,
        huella         TEXT NOT NULL DEFAULT '',
        estado         TEXT NOT NULL,
        http_status    INTEGER,
        intentos       INTEGER NOT NULL DEFAULT 0,
        ultimo_error   TEXT,
        creado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (hotel_id, reporte_id, fase, check_in_id, huella)
      );
    `);

    // En producción, DATABASE_URL (dueño de las tablas, usado para crearlas
    // arriba) y DATABASE_URL_TENANT (clavepui_tenant, usado por
    // withHotelContext) son roles DISTINTOS — Postgres no le da a
    // clavepui_tenant ningún permiso automático sobre tablas creadas por
    // otro rol. Sin este GRANT explícito, toda tabla tenant nueva falla en
    // producción con "permission denied" apenas withHotelContext la toca,
    // aunque en local pase inadvertido porque ahí ambos roles suelen ser el
    // mismo (DATABASE_URL_TENANT no está seteado → hace fallback a
    // DATABASE_URL). Nos pasó de verdad con huespedes_frecuentes y
    // push_subscriptions — ver commit de este fix.
    const { rowCount: tenantRoleExiste } = await client.query(
      `SELECT 1 FROM pg_roles WHERE rolname = 'clavepui_tenant'`
    );

    // ── Row Level Security — aislamiento multi-tenant a nivel de BD ─────────
    // FORCE es necesario porque el rol de conexión es dueño de las tablas,
    // y Postgres exime a los dueños de RLS por defecto salvo que se fuerce.
    for (const tabla of ['check_ins', 'reportes_activos', 'usuarios', 'huespedes_frecuentes', 'push_subscriptions', 'check_ins_ediciones', 'pui_notificaciones']) {
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

      if (tenantRoleExiste) {
        await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tabla} TO clavepui_tenant;`);
      }
    }

    // GRANT en una tabla NO incluye la secuencia de su columna SERIAL —
    // sin esto, INSERT falla con "permission denied for sequence ..._id_seq"
    // aunque el GRANT sobre la tabla esté bien. Nos volvió a pasar en
    // producción con huespedes_frecuentes/push_subscriptions justo después
    // de corregir el GRANT de tabla de arriba. "ALL SEQUENCES" cubre
    // cualquier tabla tenant futura con columna SERIAL sin tener que
    // adivinar el nombre de cada secuencia una por una.
    if (tenantRoleExiste) {
      await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO clavepui_tenant;`);
      // Las funciones traen EXECUTE para PUBLIC por defecto; explícito por
      // si alguien lo revoca (la usa GET /huespedes/buscar-por-nombre).
      await client.query(`GRANT EXECUTE ON FUNCTION clavepui_sin_acentos(TEXT) TO clavepui_tenant;`);
    }

    await verificarRolTenantSeguro();

    // Diagnóstico de zona horaria (2026-10-22): en producción "Últimos
    // check-ins" mostró horas corridas. Si fecha_checkin no es timestamptz,
    // la hora y el "hoy" dependen de la zona del proceso y de la sesión.
    const tipoFecha = await client.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'check_ins' AND column_name = 'fecha_checkin'`
    );
    const zonaBd = await client.query(`SHOW timezone`);
    logger.info('Zona horaria', {
      proceso: Intl.DateTimeFormat().resolvedOptions().timeZone,
      tz_env: process.env.TZ ?? null,
      sesion_bd: zonaBd.rows[0]?.TimeZone,
      fecha_checkin: tipoFecha.rows[0]?.data_type,
    });

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