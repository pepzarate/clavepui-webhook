/**
 * Común a los scripts del hotel de prueba (crear-hotel-prueba.js,
 * datos-hotel-prueba.js, borrar-datos-hotel-prueba.js).
 *
 * Seguridad:
 *   - El hotel se identifica por un RFC ficticio fijo y TIENE que tener
 *     es_prueba = TRUE; si no, los scripts se niegan a tocar nada.
 *   - Conexión propia (no los pools de la app): DATABASE_URL_TENANT apunta a
 *     la red privada de Railway y no se resuelve desde fuera. Pero todas las
 *     operaciones sobre tablas con RLS corren con el contexto de ESE hotel
 *     (app.current_hotel_id), nunca con el bypass de administrador: RLS
 *     garantiza que no se puede leer ni escribir otro hotel.
 *   - Nunca imprime contraseñas ni la pui_clave.
 */
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

const HOTEL_PRUEBA = {
    nombre: 'HOTEL PRUEBA CLAVEPUI',
    rfc: 'PRUEBA000000', // ficticio (12 caracteres), no es un RFC real
};

function conectar() {
    if (!process.env.DATABASE_URL) {
        throw new Error('Falta DATABASE_URL (en producción: DATABASE_URL="$DATABASE_PUBLIC_URL" dentro de railway run)');
    }
    const ssl = process.env.NODE_ENV === 'production' || process.env.PGSSL ? { rejectUnauthorized: false } : false;
    return new Client({ connectionString: process.env.DATABASE_URL, ssl });
}

/** El hotel de prueba, o null. Lanza si existe pero no está marcado como prueba. */
async function buscarHotelPrueba(db) {
    let r;
    try {
        r = await db.query(
            `SELECT id, nombre, rfc, es_prueba, checkin_v2, (gov_pui_clave IS NOT NULL) AS tiene_gov_clave
             FROM hoteles WHERE rfc = $1`,
            [HOTEL_PRUEBA.rfc]
        );
    } catch (err) {
        if (err.code === '42703') {
            throw new Error('La base todavía no tiene hoteles.es_prueba: despliega primero el backend (initDb la crea al arrancar).');
        }
        throw err;
    }
    const hotel = r.rows[0] ?? null;
    if (hotel && !hotel.es_prueba) {
        throw new Error(`El hotel con RFC ${HOTEL_PRUEBA.rfc} existe pero NO tiene es_prueba = TRUE: no se toca.`);
    }
    return hotel;
}

/** Corre fn(db) en una transacción con el contexto RLS del hotel dado. */
async function conContextoDelHotel(db, hotelId, fn) {
    await db.query('BEGIN');
    try {
        await db.query(`SELECT set_config('app.current_hotel_id', $1, true)`, [String(hotelId)]);
        const resultado = await fn(db);
        await db.query('COMMIT');
        return resultado;
    } catch (err) {
        await db.query('ROLLBACK');
        throw err;
    }
}

module.exports = { HOTEL_PRUEBA, conectar, buscarHotelPrueba, conContextoDelHotel };
