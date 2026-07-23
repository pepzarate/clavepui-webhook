/**
 * Borra check_ins y reportes_activos de prueba de UN hotel antes de que
 * arranque su operación real (cuando llega su gov_pui_clave aprobada).
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

    const { checkinsCount, reportesCount } = await withHotelContext(hotelId, async (client) => {
        const checkins = await client.query(
            'SELECT COUNT(*) FROM check_ins WHERE hotel_id = $1', [hotelId]
        );
        const reportes = await client.query(
            'SELECT COUNT(*) FROM reportes_activos WHERE hotel_id = $1', [hotelId]
        );
        return {
            checkinsCount: Number.parseInt(checkins.rows[0].count),
            reportesCount: Number.parseInt(reportes.rows[0].count),
        };
    });

    console.log(`check_ins a borrar:        ${checkinsCount}`);
    console.log(`reportes_activos a borrar: ${reportesCount}`);

    if (!confirmar) {
        console.log('\n(dry-run — vuelve a correr con --confirmar para borrar de verdad)\n');
        await pool.end();
        return;
    }

    await withHotelContext(hotelId, async (client) => {
        await client.query('DELETE FROM check_ins WHERE hotel_id = $1', [hotelId]);
        await client.query('DELETE FROM reportes_activos WHERE hotel_id = $1', [hotelId]);
    });

    console.log(`\n✅ Borrado: ${checkinsCount} check-ins y ${reportesCount} reportes de "${h.nombre}"\n`);
    await pool.end();
}

main().catch(async (err) => {
    console.error('❌ Error:', err.message);
    await pool.end();
    process.exit(1);
});
