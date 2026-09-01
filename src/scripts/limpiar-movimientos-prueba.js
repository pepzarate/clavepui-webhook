/**
 * Borra check_ins, huespedes_frecuentes, reportes_activos y (por FK)
 * check_ins_ediciones de prueba de UN hotel antes de que arranque su
 * operación real (cuando llega su gov_pui_clave aprobada).
 *
 * check_ins_ediciones.check_in_id referencia check_ins(id) sin
 * ON DELETE CASCADE, así que sus filas para el hotel se borran primero
 * (child antes que parent) o el DELETE de check_ins fallaría por FK.
 *
 * Uso: node src/scripts/limpiar-movimientos-prueba.js <hotel_id> [--confirmar]
 * Sin --confirmar hace dry-run: solo muestra cuántas filas se borrarían.
 */

require('dotenv').config();
const { pool, withHotelContext } = require('../db');

const [, , hotelIdArg, ...flags] = process.argv;
const confirmar = flags.includes('--confirmar');
const hotelId = Number.parseInt(hotelIdArg);

if (!hotelId) {
    console.error(
        '\n❌ Uso: node src/scripts/limpiar-movimientos-prueba.js <hotel_id> [--confirmar]\n' +
        '   Sin --confirmar corre en modo dry-run (no borra nada).\n'
    );
    process.exit(1);
}

async function main() {
    const hotel = await pool.query(
        'SELECT id, nombre, rfc, gov_pui_clave FROM hoteles WHERE id = $1',
        [hotelId]
    );

    if (hotel.rowCount === 0) {
        console.error(`❌ No existe ningún hotel con id=${hotelId}`);
        process.exit(1);
    }

    const h = hotel.rows[0];
    console.log(`\nHotel: ${h.nombre} (id=${hotelId}, rfc=${h.rfc})`);

    if (h.gov_pui_clave) {
        console.log(
            '⚠️  Este hotel YA tiene gov_pui_clave configurada — probablemente ya' +
            ' está en operación real. Confirma que de verdad quieres borrar sus' +
            ' movimientos antes de continuar.\n'
        );
    } else {
        console.log('(sin gov_pui_clave configurada — consistente con que aún no opera de verdad)\n');
    }

    const { checkinsCount, huespedesCount, reportesCount, edicionesCount } = await withHotelContext(hotelId, async (client) => {
        const checkins = await client.query(
            'SELECT COUNT(*) FROM check_ins WHERE hotel_id = $1', [hotelId]
        );
        const huespedes = await client.query(
            'SELECT COUNT(*) FROM huespedes_frecuentes WHERE hotel_id = $1', [hotelId]
        );
        const reportes = await client.query(
            'SELECT COUNT(*) FROM reportes_activos WHERE hotel_id = $1', [hotelId]
        );
        const ediciones = await client.query(
            'SELECT COUNT(*) FROM check_ins_ediciones WHERE hotel_id = $1', [hotelId]
        );
        return {
            checkinsCount: Number.parseInt(checkins.rows[0].count),
            huespedesCount: Number.parseInt(huespedes.rows[0].count),
            reportesCount: Number.parseInt(reportes.rows[0].count),
            edicionesCount: Number.parseInt(ediciones.rows[0].count),
        };
    });

    console.log(`check_ins a borrar:              ${checkinsCount}`);
    console.log(`huespedes_frecuentes a borrar:    ${huespedesCount}`);
    console.log(`reportes_activos a borrar:        ${reportesCount}`);
    console.log(`check_ins_ediciones a borrar:      ${edicionesCount}  (FK de check_ins, se borra antes)`);

    if (!confirmar) {
        console.log('\n(dry-run — vuelve a correr con --confirmar para borrar de verdad)\n');
        await pool.end();
        return;
    }

    await withHotelContext(hotelId, async (client) => {
        // check_ins_ediciones primero: FK a check_ins sin ON DELETE CASCADE.
        await client.query('DELETE FROM check_ins_ediciones WHERE hotel_id = $1', [hotelId]);
        await client.query('DELETE FROM check_ins WHERE hotel_id = $1', [hotelId]);
        await client.query('DELETE FROM huespedes_frecuentes WHERE hotel_id = $1', [hotelId]);
        await client.query('DELETE FROM reportes_activos WHERE hotel_id = $1', [hotelId]);
    });

    console.log(`\n✅ Borrado: ${checkinsCount} check-ins, ${huespedesCount} huéspedes frecuentes, ${reportesCount} reportes y ${edicionesCount} ediciones de "${h.nombre}"\n`);
    await pool.end();
}

main().catch(async (err) => {
    console.error('❌ Error:', err.message);
    await pool.end();
    process.exit(1);
});
