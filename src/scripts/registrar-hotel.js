/**
 * Script para registrar un nuevo hotel en la BD.
 * Uso: node src/scripts/registrar-hotel.js "<nombre>" "<rfc>" "<pui_clave>"
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
});

const [, , nombre, rfc, pui_clave] = process.argv;

const HOTEL = { nombre, rfc, pui_clave };

if (!HOTEL.nombre || !HOTEL.rfc || !HOTEL.pui_clave) {
    console.error(
        '\n❌ Uso: node src/scripts/registrar-hotel.js "<nombre>" "<rfc>" "<pui_clave>"\n' +
        '   pui_clave: 16-20 chars, mayúscula, número y char especial —\n' +
        '   es la clave que el representante legal registra en el portal PUI.\n'
    );
    process.exit(1);
}

async function registrar() {
    const client = await pool.connect();
    try {
        const result = await client.query(
            `INSERT INTO hoteles (nombre, rfc, pui_clave)
       VALUES ($1, $2, $3)
       ON CONFLICT (rfc) DO UPDATE SET
         nombre    = $1,
         pui_clave = $3,
         activo    = TRUE
       RETURNING id, nombre, rfc`,
            [HOTEL.nombre, HOTEL.rfc, HOTEL.pui_clave]
        );

        const hotel = result.rows[0];
        console.log('\n✅ Hotel registrado correctamente:');
        console.log(`   ID:        ${hotel.id}`);
        console.log(`   Nombre:    ${hotel.nombre}`);
        console.log(`   RFC:       ${hotel.rfc}`);
        console.log(`\n📋 Datos para registrar en el portal PUI:`);
        console.log(`   URL base:  https://api.clavepui.com`);
        console.log(`   Usuario:   PUI`);
        console.log(`   Clave:     ${HOTEL.pui_clave}`);
        console.log('\n');

    } catch (err) {
        console.error('❌ Error registrando hotel:', err.message);
    } finally {
        client.release();
        pool.end();
    }
}

registrar();