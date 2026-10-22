/**
 * Pruebas de lo que agregó la tarea 2 de check-in v2 (2026-10-17):
 *   - folio duplicado en envíos simultáneos → 201 + 409, nunca 500;
 *   - GET /check-ins/curp-activa (aviso antes de registrar, aislado por hotel);
 *   - búsqueda de huéspedes por nombre sin acentos;
 *   - GET /health/estado (forma de la respuesta y niveles);
 *   - (tarea 2b, 2026-10-19) POST /check-ins con Redis caído: 201 en < 3 s,
 *     queda pendiente y se encola UNA sola vez al volver Redis;
 *   - (tarea 3, 2026-10-19) metodo_captura y editado_tras_escaneo;
 *   - (tarea 4a, 2026-10-22) hora local cerca de la medianoche y hotel de
 *     prueba (es_prueba): nunca se encola ni llega a la PUI.
 *
 * Requiere el servidor corriendo con Postgres y Redis (POST /check-ins
 * encola en BullMQ): `node tests/test-checkin-v2.js` desde la raíz del repo.
 * Base URL: TEST_URL (default http://localhost:8080).
 *
 * La parte de Redis caído necesita poder apagarlo y prenderlo:
 *   TEST_REDIS_PARAR="docker stop <contenedor>"
 *   TEST_REDIS_LEVANTAR="docker start <contenedor>"
 * Sin esas dos variables se omite (SKIP). Conviene arrancar el servidor con
 * PUI_REENCOLAR_INTERVALO_MS y PUI_REENCOLAR_GRACIA_MS cortos (p. ej. 5000
 * y 2000) para no esperar el minuto de producción.
 *
 * Crea DOS hoteles de prueba propios (no toca los reales) y al final borra
 * todo lo que creó, pase o falle. Firma JWT de staff con el JWT_SECRET del
 * entorno (nunca lo imprime).
 */
require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { execSync } = require('node:child_process');
const { pool, withAdminContext, withHotelContext } = require('../src/db');
const { clasificar } = require('../src/services/estadoSistema');
const { puiQueue, jobIdDe, reencolarPendientes } = require('../src/services/puiQueue');
const { urlSinDatosPersonales } = require('../src/middleware/logger');

const BASE_URL = process.env.TEST_URL || 'http://localhost:8080';
const CURP_A = 'ZEMR850315HDFNRS06'; // inventado (estructura y verificador válidos)
const CURP_B = 'PEGJ900101HDFRRN05'; // inventado, solo formato

let fallas = 0;
function caso(nombre, ok, detalle = '') {
    if (!ok) fallas++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
}

