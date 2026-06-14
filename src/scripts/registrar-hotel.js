/**
 * Script para registrar un nuevo hotel en la BD.
 * Uso: node src/scripts/registrar-hotel.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
});

// ── Datos del hotel a registrar — edita estos valores ─────────────────────────
const HOTEL = {
    nombre: 'HOTEL ISABEL SA DE CV',
    rfc: 'HIS410415V37',
    // La clave debe tener 16-20 chars, mayúscula, número y char especial
    // Esta es la clave que el representante legal registra en el portal PUI
    pui_clave: 'IsabelPUI2026!Sec',
};
// ─────────────────────────────────────────────────────────────────────────────

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