/**
 * Pruebas de GET /alertas y /alertas/contador (tarea 6).
 *
 *   npm run test:alertas   (con el backend corriendo: Postgres; Redis no hace falta)
 *
 * Crea hoteles propios marcados es_prueba (A, C y D con enlace_simulado, B
 * sin enlace), así ninguna clave es real y el worker y el reencolador nunca
 * los tocan. Inserta check-ins, reportes y avisos inventados directo en la
 * BD y los borra al final. No llama a la PUI.
 */
require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { pool, withAdminContext, withHotelContext } = require('../src/db');
const { hotelEnlazado } = require('../src/utils/estadoPui');

const BASE_URL = process.env.TEST_URL || 'http://localhost:8080';
const ZONA = 'America/Mexico_City';
let fallas = 0;
function caso(nombre, ok, detalle = '') {
    if (!ok) fallas++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
}

const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: ZONA });

async function crearHotel(sufijo, enlaceSimulado) {
    const id = crypto.randomBytes(3).toString('hex').toUpperCase();
    const { rows } = await pool.query(
        `INSERT INTO hoteles (nombre, rfc, pui_clave, es_prueba, enlace_simulado)
         VALUES ($1, $2, $3, TRUE, $4) RETURNING id, nombre, pui_clave`,
        [`HOTEL ALERTAS ${sufijo}`, `TSA${id}${sufijo}`, `PruebaAlertas-${id}-${sufijo}`, enlaceSimulado]
    );
    const h = rows[0];
    const token = (rol) => jwt.sign({ sub: 0, email: `${rol}@local`, nombre: `${rol} prueba`, rol, hotel_id: h.id }, process.env.JWT_SECRET, { expiresIn: '10m' });
    h.recepcion = token('recepcionista');
    h.gerente = token('gerente');
    h.pui = jwt.sign({ sub: 'pui-gobierno', iss: 'clavepui', hotel_id: h.id }, process.env.JWT_SECRET, { expiresIn: '10m' });
    return h;
}

// CURP inventadas (formato válido para la BD; no hace falta verificador)
const curp = (n) => `ZZAL${String(800101 + n).padStart(6, '0')}HDFRRN${String(n % 10)}${n % 10}`;

async function checkIn(h, datos) {
    const { rows } = await withHotelContext(h.id, (c) => c.query(
        `INSERT INTO check_ins (hotel_id, curp, nombre, primer_apellido, numero_habitacion, fecha_checkin,
                                estado_pui, encolado_pui, registrado_por)
         VALUES ($1,$2,$3,'PRUEBA',$4, ($5::timestamp AT TIME ZONE $6), $7, TRUE, $8) RETURNING id`,
        [h.id, datos.curp, datos.nombre, datos.hab, `${datos.fecha ?? hoy()} ${datos.hora ?? '10:00'}`, ZONA,
            datos.estado ?? 'sin_reporte', datos.por ?? 'Ana Prueba']
    ));
    return rows[0].id;
}

async function reporte(h, id, curpReporte, { activo = true, busqueda = 'finalizada' } = {}) {
    await withHotelContext(h.id, (c) => c.query(
        `INSERT INTO reportes_activos (id, curp, nombre, hotel_id, activo, busqueda_estado, recibido_en)
         VALUES ($1, $2, 'PERSONA REPORTADA', $3, $4, $5, NOW() - interval '1 day')`,
        [id, curpReporte, h.id, activo, busqueda]
    ));
}

async function aviso(h, reporteId, checkInId, estado, { fase = 3, http = null, minutos = 0 } = {}) {
    await withAdminContext((c) => c.query(
        `INSERT INTO pui_notificaciones (hotel_id, reporte_id, fase, check_in_id, huella, estado, http_status, creado_en, actualizado_en)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + make_interval(mins => $8), NOW() + make_interval(mins => $8))`,
        [h.id, reporteId, fase, checkInId, fase === 3 ? crypto.randomUUID() : '', estado, http, minutos]
    ));
}