async function http(metodo, ruta, { hotel, jwtDe, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (hotel) headers['x-hotel-key'] = hotel.pui_clave;
    if (jwtDe) headers.Authorization = `Bearer ${jwtDe.token}`;
    const res = await fetch(`${BASE_URL}${ruta}`, {
        method: metodo, headers, body: body ? JSON.stringify(body) : undefined,
    });
    let datos = {};
    try { datos = await res.json(); } catch { /* sin cuerpo */ }
    return { status: res.status, datos };
}

async function crearHotel(sufijo, { esPrueba = false } = {}) {
    const id = crypto.randomBytes(4).toString('hex').toUpperCase();
    const { rows } = await pool.query(
        `INSERT INTO hoteles (nombre, rfc, pui_clave, es_prueba) VALUES ($1, $2, $3, $4)
         RETURNING id, nombre, pui_clave`,
        [`PRUEBA V2 ${sufijo}`, `TST${id}${sufijo}`, `PruebaV2-${id}-${sufijo}`, esPrueba]
    );
    const hotel = rows[0];
    hotel.token = jwt.sign(
        { sub: 0, email: 'prueba@local', nombre: 'Prueba V2', rol: 'recepcionista', hotel_id: hotel.id },
        process.env.JWT_SECRET, { expiresIn: '10m' }
    );
    return hotel;
}

async function limpiar(hoteles) {
    const ids = hoteles.map((h) => h.id);
    if (ids.length === 0) return;
    // Espera a que el worker de la PUI termine con los jobs de estos check-ins
    // (los marca sin_reporte) para no dejarle filas a medio borrar.
    await new Promise((r) => setTimeout(r, 1500));
    await withAdminContext(async (c) => {
        await c.query('DELETE FROM check_ins_ediciones WHERE hotel_id = ANY($1)', [ids]);
        await c.query('DELETE FROM check_ins WHERE hotel_id = ANY($1)', [ids]);
        await c.query('DELETE FROM huespedes_frecuentes WHERE hotel_id = ANY($1)', [ids]);
    });
    await pool.query('DELETE FROM hoteles WHERE id = ANY($1)', [ids]);
}

function checkIn(hotel, datos) {
    return http('POST', '/check-ins', { hotel, body: { registrado_por: 'prueba', ...datos } });
}

async function pruebasFolio(a) {
    console.log('\n── Folio duplicado');
    const folio = `F-${Date.now()}`;
    const envios = await Promise.all(
        Array.from({ length: 6 }, (_, i) => checkIn(a, { curp: CURP_A, numero_habitacion: `10${i}`, folio_pms: folio }))
    );
    const estados = envios.map((r) => r.status).sort();
    caso('6 envíos simultáneos con el mismo folio: uno 201, los demás 409',
        estados.filter((s) => s === 201).length === 1 && estados.filter((s) => s === 409).length === 5,
        `estados ${estados.join(',')}`);
    caso('ningún 500', !estados.includes(500));
    caso('el 409 trae el mensaje de siempre',
        envios.find((r) => r.status === 409)?.datos.error === 'Folio ya registrado para este hotel');

    const secuencial = await checkIn(a, { curp: CURP_A, folio_pms: folio });
    caso('envío posterior con el mismo folio → 409 (verificación previa)', secuencial.status === 409);

    // Edición: llevar otro check-in al folio ya usado
    const otro = await checkIn(a, { curp: CURP_A, folio_pms: `${folio}-B` });
    const edicion = await http('POST', `/check-ins/${otro.datos.checkin?.id}/editar`,
        { hotel: a, jwtDe: a, body: { folio_pms: folio } });
    caso('editar a un folio ya usado → 409', edicion.status === 409, `status ${edicion.status}`);
}

async function pruebasCurpActiva(a, b) {
    console.log('\n── GET /check-ins/curp-activa');
    const ruta = (curp) => `/check-ins/curp-activa?curp=${encodeURIComponent(curp)}`;

    let r = await http('GET', ruta(CURP_B), { hotel: a, jwtDe: a });
    caso('CURP sin check-in hoy → activa:false', r.status === 200 && r.datos.activa === false && r.datos.habitacion === null);

    await checkIn(a, { curp: CURP_B, numero_habitacion: '204' });
    await checkIn(a, { curp: CURP_B, numero_habitacion: '312' });
    r = await http('GET', ruta(CURP_B), { hotel: a, jwtDe: a });
    caso('con check-ins hoy → activa:true, habitación del más reciente, total',
        r.status === 200 && r.datos.activa === true && r.datos.habitacion === '312' && r.datos.total_hoy === 2,
        JSON.stringify(r.datos));
    r = await http('GET', ruta(CURP_B.toLowerCase()), { hotel: a, jwtDe: a });
    caso('acepta la CURP en minúsculas', r.status === 200 && r.datos.activa === true);

    r = await http('GET', ruta(CURP_B), { hotel: b, jwtDe: b });
    caso('otro hotel no ve esos check-ins', r.status === 200 && r.datos.activa === false && r.datos.habitacion === null);

    r = await http('GET', ruta('NO-ES-CURP'), { hotel: a, jwtDe: a });
    caso('CURP inválida → 400', r.status === 400);
    r = await http('GET', ruta(CURP_B), { hotel: a });
    caso('sin JWT de staff → 401', r.status === 401);
    r = await http('GET', ruta(CURP_B), { hotel: a, jwtDe: b });
    caso('JWT de otro hotel → 403', r.status === 403);

    const post = await checkIn(a, { curp: CURP_B });
    caso('POST /check-ins sigue devolviendo aviso_curp_duplicada', post.status === 201 && post.datos.aviso_curp_duplicada === true);
}

async function pruebasSinAcentos(a, b) {
    console.log('\n── Búsqueda por nombre sin acentos');
    await checkIn(a, { curp: 'MUPJ800101HDFXXX01', nombre: 'José', primer_apellido: 'Pérez', segundo_apellido: 'Muñoz' });
    await checkIn(a, { curp: 'GOAM900101MDFXXX02', nombre: 'MARTHA', primer_apellido: 'GOMEZ', segundo_apellido: 'RAMIREZ' });
    const buscar = (hotel, q) => http('GET', `/huespedes/buscar-por-nombre?nombre=${encodeURIComponent(q)}`, { hotel });
    const curps = (r) => (r.datos.resultados || []).map((h) => h.curp);

    caso('"PEREZ" encuentra "Pérez"', curps(await buscar(a, 'PEREZ')).includes('MUPJ800101HDFXXX01'));
    caso('"jose perez" encuentra "José Pérez"', curps(await buscar(a, 'jose perez')).includes('MUPJ800101HDFXXX01'));
    caso('"munoz" encuentra "Muñoz"', curps(await buscar(a, 'munoz')).includes('MUPJ800101HDFXXX01'));
    caso('"Gómez" encuentra "GOMEZ"', curps(await buscar(a, 'Gómez')).includes('GOAM900101MDFXXX02'));
    caso('"Ramírez" encuentra "RAMIREZ"', curps(await buscar(a, 'Ramírez')).includes('GOAM900101MDFXXX02'));
    caso('los comodines siguen siendo texto literal ("%")', curps(await buscar(a, '%%')).length === 0);
    caso('otro hotel no ve esos huéspedes', curps(await buscar(b, 'perez')).length === 0);
}

async function pruebasEstado() {
    console.log('\n── GET /health/estado');
    const r = await http('GET', '/health/estado');
    const d = r.datos;
    caso('responde 200 con los campos de siempre (operativo, db, cola)',
        r.status === 200 && typeof d.operativo === 'boolean' && ['ok', 'error'].includes(d.db) && ['ok', 'error'].includes(d.cola));
    caso('trae nivel, causas, latencias, ocr y umbral',
        ['operativo', 'degradado', 'error'].includes(d.nivel) && Array.isArray(d.causas)
        && 'db' in d.latencia_ms && 'cola' in d.latencia_ms && 'ocr' in d.latencia_ms
        && ['ok', 'error', 'no_configurado'].includes(d.ocr) && typeof d.umbral_lento_ms === 'number',
        JSON.stringify(d));

    const ok = (ms) => ({ estado: 'ok', ms });
    const caido = { estado: 'error', ms: null };
    let c = clasificar(ok(5), ok(5), ok(5), 1000);
    caso('todo bien → operativo', c.nivel === 'operativo' && c.causas.length === 0 && c.operativo === true);
    c = clasificar(ok(1500), ok(5), ok(5), 1000);
    caso('base lenta → degradado (db lento)', c.nivel === 'degradado' && c.causas[0].servicio === 'db' && c.causas[0].motivo === 'lento');
    c = clasificar(ok(5), caido, ok(5), 1000);
    caso('Redis caído → degradado, operativo:false como antes', c.nivel === 'degradado' && c.operativo === false && c.causas[0].servicio === 'cola');
    c = clasificar(ok(5), ok(5), caido, 1000);
    caso('OCR caído → degradado (ocr no_disponible), operativo:true', c.nivel === 'degradado' && c.operativo === true && c.causas[0].motivo === 'no_disponible');
    c = clasificar(ok(5), ok(5), { estado: 'no_configurado', ms: null }, 1000);
    caso('OCR sin configurar → degradado', c.nivel === 'degradado' && c.causas[0].motivo === 'no_configurado');
    c = clasificar(caido, ok(5), ok(5), 1000);
    caso('base caída → error', c.nivel === 'error' && c.db === 'error' && c.causas[0].servicio === 'db');
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function esperarHasta(condicion, timeoutMs, pasoMs = 500) {
    const fin = Date.now() + timeoutMs;
    while (Date.now() < fin) {
        if (await condicion()) return true;
        await esperar(pasoMs);
    }
    return false;
}

async function filaCheckIn(hotel, id) {
    const r = await withHotelContext(hotel.id, (c) => c.query(
        'SELECT encolado_pui, estado_pui, intentos_pui FROM check_ins WHERE id = $1', [id]));
    return r.rows[0];
}

async function pruebasMetodoCaptura(a) {
    console.log('\n── metodo_captura / editado_tras_escaneo');
    const fila = async (id) => (await withHotelContext(a.id, (c) => c.query(
        'SELECT metodo_captura, editado_tras_escaneo FROM check_ins WHERE id = $1', [id]))).rows[0];

    for (const metodo of ['ocr', 'qr', 'lector', 'frecuente', 'manual']) {
        const r = await checkIn(a, { curp: CURP_A, metodo_captura: metodo, editado_tras_escaneo: metodo === 'ocr' });
        const f = r.status === 201 ? await fila(r.datos.checkin.id) : null;
        caso(`acepta y guarda metodo_captura '${metodo}'`,
            f?.metodo_captura === metodo && f.editado_tras_escaneo === (metodo === 'ocr'), JSON.stringify(f));
    }
    const sin = await checkIn(a, { curp: CURP_A });
    caso('sin los campos (como checkin.astro) → 201 y ambos NULL',
        sin.status === 201 && JSON.stringify(await fila(sin.datos.checkin.id)) === '{"metodo_captura":null,"editado_tras_escaneo":null}');
    const malo = await checkIn(a, { curp: CURP_A, metodo_captura: 'camara' });
    caso('metodo_captura desconocido → 400', malo.status === 400, JSON.stringify(malo.datos));
    const maloBool = await checkIn(a, { curp: CURP_A, metodo_captura: 'qr', editado_tras_escaneo: 'si' });
    caso('editado_tras_escaneo no booleano → 400', maloBool.status === 400);
    let rechazado = false;
    try {
        await withHotelContext(a.id, (c) => c.query(`UPDATE check_ins SET metodo_captura = 'camara' WHERE id = $1`, [sin.datos.checkin.id]));
    } catch (err) {
        rechazado = err.code === '23514';
    }
    caso('el CHECK de la BD rechaza valores fuera de la lista', rechazado);
}

const ZONA = 'America/Mexico_City';

async function pruebasMedianoche(m) {
    console.log('\n── Hora local cerca de la medianoche (hotel sin otros check-ins)');
    // 00:01 de hoy y 23:59 de ayer, hora de México, calculados en SQL
    const ins = (expr, curp, hab) => withHotelContext(m.id, (c) => c.query(
        `INSERT INTO check_ins (hotel_id, curp, numero_habitacion, estado_pui, encolado_pui, fecha_checkin)
         VALUES ($1, $2, $3, 'sin_reporte', TRUE, ${expr}) RETURNING id`, [m.id, curp, hab]));
    await ins(`(date_trunc('day', NOW() AT TIME ZONE '${ZONA}') + interval '1 minute') AT TIME ZONE '${ZONA}'`, CURP_A, '801');
    await ins(`(date_trunc('day', NOW() AT TIME ZONE '${ZONA}') - interval '1 minute') AT TIME ZONE '${ZONA}'`, CURP_B, '802');
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: ZONA });
    const ayer = new Date(new Date(`${hoy}T12:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);

    const lHoy = (await http('GET', `/check-ins?fecha=${hoy}`, { hotel: m })).datos.checkins;
    caso('hoy: solo el de las 00:01, con hora_local y fecha_local del hotel',
        lHoy.length === 1 && lHoy[0].numero_habitacion === '801' && lHoy[0].hora_local === '00:01' && lHoy[0].fecha_local === hoy,
        JSON.stringify(lHoy.map((c) => [c.numero_habitacion, c.fecha_local, c.hora_local])));
    caso('fecha_checkin sigue llegando como antes (checkin.astro / historial)', typeof lHoy[0]?.fecha_checkin === 'string' && lHoy[0].fecha_checkin.endsWith('Z'));
    const lAyer = (await http('GET', `/check-ins?fecha=${ayer}`, { hotel: m })).datos.checkins;
    caso('ayer: el de las 23:59 queda en el día anterior',
        lAyer.length === 1 && lAyer[0].hora_local === '23:59' && lAyer[0].fecha_local === ayer, JSON.stringify(lAyer.map((c) => [c.fecha_local, c.hora_local])));
    const resumen = (await http('GET', '/check-ins/resumen', { hotel: m })).datos;
    caso('resumen de hoy cuenta 1 (no el de las 23:59 de ayer)', resumen.total === 1 && resumen.fecha_inicio === hoy, JSON.stringify(resumen));
    const ca = (curp) => http('GET', `/check-ins/curp-activa?curp=${curp}`, { hotel: m, jwtDe: m });
    const rHoy = (await ca(CURP_A)).datos, rAyer = (await ca(CURP_B)).datos;
    caso('curp-activa: la de las 00:01 cuenta como hoy (hora_local 00:01)', rHoy.activa === true && rHoy.hora_local === '00:01', JSON.stringify(rHoy));
    caso('curp-activa: la de las 23:59 de ayer no cuenta', rAyer.activa === false, JSON.stringify(rAyer));
    const nuevo = await checkIn(m, { curp: CURP_A, numero_habitacion: '803' });
    const ahora = new Date().toLocaleTimeString('en-GB', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    caso('POST /check-ins devuelve fecha_local/hora_local de ahora (además de lo de siempre)',
        nuevo.datos.checkin.fecha_local === hoy && Math.abs(Number(nuevo.datos.checkin.hora_local.replace(':', '')) - Number(ahora.replace(':', ''))) <= 1
        && 'curp' in nuevo.datos.checkin && 'fecha_checkin' in nuevo.datos.checkin, JSON.stringify({ l: nuevo.datos.checkin.hora_local, ahora }));
}

async function pruebasHotelDePrueba(p) {
    console.log('\n── Hotel de prueba (es_prueba): nunca va a la PUI');
    const r = await checkIn(p, { curp: CURP_A, numero_habitacion: '901' });
    const id = r.datos.checkin?.id;
    const fila = (await withHotelContext(p.id, (c) => c.query('SELECT estado_pui, encolado_pui FROM check_ins WHERE id = $1', [id]))).rows[0];
    caso('registra (201) como sin_reporte y sin encolar', r.status === 201 && fila.estado_pui === 'sin_reporte' && fila.encolado_pui === true, JSON.stringify(fila));
    caso('no hay job en la cola para ese check-in', !(await puiQueue.getJob(jobIdDe(id))));
    // Aunque quede marcado como pendiente de encolar, el reencolador lo ignora
    await withHotelContext(p.id, (c) => c.query(`UPDATE check_ins SET encolado_pui = FALSE, creado_en = NOW() - interval '1 hour' WHERE id = $1`, [id]));
    await reencolarPendientes();
    const f2 = (await withHotelContext(p.id, (c) => c.query('SELECT encolado_pui FROM check_ins WHERE id = $1', [id]))).rows[0];
    caso('el reencolador no lo encola', f2.encolado_pui === false && !(await puiQueue.getJob(jobIdDe(id))));
    // Y si algo lo encolara a mano, el worker no hace nada
    await withHotelContext(p.id, (c) => c.query(`UPDATE check_ins SET estado_pui = 'pendiente' WHERE id = $1`, [id]));
    await puiQueue.add('notificar-coincidencia', { checkIn: { id, hotel_id: p.id, curp: CURP_A } }, { jobId: jobIdDe(id) });
    await esperarHasta(async () => (await puiQueue.getJob(jobIdDe(id)))?.finishedOn, 15000);
    const f3 = (await withHotelContext(p.id, (c) => c.query('SELECT estado_pui, intentos_pui FROM check_ins WHERE id = $1', [id]))).rows[0];
    caso('el worker lo omite (no toca el estado ni los intentos)', f3.estado_pui === 'pendiente' && f3.intentos_pui === 0, JSON.stringify(f3));
    const login = await http('POST', '/login', { body: { usuario: 'PUI', clave: p.pui_clave } });
    caso('POST /login de la PUI rechaza al hotel de prueba (401)', login.status === 401);
}

async function pruebasRedisCaido(a) {
    console.log('\n── POST /check-ins con Redis caído');
    const parar = process.env.TEST_REDIS_PARAR;
    const levantar = process.env.TEST_REDIS_LEVANTAR;
    if (!parar || !levantar) {
        console.log('SKIP sin TEST_REDIS_PARAR / TEST_REDIS_LEVANTAR');
        return;
    }
    execSync(parar, { stdio: 'ignore' });
    try {
        const caido = await esperarHasta(async () => (await http('GET', '/health/estado')).datos.cola === 'error', 15000);
        caso('el servidor ve la cola caída', caido);

        const t0 = Date.now();
        const r1 = await checkIn(a, { curp: CURP_A, numero_habitacion: '701' });
        const ms = Date.now() - t0;
        caso('responde 201 en menos de 3 s', r1.status === 201 && ms < 3000, `status ${r1.status} en ${ms} ms`);
        const r2 = await checkIn(a, { curp: CURP_B, numero_habitacion: '702' });
        caso('un segundo registro también responde 201', r2.status === 201);
        const ids = [r1.datos.checkin?.id, r2.datos.checkin?.id];
        const filas = await Promise.all(ids.map((id) => filaCheckIn(a, id)));
        caso('quedan guardados y pendientes de encolar (encolado_pui = false)',
            filas.every((f) => f && f.encolado_pui === false && f.estado_pui === 'pendiente'), JSON.stringify(filas));
    } finally {
        execSync(levantar, { stdio: 'ignore' });
    }

    // Al volver Redis, el reencolador los manda solos
    const ids = (await withHotelContext(a.id, (c) => c.query(
        `SELECT id FROM check_ins WHERE hotel_id = $1 AND numero_habitacion IN ('701', '702') ORDER BY id`, [a.id]))).rows.map((r) => r.id);
    const encolados = await esperarHasta(async () => {
        const f = await Promise.all(ids.map((id) => filaCheckIn(a, id)));
        return f.every((x) => x.encolado_pui === true);
    }, 90000, 1000);
    caso('al volver Redis, el reencolador los encola', encolados);
    const procesados = await esperarHasta(async () => {
        const f = await Promise.all(ids.map((id) => filaCheckIn(a, id)));
        return f.every((x) => x.estado_pui === 'sin_reporte');
    }, 30000, 1000);
    caso('el worker los procesa (sin reporte activo → sin_reporte)', procesados);

    const jobs = await Promise.all(ids.map((id) => puiQueue.getJob(jobIdDe(id))));
    caso('un job por check-in, con jobId determinista', jobs.every((j, i) => j && j.id === `checkin-${ids[i]}`));
    const antes = await puiQueue.getJobCounts();
    for (const id of ids) {
        await puiQueue.add('notificar-coincidencia', { checkIn: { id, hotel_id: a.id } }, { jobId: jobIdDe(id) });
    }
    const despues = await puiQueue.getJobCounts();
    caso('volver a encolar el mismo check-in no crea otro job',
        JSON.stringify(antes) === JSON.stringify(despues), `${JSON.stringify(antes)} → ${JSON.stringify(despues)}`);

    // Sin duplicar avisos aunque el job original ya se haya purgado de Redis:
    // si el check-in ya está 'enviado', el worker lo omite.
    const id = ids[0];
    await (await puiQueue.getJob(jobIdDe(id))).remove();
    await withHotelContext(a.id, (c) => c.query(
        `UPDATE check_ins SET estado_pui = 'enviado', intentos_pui = 1, encolado_pui = FALSE WHERE id = $1`, [id]));
    const reencolado = await esperarHasta(async () => (await filaCheckIn(a, id)).encolado_pui === true, 90000, 1000);
    await esperarHasta(async () => (await puiQueue.getJob(jobIdDe(id)))?.finishedOn, 15000);
    const fila = await filaCheckIn(a, id);
    caso('ya enviado + reencolado tras purga → el worker no lo vuelve a avisar',
        reencolado && fila.estado_pui === 'enviado' && fila.intentos_pui === 1, JSON.stringify(fila));
}

async function pruebasValidacion(a) {
    console.log('\n── Validación de nombres, folio y habitación (tarea 4b)');
    const validos = [
        { nombre: 'JOSÉ MARÍA', primer_apellido: "D'ARTAGNAN", segundo_apellido: 'PEÑA-NIETO' },
        { nombre: 'MA. GUADALUPE', primer_apellido: 'O’BRIEN', segundo_apellido: 'MÜLLER' },
        { nombre: 'Xóchitl', primer_apellido: 'de la Cruz', segundo_apellido: '' },
    ];
    for (const [i, v] of validos.entries()) {
        const r = await checkIn(a, { curp: CURP_B, numero_habitacion: `V-${i}1A`, folio_pms: `VAL-${crypto.randomBytes(3).toString('hex')}`, ...v });
        caso(`nombre real válido aceptado (${v.nombre} ${v.primer_apellido})`, r.status === 201, `${r.status} ${r.datos.error ?? ''}`);
    }
    const sinNombres = await checkIn(a, { curp: CURP_B });
    caso('solo CURP (como checkin.astro sin nombres) sigue aceptado', sinNombres.status === 201, String(sinNombres.status));

    const invalidos = [
        [{ nombre: '<img src=x onerror=alert(1)>' }, 'nombre'],
        [{ primer_apellido: 'JUAN<script>' }, 'primer_apellido'],
        [{ segundo_apellido: 'javascript:x' }, 'segundo_apellido'],
        [{ nombre: 'JUAN2' }, 'nombre'],
        [{ nombre: 'A'.repeat(51) }, 'nombre'],
        [{ numero_habitacion: '10 1' }, 'numero_habitacion'],
        [{ numero_habitacion: '<b>1</b>' }, 'numero_habitacion'],
        [{ folio_pms: 'F"1' }, 'folio_pms'],
        [{ folio_pms: 'F'.repeat(41) }, 'folio_pms'],
        [{ nombre: 42 }, 'nombre'],
    ];
    for (const [datos, campo] of invalidos) {
        const r = await checkIn(a, { curp: CURP_B, ...datos });
        caso(`400 para ${campo} inválido (${JSON.stringify(datos).slice(0, 40)})`, r.status === 400 && r.datos.campo === campo, `${r.status} ${r.datos.campo ?? ''}`);
    }

    const base = await checkIn(a, { curp: CURP_B, numero_habitacion: '300' });
    const ed1 = await http('POST', `/check-ins/${base.datos.checkin.id}/editar`, { hotel: a, jwtDe: a, body: { numero_habitacion: '30<1' } });
    caso('editar: 400 para habitación inválida', ed1.status === 400 && ed1.datos.campo === 'numero_habitacion', String(ed1.status));
    const ed2 = await http('POST', `/check-ins/${base.datos.checkin.id}/editar`, { hotel: a, jwtDe: a, body: { numero_habitacion: '301-B', folio_pms: '' } });
    caso('editar: valores válidos (y folio vacío) aceptados', ed2.status === 200, String(ed2.status));
}

async function pruebasConfigSinClave(a) {
    console.log('\n── GET /hoteles/config no devuelve la pui_clave');
    const gerente = {
        token: jwt.sign({ sub: 0, email: 'g@local', nombre: 'Gerente', rol: 'gerente', hotel_id: a.id }, process.env.JWT_SECRET, { expiresIn: '10m' }),
    };
    const r = await http('GET', '/hoteles/config', { jwtDe: gerente });
    const texto = JSON.stringify(r.datos);
    caso('config 200 sin pui_clave completa', r.status === 200 && !('pui_clave' in r.datos) && !texto.includes(a.pui_clave), texto);
    caso('config trae configurada + últimos 4', r.datos.pui_clave_configurada === true && r.datos.pui_clave_ultimos4 === a.pui_clave.slice(-4));
}

async function pruebasEdicionSoloHoy(a) {
    console.log('\n── Editar solo check-ins de hoy (servidor)');
    const r = await checkIn(a, { curp: CURP_B, numero_habitacion: '400' });
    await withHotelContext(a.id, (c) => c.query(`UPDATE check_ins SET fecha_checkin = NOW() - interval '2 days' WHERE id = $1`, [r.datos.checkin.id]));
    const ed = await http('POST', `/check-ins/${r.datos.checkin.id}/editar`, { hotel: a, jwtDe: a, body: { numero_habitacion: '401' } });
    caso('recepción no puede editar un check-in de hace 2 días (403)', ed.status === 403, String(ed.status));
}

async function pruebasReporteCsp() {
    console.log('\n── POST /csp-report');
    const res = await fetch(`${BASE_URL}/csp-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/csp-report' },
        body: JSON.stringify({ 'csp-report': { 'document-uri': 'https://app.clavepui.com/historial?x=1', 'effective-directive': 'script-src-elem', 'blocked-uri': 'https://malo.example/x.js?curp=ZEMR' } }),
    });
    caso('reporte de CSP → 204', res.status === 204, String(res.status));
}

