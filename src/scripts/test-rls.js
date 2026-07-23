/**
 * Prueba de validación de Row Level Security (RLS) multi-tenant.
 *
 * Demuestra que una query SIN filtro manual de hotel_id — exactamente el
 * bug que tenía puiQueue.js — no puede devolver datos de ningún hotel a
 * menos que el llamador haya pasado por withHotelContext/withAdminContext.
 *
 * Uso: node src/scripts/test-rls.js
 * No se integra a `npm test` — habla directo con Postgres, no con el
 * servidor HTTP.
 */

require('dotenv').config();
const { pool, initDb, withHotelContext, withAdminContext } = require('../db');

const TAG = 'RLSTEST';
let fallas = 0;

function check(label, condicion, detalle) {
    if (condicion) {
        console.log(`✅ ${label}`);
    } else {
        fallas++;
        console.log(`❌ ${label}${detalle ? ` — ${detalle}` : ''}`);
    }
}

async function obtenerOCrearHotel(nombre, rfc, pui_clave) {
    const existente = await pool.query('SELECT id FROM hoteles WHERE rfc = $1', [rfc]);
    if (existente.rowCount > 0) return existente.rows[0].id;

    const creado = await pool.query(
        `INSERT INTO hoteles (nombre, rfc, pui_clave) VALUES ($1, $2, $3) RETURNING id`,
        [nombre, rfc, pui_clave]
    );
    return creado.rows[0].id;
}

async function limpiar() {
    // Limpieza por prefijo — no toca datos reales de ningún hotel.
    await withAdminContext(async (client) => {
        await client.query(`DELETE FROM reportes_activos WHERE id LIKE $1`, [`${TAG}%`]);
        await client.query(`DELETE FROM check_ins WHERE registrado_por = $1`, [TAG]);
    });
}

