/**
 * Borra los datos del hotel de prueba "HOTEL PRUEBA CLAVEPUI" — y SOLO de
 * ese hotel: se identifica por su RFC ficticio, tiene que tener es_prueba =
 * TRUE y todo corre con el contexto RLS de ese hotel (no puede tocar otro).
 *
 * Por defecto solo cuenta lo que borraría (simulacro).
 *   --confirmar       borra check-ins, ediciones, huéspedes frecuentes y
 *                     reportes de búsqueda del hotel de prueba
 *   --incluir-hotel   además borra sus usuarios, suscripciones push y el hotel
 *
 * Local:       node src/scripts/borrar-datos-hotel-prueba.js [--confirmar] [--incluir-hotel]
 * Producción:  railway run -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" node src/scripts/borrar-datos-hotel-prueba.js --confirmar'
 */
const { conectar, buscarHotelPrueba, conContextoDelHotel } = require('./lib/hotelPrueba');

const TABLAS_DATOS = ['check_ins_ediciones', 'check_ins', 'huespedes_frecuentes', 'reportes_activos'];

/** Borra (o cuenta, si contar = true) los datos del hotel. Llamar dentro de conContextoDelHotel. */
async function borrarDatos(db, hotelId, { contar = false } = {}) {
    const resultado = {};
    for (const tabla of TABLAS_DATOS) {
        const r = contar
            ? await db.query(`SELECT COUNT(*)::int AS n FROM ${tabla} WHERE hotel_id = $1`, [hotelId])
            : await db.query(`DELETE FROM ${tabla} WHERE hotel_id = $1`, [hotelId]);
        resultado[tabla] = contar ? r.rows[0].n : r.rowCount;
    }
    return resultado;
}

async function main() {
    const confirmar = process.argv.includes('--confirmar');
    const incluirHotel = process.argv.includes('--incluir-hotel');
    const db = conectar();
    await db.connect();
    try {
        const hotel = await buscarHotelPrueba(db);
        if (!hotel) {
            console.log('No existe el hotel de prueba: nada que borrar.');
            return;
        }
        await conContextoDelHotel(db, hotel.id, async () => {
            const r = await borrarDatos(db, hotel.id, { contar: !confirmar });
            console.log(confirmar ? 'Borrado:' : 'Simulacro (usa --confirmar para borrar):', r);
            if (confirmar && incluirHotel) {
                await db.query(`DELETE FROM push_subscriptions WHERE hotel_id = $1`, [hotel.id]);
                const u = await db.query(`DELETE FROM usuarios WHERE hotel_id = $1`, [hotel.id]);
                console.log(`Usuarios borrados: ${u.rowCount}`);
            }
        });
        if (confirmar && incluirHotel) {
            await db.query(`DELETE FROM hoteles WHERE id = $1 AND es_prueba = TRUE`, [hotel.id]);
            console.log(`Hotel de prueba ${hotel.id} borrado.`);
        }
    } finally {
        await db.end();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error('ERROR:', err.message);
        process.exit(1);
    });
}

module.exports = { borrarDatos };