(async () => {
    const hoteles = [];
    try {
        const a = await crearHotel('A'); hoteles.push(a);
        const b = await crearHotel('B'); hoteles.push(b);
        const m = await crearHotel('M'); hoteles.push(m);
        const pr = await crearHotel('P', { esPrueba: true }); hoteles.push(pr);
        console.log(`Base URL: ${BASE_URL} · hoteles de prueba ${a.id} y ${b.id}`);
        await pruebasFolio(a);
        await pruebasCurpActiva(a, b);
        await pruebasSinAcentos(a, b);
        await pruebasEstado();
        console.log('\n── Logs sin datos personales');
        caso('la URL de curp-activa se registra con la CURP enmascarada',
            urlSinDatosPersonales(`/check-ins/curp-activa?curp=${CURP_A}`) === '/check-ins/curp-activa?curp=ZEMR***');
        caso('la búsqueda por nombre se registra sin el nombre',
            urlSinDatosPersonales('/huespedes/buscar-por-nombre?nombre=Juan%20P%C3%A9rez') === '/huespedes/buscar-por-nombre?nombre=***');
        caso('otras URL no cambian', urlSinDatosPersonales('/check-ins?fecha=2026-10-19&limit=20') === '/check-ins?fecha=2026-10-19&limit=20');
        await pruebasMetodoCaptura(a);
        await pruebasMedianoche(m);
        await pruebasHotelDePrueba(pr);
        await pruebasValidacion(a);
        await pruebasConfigSinClave(a);
        await pruebasEdicionSoloHoy(a);
        await pruebasReporteCsp();
        await pruebasRedisCaido(a);
    } catch (err) {
        fallas++;
        console.error('ERROR', err);
    } finally {
        await limpiar(hoteles);
        console.log(`\n${fallas === 0 ? 'Todas las pruebas pasaron.' : `${fallas} prueba(s) fallaron.`}`);
        process.exit(fallas === 0 ? 0 : 1);
    }
})();
