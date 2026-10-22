/**
 * Diagnóstico de zona horaria y de nombres en check-ins. SOLO LECTURA
 * (transacción READ ONLY): no imprime nombres ni CURPs, solo tipos, horas y
 * conteos.
 *
 * En producción (desde clavepui-webhook/, con la CLI de Railway vinculada):
 *   railway run -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" PGSSL=1 node src/scripts/diagnostico-zona-horaria.js 1'
 * El argumento es el hotel_id a revisar (1 = Isabel en producción).
 *
 * Qué buscar:
 *   - fecha_checkin debe ser "timestamp with time zone". Si es "timestamp
 *     without time zone", la hora mostrada y el "hoy" dependen de la zona del
 *     proceso (TZ) y de la sesión de Postgres, y salen corridos.
 *   - tz_env: si el servicio de Railway tiene TZ definida.
 *   - "nombre sin primer apellido": registros que se verán como "Julio" en
 *     Últimos check-ins (checkin.astro permite registrar sin apellidos).
 */
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

const hotelId = Number.parseInt(process.argv[2] || '1', 10);

(async () => {
    const db = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.PGSSL ? { rejectUnauthorized: false } : false,
    });
    await db.connect();
    try {
        await db.query('BEGIN READ ONLY');
        await db.query(`SET LOCAL app.bypass_tenant_rls = 'on'`);
        const tipos = await db.query(
            `SELECT column_name, data_type FROM information_schema.columns
             WHERE table_name = 'check_ins' AND column_name IN ('fecha_checkin', 'creado_en')`
        );
        const zona = await db.query('SHOW timezone');
        console.log('Proceso:', {
            tz_env: process.env.TZ ?? null,
            zona_proceso: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        console.log('Postgres:', {
            sesion: zona.rows[0].TimeZone,
            ...Object.fromEntries(tipos.rows.map((r) => [r.column_name, r.data_type])),
        });

        const ult = await db.query(
            `SELECT id,
                    fecha_checkin::text AS valor_crudo,
                    to_char(fecha_checkin AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS si_es_tz_en_utc,
                    to_char(fecha_checkin AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD HH24:MI') AS si_es_tz_en_mx,
                    metodo_captura
             FROM check_ins WHERE hotel_id = $1
             ORDER BY id DESC LIMIT 10`,
            [hotelId]
        );
        console.log(`Últimos 10 check-ins del hotel ${hotelId} (sin datos personales):`);
        console.table(ult.rows);

        const nombres = await db.query(
            `SELECT COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE COALESCE(nombre, '') <> '' AND COALESCE(primer_apellido, '') = '') AS nombre_sin_primer_apellido,
                    COUNT(*) FILTER (WHERE metodo_captura IS NOT NULL AND COALESCE(nombre, '') <> '' AND COALESCE(primer_apellido, '') = '') AS de_checkin_nuevo_sin_primer_apellido,
                    COUNT(*) FILTER (WHERE COALESCE(primer_apellido, '') = '' AND COALESCE(segundo_apellido, '') <> '') AS solo_segundo_apellido
             FROM check_ins WHERE hotel_id = $1`,
            [hotelId]
        );
        console.log('Nombres:', nombres.rows[0]);
        await db.query('ROLLBACK');
    } finally {
        await db.end();
    }
})().catch((err) => {
    console.error('ERROR', err.message);
    process.exit(1);
});