async function pedir(ruta, h, { rol = 'gerente', clave = null, sinAuth = false, token = null, metodo = 'GET', cuerpo } = {}) {
    const headers = sinAuth ? {} : { 'x-hotel-key': clave ?? h.pui_clave, Authorization: `Bearer ${token ?? h[rol]}` };
    if (cuerpo) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE_URL}${ruta}`, { method: metodo, headers, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: res.status, cuerpo: await res.json().catch(() => null) };
}

(async () => {
    const hoteles = [];
    try {
        const A = await crearHotel('A', true); hoteles.push(A);
        const B = await crearHotel('B', false); hoteles.push(B);
        const C = await crearHotel('C', true); hoteles.push(C);
        const D = await crearHotel('D', true); hoteles.push(D);
        const rid = (n) => `REP-ALERTAS-${A.id}-${n}-${'0'.repeat(30)}`; // 36+ caracteres, como los de la PUI

        // ── Hotel A: una coincidencia por camino y por estado del aviso ──
        const c = {
            enviado: await checkIn(A, { curp: curp(1), nombre: 'ELENA', hab: '101', hora: '09:00', estado: 'enviado', por: 'Luis Turno' }),
            pendiente: await checkIn(A, { curp: curp(2), nombre: 'PABLO', hab: '102', hora: '09:10', estado: 'pendiente' }),
            error: await checkIn(A, { curp: curp(3), nombre: 'ERIKA', hab: '103', hora: '09:20', estado: 'error' }),
            rechazado: await checkIn(A, { curp: curp(4), nombre: 'RUTH', hab: '104', hora: '09:30', estado: 'error' }),
            multiple: await checkIn(A, { curp: curp(5), nombre: 'MAURO', hab: '105', hora: '09:40', estado: 'enviado' }),
            fase1Viejo: await checkIn(A, { curp: curp(6), nombre: 'FELIPE', hab: '106', fecha: '2025-01-10' }),
            fase1Nuevo: await checkIn(A, { curp: curp(6), nombre: 'FELIPE', hab: '116', hora: '08:00' }),
            previo: await checkIn(A, { curp: curp(7), nombre: 'VICTOR', hab: '107', estado: 'enviado' }),
            sinAviso: await checkIn(A, { curp: curp(1), nombre: 'ELENA', hab: '201', hora: '07:00' }),
            cerrado: await checkIn(A, { curp: curp(10), nombre: 'CELIA', hab: '110', estado: 'enviado' }),
        };
        for (const n of [1, 2, 3, 4, 5, 6, 7]) await reporte(A, rid(n), curp(n));
        await reporte(A, rid(8), curp(8), { busqueda: 'error' });   // sin coincidencia, fin de búsqueda en error
        await reporte(A, rid(9), curp(9));                          // sin coincidencia
        await reporte(A, rid(10), curp(10), { activo: false });     // cerrado, con aviso enviado
        await aviso(A, rid(1), c.enviado, 'error', { minutos: -5 }); // primero falló…
        await aviso(A, rid(1), c.enviado, 'enviada', { http: 200 }); // …y luego se envió: cuenta una vez
        await aviso(A, rid(2), c.pendiente, 'enviando');
        await aviso(A, rid(3), c.error, 'error', { http: 503 });
        await aviso(A, rid(4), c.rechazado, 'rechazada', { fase: 2, http: 400 });
        await aviso(A, rid(5), c.multiple, 'multiple', { fase: 2, http: 300 });
        await aviso(A, rid(6), 0, 'enviada', { fase: 1, http: 200 });
        await aviso(A, rid(10), c.cerrado, 'enviada', { http: 200 });

        // ── Hotel B (sin enlace): mismos datos de una coincidencia ──
        const cb = await checkIn(B, { curp: curp(1), nombre: 'ELENA', hab: '101', estado: 'enviado' });
        await reporte(B, `REP-B-${B.id}-${'0'.repeat(32)}`, curp(1));
        await aviso(B, `REP-B-${B.id}-${'0'.repeat(32)}`, cb, 'enviada', { http: 200 });

        // ── Hotel D: reporte activo sin coincidencia ──
        await reporte(D, `REP-D-${D.id}-${'0'.repeat(32)}`, curp(20));

        console.log('\n── Acceso');
        let r = await pedir('/alertas', A, { sinAuth: true });
        caso('sin credenciales → 401', r.status === 401);
        r = await pedir('/alertas', A, { rol: 'recepcion', clave: B.pui_clave });
        caso('JWT de A con la x-hotel-key de B → 403', r.status === 403);
        r = await pedir('/alertas/contador', A, { rol: 'gerente', clave: B.pui_clave });
        caso('contador: JWT de A con la clave de B → 403', r.status === 403);
        r = await pedir('/alertas', A, { token: A.pui });
        caso('JWT de la PUI (no es staff) → 401', r.status === 401);

        console.log('\n── Criterio del contador (hotel A)');
        r = await pedir('/alertas/contador', A, { rol: 'recepcion' });
        caso('contador = 7 coincidencias + 1 fin de búsqueda con error = 8', r.status === 200 && r.cuerpo.contador === 8, JSON.stringify(r.cuerpo));
        caso('contador: solo { contador }', JSON.stringify(Object.keys(r.cuerpo)) === '["contador"]');
        const g = await pedir('/alertas', A, { rol: 'gerente' });
        caso('gerente: mismo contador que /alertas/contador', g.cuerpo.contador === 8);
        const por = Object.fromEntries(g.cuerpo.coincidencias.map((x) => [x.check_in_id, x]));
        caso('7 coincidencias', g.cuerpo.coincidencias.length === 7, String(g.cuerpo.coincidencias.length));
        caso('aviso con error y luego enviado: un solo par, gana el último (enviado)', por[c.enviado]?.aviso.estado === 'enviado'
            && g.cuerpo.coincidencias.filter((x) => x.check_in_id === c.enviado).length === 1);
        caso('fase 1 → el check-in más reciente de la CURP', Boolean(por[c.fase1Nuevo]) && !por[c.fase1Viejo]);
        caso('enviado de antes de la 4c (sin fila de aviso) cuenta, sin fecha', por[c.previo]?.aviso.estado === 'enviado' && por[c.previo]?.aviso.fecha_local === null);
        caso('check-in con la CURP del reporte pero sin aviso no cuenta', !por[c.sinAviso]);
        caso('reporte cerrado no cuenta', !por[c.cerrado]);

        console.log('\n── Estado de cada aviso');
        caso('enviando → pendiente, sin fecha', por[c.pendiente]?.aviso.estado === 'pendiente' && por[c.pendiente]?.aviso.fecha_local === null);
        caso('error → error, sin fecha', por[c.error]?.aviso.estado === 'error' && por[c.error]?.aviso.hora_local === null);
        caso('rechazada (400) → rechazado, con fecha', por[c.rechazado]?.aviso.estado === 'rechazado' && por[c.rechazado]?.aviso.fecha_local === hoy());
        caso('multiple (300) → multiple, con fecha', por[c.multiple]?.aviso.estado === 'multiple' && Boolean(por[c.multiple]?.aviso.hora_local));
        caso('enviada → enviado con fecha y hora local', por[c.enviado]?.aviso.fecha_local === hoy() && /^\d{2}:\d{2}$/.test(por[c.enviado]?.aviso.hora_local));
        const orden = g.cuerpo.coincidencias.map((x) => x.aviso.estado);
        caso('orden: rechazado y error primero, enviado al final', orden[0] === 'rechazado' && orden[1] === 'error' && orden[2] === 'pendiente'
            && orden.at(-1) === 'enviado', orden.join(','));

        console.log('\n── Detalle de Gerencia');
        const e = por[c.enviado];
        caso('coincidencia con huésped, habitación, hora local y quién registró',
            e.nombre === 'ELENA' && e.numero_habitacion === '101' && e.hora_local === '09:00' && e.fecha_local === hoy() && e.registrado_por === 'Luis Turno');
        caso('estado general: coincidencia', g.cuerpo.estado === 'coincidencia');
        caso('reportes activos: 9, CURP con solo 4 letras', g.cuerpo.reportes_activos.length === 9
            && g.cuerpo.reportes_activos.every((x) => /^[A-Z]{4}\*\*\*$/.test(x.curp)));
        caso('reportes activos sin nombre de la persona ni id', g.cuerpo.reportes_activos.every((x) => !('nombre' in x) && !('id' in x)));
        caso('reporte con fin de búsqueda en error marcado', g.cuerpo.reportes_activos.filter((x) => x.busqueda === 'error').length === 1);
        caso('reportes cerrados: 1, enmascarado', g.cuerpo.reportes_cerrados.length === 1 && g.cuerpo.reportes_cerrados[0].curp === 'ZZAL***' && g.cuerpo.total_cerrados === 1);
        const textoG = JSON.stringify(g.cuerpo);
        caso('ninguna CURP completa en la respuesta de Gerencia', ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10].some((n) => textoG.includes(curp(n))));
        caso('nombre de la persona reportada nunca sale', !textoG.includes('PERSONA REPORTADA'));
        caso('ids de reporte nunca salen', !textoG.includes('REP-ALERTAS'));

        console.log('\n── Recepción: solo conteo y estado (JSON completo)');
        const rr = await pedir('/alertas', A, { rol: 'recepcion' });
        console.log('     JSON de Recepción:', JSON.stringify(rr.cuerpo));
        caso('solo las llaves rol, estado y contador', JSON.stringify(Object.keys(rr.cuerpo).sort()) === '["contador","estado","rol"]');
        caso('estado requiere_atencion, contador 8', rr.cuerpo.estado === 'requiere_atencion' && rr.cuerpo.contador === 8);
        const textoR = JSON.stringify(rr.cuerpo);
        caso('sin nombres', !/ELENA|PABLO|ERIKA|RUTH|MAURO|FELIPE|VICTOR|PERSONA/.test(textoR));
        caso('sin habitaciones', !/\b1\d\d\b/.test(textoR.replace('"contador":8', '')));
        caso('sin CURP ni enmascarada', !/ZZAL|\*\*\*/.test(textoR));
        caso('sin fechas ni horas', !/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}/.test(textoR));
        caso('sin quién registró ni avisos', !/Luis|Ana Prueba|aviso|registrado/.test(textoR));

        console.log('\n── Estados de la pantalla');
        r = await pedir('/alertas', B, { rol: 'gerente' });
        caso('B sin enlace (de prueba sin enlace_simulado): no_enlazado, contador 0, sin detalle',
            r.cuerpo.estado === 'no_enlazado' && r.cuerpo.contador === 0 && !('coincidencias' in r.cuerpo), JSON.stringify(r.cuerpo));
        r = await pedir('/alertas/contador', B, { rol: 'recepcion' });
        caso('B: contador 0 aunque tenga un aviso', r.cuerpo.contador === 0);
        r = await pedir('/alertas', C, { rol: 'gerente' });
        caso('C enlazado sin reportes: sin_reportes', r.cuerpo.estado === 'sin_reportes' && r.cuerpo.contador === 0 && r.cuerpo.reportes_activos.length === 0);
        r = await pedir('/alertas', C, { rol: 'recepcion' });
        caso('C recepción: sin_coincidencias', r.cuerpo.estado === 'sin_coincidencias' && r.cuerpo.contador === 0);
        r = await pedir('/alertas', D, { rol: 'gerente' });
        caso('D reportes sin coincidencia: reportes_sin_coincidencia', r.cuerpo.estado === 'reportes_sin_coincidencia' && r.cuerpo.contador === 0
            && r.cuerpo.reportes_activos.length === 1 && r.cuerpo.coincidencias.length === 0);
        r = await pedir('/alertas', D, { rol: 'recepcion' });
        caso('D recepción: igual que sin coincidencias, sin la lista', JSON.stringify(r.cuerpo) === '{"rol":"recepcionista","estado":"sin_coincidencias","contador":0}');

        console.log('\n── Enlace simulado solo fuera de producción');
        const antes = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        const enProd = hotelEnlazado({ es_prueba: true, enlace_simulado: true, gov_pui_clave: null });
        process.env.NODE_ENV = antes;
        caso('en producción, enlace_simulado no cuenta', enProd === false);
        caso('fuera de producción sí cuenta', hotelEnlazado({ es_prueba: true, enlace_simulado: true }) === true);
        caso('de prueba con gov_pui_clave sigue sin enlace', hotelEnlazado({ es_prueba: true, gov_pui_clave: 'x' }) === false);
        caso('hotel real con gov_pui_clave: enlazado', hotelEnlazado({ es_prueba: false, gov_pui_clave: 'x' }) === true);

        console.log('\n── Cierre del reporte (POST /desactivar-reporte)');
        const des = await fetch(`${BASE_URL}/desactivar-reporte`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${A.pui}` }, body: JSON.stringify({ id: rid(9) }),
        });
        const fila = await withHotelContext(A.id, (cl) => cl.query(`SELECT activo, desactivado_en FROM reportes_activos WHERE hotel_id = $1 AND id = $2`, [A.id, rid(9)]));
        caso('desactivar guarda desactivado_en', des.status === 200 && fila.rows[0].activo === false && fila.rows[0].desactivado_en !== null, String(des.status));
        r = await pedir('/alertas', A, { rol: 'gerente' });
        caso('aparece en cerrados con fecha de cierre', r.cuerpo.reportes_cerrados[0]?.cerrado_local === hoy() && r.cuerpo.total_cerrados === 2);
    } catch (err) {
        fallas++;
        console.error('ERROR', err);
    } finally {
        const ids = hoteles.map((h) => h.id);
        await withAdminContext(async (cl) => {
            for (const t of ['pui_notificaciones', 'check_ins', 'reportes_activos']) await cl.query(`DELETE FROM ${t} WHERE hotel_id = ANY($1)`, [ids]);
        }).catch((e) => console.error('limpieza', e.message));
        await pool.query('DELETE FROM hoteles WHERE id = ANY($1)', [ids]).catch((e) => console.error('limpieza', e.message));
        console.log(`\n${fallas === 0 ? 'Todas las pruebas pasaron.' : `${fallas} prueba(s) fallaron.`}`);
        process.exit(fallas === 0 ? 0 : 1);
    }
})();