async function main() {
    await initDb();

    console.log('\n── Preparando datos de prueba ──────────────────────────\n');

    // El pui_clave aquí solo se usa si el hotel no existe aún localmente
    // (obtenerOCrearHotel busca primero por RFC) — un valor de prueba
    // genérico es suficiente, no hace falta el pui_clave real del hotel.
    const isabelId = await obtenerOCrearHotel(
        'HOTEL ISABEL SA DE CV', 'HIS410415V37', 'RLSTEST-HIS410415V37-KEY'
    );
    const metropolId = await obtenerOCrearHotel(
        'COMPAÑIA HOTELERA EL AGUILA SA DE CV', 'HAG600912A21', 'RLSTEST-HAG600912A21-KEY'
    );
    console.log(`Hotel Isabel   id=${isabelId}`);
    console.log(`Hotel Metropol id=${metropolId}`);

    await limpiar(); // por si quedó algo de una corrida anterior interrumpida

    const reporteIsabelId = `${TAG}-isabel-${Date.now()}`;
    const reporteMetropolId = `${TAG}-metropol-${Date.now()}`;
    const curpIsabel = 'RLST900101HDFABC01';
    const curpMetropol = 'RLST900101MDFXYZ02';

    try {
        // Insertar un reporte activo por hotel, cada uno con su propio contexto.
        await withHotelContext(isabelId, (client) => client.query(
            `INSERT INTO reportes_activos (id, curp, nombre, hotel_id, activo)
       VALUES ($1, $2, 'PRUEBA RLS ISABEL', $3, TRUE)`,
            [reporteIsabelId, curpIsabel, isabelId]
        ));
        await withHotelContext(metropolId, (client) => client.query(
            `INSERT INTO reportes_activos (id, curp, nombre, hotel_id, activo)
       VALUES ($1, $2, 'PRUEBA RLS METROPOL', $3, TRUE)`,
            [reporteMetropolId, curpMetropol, metropolId]
        ));

        // Un check-in de prueba por hotel, mismo patrón.
        await withHotelContext(isabelId, (client) => client.query(
            `INSERT INTO check_ins (hotel_id, curp, nombre, registrado_por, estado_pui)
       VALUES ($1, $2, 'PRUEBA RLS ISABEL', $3, 'pendiente')`,
            [isabelId, curpIsabel, TAG]
        ));
        await withHotelContext(metropolId, (client) => client.query(
            `INSERT INTO check_ins (hotel_id, curp, nombre, registrado_por, estado_pui)
       VALUES ($1, $2, 'PRUEBA RLS METROPOL', $3, 'pendiente')`,
            [metropolId, curpMetropol, TAG]
        ));

        console.log('\n── Caso 1: query cruda, sin ningún contexto de tenant ──\n');
        console.log('(reproduce tal cual el bug original de puiQueue.js: sin BEGIN,');
        console.log(' sin set_config, pool.query directo con el mismo texto de query)\n');

        const sinContexto = await pool.query(
            `SELECT id, curp, hotel_id FROM reportes_activos WHERE id IN ($1, $2)`,
            [reporteIsabelId, reporteMetropolId]
        );
        check(
            'Sin contexto → 0 filas (fail-closed, no fuga de ningún hotel)',
            sinContexto.rowCount === 0,
            `devolvió ${sinContexto.rowCount} fila(s): ${JSON.stringify(sinContexto.rows)}`
        );

        console.log('\n── Caso 2: contexto = Hotel Isabel ─────────────────────\n');

        const comoIsabel = await withHotelContext(isabelId, (client) => client.query(
            `SELECT id, curp, hotel_id FROM reportes_activos WHERE id IN ($1, $2)`,
            [reporteIsabelId, reporteMetropolId]
        ));
        check(
            'Contexto Isabel → exactamente 1 fila',
            comoIsabel.rowCount === 1,
            `devolvió ${comoIsabel.rowCount} fila(s)`
        );
        check(
            'Contexto Isabel → la fila es de Isabel, no de Metropol',
            comoIsabel.rows[0]?.hotel_id === isabelId,
            `hotel_id devuelto: ${comoIsabel.rows[0]?.hotel_id}`
        );

        console.log('\n── Caso 3: contexto = Hotel Metropol ───────────────────\n');

        const comoMetropol = await withHotelContext(metropolId, (client) => client.query(
            `SELECT id, curp, hotel_id FROM reportes_activos WHERE id IN ($1, $2)`,
            [reporteIsabelId, reporteMetropolId]
        ));
        check(
            'Contexto Metropol → exactamente 1 fila',
            comoMetropol.rowCount === 1,
            `devolvió ${comoMetropol.rowCount} fila(s)`
        );
        check(
            'Contexto Metropol → la fila es de Metropol, no de Isabel',
            comoMetropol.rows[0]?.hotel_id === metropolId,
            `hotel_id devuelto: ${comoMetropol.rows[0]?.hotel_id}`
        );

        console.log('\n── Caso 4: contexto admin (bypass explícito) ───────────\n');

        const comoAdmin = await withAdminContext((client) => client.query(
            `SELECT id, curp, hotel_id FROM reportes_activos WHERE id IN ($1, $2)`,
            [reporteIsabelId, reporteMetropolId]
        ));
        check(
            'Contexto admin → ambas filas visibles (bypass funciona para admin)',
            comoAdmin.rowCount === 2,
            `devolvió ${comoAdmin.rowCount} fila(s)`
        );

        console.log('\n── Caso 5: check_ins — mismo patrón ────────────────────\n');

        const checkInsSinContexto = await pool.query(
            `SELECT hotel_id FROM check_ins WHERE registrado_por = $1`,
            [TAG]
        );
        check(
            'check_ins sin contexto → 0 filas',
            checkInsSinContexto.rowCount === 0,
            `devolvió ${checkInsSinContexto.rowCount} fila(s)`
        );

        const checkInsIsabel = await withHotelContext(isabelId, (client) => client.query(
            `SELECT hotel_id FROM check_ins WHERE registrado_por = $1`,
            [TAG]
        ));
        check(
            'check_ins contexto Isabel → solo el check-in de Isabel',
            checkInsIsabel.rowCount === 1 && checkInsIsabel.rows[0].hotel_id === isabelId,
            `devolvió ${JSON.stringify(checkInsIsabel.rows)}`
        );

    } finally {
        console.log('\n── Limpiando datos de prueba ───────────────────────────\n');
        await limpiar();
    }

    console.log('\n─────────────────────────────────────────────────────────');
    if (fallas === 0) {
        console.log('✅ Todas las pruebas de RLS pasaron.');
    } else {
        console.log(`❌ ${fallas} prueba(s) de RLS fallaron.`);
    }
    console.log('─────────────────────────────────────────────────────────\n');

    await pool.end();
    process.exit(fallas === 0 ? 0 : 1);
}

main().catch(async (err) => {
    console.error('\n❌ Error ejecutando la prueba de RLS:', err);
    try { await limpiar(); } catch { /* best effort */ }
    await pool.end();
    process.exit(1);
});
