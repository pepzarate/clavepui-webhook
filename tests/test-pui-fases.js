/**
 * Pruebas de la búsqueda de la PUI: fases 1, 2 y 3 y /busqueda-finalizada
 * (tarea 4c, Manual Técnico sección 6.4 y 7.2–7.3).
 *
 *   npm run test:pui-fases     (Postgres + Redis; NO necesita el backend corriendo)
 *
 * - NUNCA llama al API real: levanta un mock en 127.0.0.1 y fija PUI_API_URL
 *   antes de cargar la app. El mock valida cada aviso con las expresiones
 *   regulares del manual (7.2) y responde 400 si algo no cumple.
 * - Corre sus propias colas (PUI_COLA_PREFIJO aleatorio) y sus workers en
 *   este proceso, así que un backend corriendo no toma sus jobs.
 * - Crea sus hoteles (RFC TST…, gov_pui_clave falsa) y los borra al final.
 * - Datos inventados (CURPs de prueba).
 */
const http = require('node:http');
const crypto = require('node:crypto');

const MOCK_PUERTO = 18000 + Math.floor(Math.random() * 1000);
process.env.PUI_API_URL = `http://127.0.0.1:${MOCK_PUERTO}/api/2_3_0`;
process.env.PUI_COLA_PREFIJO = `bull-pruebas-${crypto.randomBytes(3).toString('hex')}`;
process.env.PUI_BUSQUEDA_BACKOFF_MS = '300';
process.env.PUI_ENCOLAR_TIMEOUT_MS = '2000';
require('dotenv').config({ quiet: true });

const express = require('express');
const jwt = require('jsonwebtoken');
const { pool, initDb, withAdminContext, withHotelContext } = require('../src/db');
const config = require('../src/config');
const puiApi = require('../src/services/puiApi');
const { procesarReporte, busquedasWorker, busquedasQueue } = require('../src/services/puiBusqueda');
const { intentarEncolar, puiQueue, puiWorker } = require('../src/services/puiQueue');
const { construirPayload } = require('../src/services/puiPayload');

let fallas = 0;
function caso(nombre, ok, detalle = '') {
    if (!ok) fallas++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperarHasta(cond, ms = 15000) {
    const fin = Date.now() + ms;
    while (Date.now() < fin) {
        if (await cond()) return true;
        await esperar(200);
    }
    return false;
}

// ── Mock del API de la PUI ────────────────────────────────────────────
const NOMBRE = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ '-]{1,50}$/;
const TEXTO = (max) => new RegExp(`^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 .,#'/:()\\-]{0,${max}}$`);
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Reglas de la sección 7.2 del manual. Devuelve la lista de errores. */
function validarNotificacion(b) {
    const e = [];
    if (!/^[A-Z0-9]{18}$/.test(b.curp ?? '')) e.push("'curp'");
    if (b.nombre_completo) {
        for (const k of ['nombre', 'primer_apellido', 'segundo_apellido']) {
            if (b.nombre_completo[k] !== undefined && !NOMBRE.test(b.nombre_completo[k])) e.push(`'${k}'`);
        }
    }
    if (b.fecha_nacimiento !== undefined && !FECHA.test(b.fecha_nacimiento)) e.push("'fecha_nacimiento'");
    if (typeof b.lugar_nacimiento !== 'string' || b.lugar_nacimiento.length > 20) e.push("'lugar_nacimiento'");
    if (b.sexo_asignado !== undefined && !/^[MHX]$/.test(b.sexo_asignado)) e.push("'sexo_asignado'");
    if (b.telefono !== undefined && !/^\+?\d{0,15}$/.test(b.telefono)) e.push("'telefono'");
    if (typeof b.id !== 'string' || b.id.length < 36 || b.id.length > 75) e.push("'id'");
    if (!/^[A-Z0-9]{4,13}$/.test(b.institucion_id ?? '')) e.push("'institucion_id'");
    if (!/^[1-3]$/.test(b.fase_busqueda ?? '')) e.push("'fase_busqueda'");
    if (b.tipo_evento !== undefined && !TEXTO(500).test(b.tipo_evento)) e.push("'tipo_evento'");
    if (b.fecha_evento !== undefined && !FECHA.test(b.fecha_evento)) e.push("'fecha_evento'");
    if (b.descripcion_lugar_evento !== undefined && !TEXTO(500).test(b.descripcion_lugar_evento)) e.push("'descripcion_lugar_evento'");
    return e;
}

const mock = {
    llamadas: [], // { ruta, body, token }
    guion: {}, // ruta → [status, ...] (se consumen en orden; después 200)
    reiniciar() { this.llamadas = []; this.guion = {}; },
    de(ruta) { return this.llamadas.filter((l) => l.ruta === ruta); },
};
const servidorMock = http.createServer((req, res) => {
    let datos = '';
    req.on('data', (c) => { datos += c; });
    req.on('end', () => {
        const ruta = req.url.replace('/api/2_3_0', '');
        const body = datos ? JSON.parse(datos) : {};
        const token = (req.headers.authorization ?? '').replace('Bearer ', '');
        mock.llamadas.push({ ruta, body, token });
        const responder = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
        const forzado = mock.guion[ruta]?.shift();
        if (ruta === '/login') {
            if (forzado) return responder(forzado, { error: 'Credenciales inválidas' });
            return responder(200, { token: `tok-${body.institucion_id}-${mock.de('/login').length}` });
        }
        if (!token.startsWith('tok-')) return responder(401, { error: 'Token inválido o expirado' });
        if (forzado && forzado !== 200) return responder(forzado, forzado === 300 ? { error: 'Coincidencias múltiples' } : { error: 'x' });
        if (ruta === '/notificar-coincidencia') {
            const errores = validarNotificacion(body);
            if (errores.length) return responder(400, { errores });
            return responder(200, { message: 'Coincidencia recibida correctamente' });
        }
        if (ruta === '/busqueda-finalizada') {
            if (!body.id || !body.institucion_id) return responder(400, { error: 'Error al guardar el registro.' });
            return responder(200, { message: 'Registro de finalización de búsqueda histórica guardado correctamente.' });
        }
        return responder(404, {});
    });
});

// ── Datos ─────────────────────────────────────────────────────────────
const ZONA = 'America/Mexico_City';
const CURP_A = 'ZEMR850315HDFNRS06'; // inventadas
const CURP_B = 'PEGJ900101HDFRRN05';
const CURP_C = 'LOMA010203MJCPRNA1';
const reporteId = () => `${crypto.randomUUID()}-${crypto.randomUUID()}`; // <FUB>-<UUID4>, 73 caracteres

async function crearHotel(sufijo, { esPrueba = false, gov = 'clave-falsa-de-prueba' } = {}) {
    const id = crypto.randomBytes(3).toString('hex').toUpperCase();
    const { rows } = await pool.query(
        `INSERT INTO hoteles (nombre, rfc, pui_clave, gov_pui_clave, es_prueba)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, nombre, rfc, pui_clave`,
        [`HOTEL PRUEBA PUI ${sufijo}`, `TST${id}${sufijo}`.slice(0, 13), `PruebaPui-${id}-${sufijo}`, gov, esPrueba]
    );
    return rows[0];
}

/** Check-in en una fecha/hora local MX dada ('YYYY-MM-DD HH:MM'). */
async function checkIn(hotel, curp, localMx, extra = {}) {
    const { rows } = await withHotelContext(hotel.id, (c) => c.query(
        `INSERT INTO check_ins (hotel_id, curp, nombre, primer_apellido, segundo_apellido, numero_habitacion,
                                fecha_checkin, estado_pui, encolado_pui, telefono)
         VALUES ($1, $2, $3, $4, $5, $6, ($7::timestamp AT TIME ZONE $8), 'sin_reporte', TRUE, $9)
         RETURNING *`,
        [hotel.id, curp, extra.nombre ?? 'MA. GUADALUPE', extra.primer ?? 'O’BRIEN', extra.segundo ?? 'PEÑA',
            extra.hab ?? '101', localMx, ZONA, extra.telefono ?? null]
    ));
    return rows[0];
}

async function reporte(hotel, curp, { desaparicion = null, recibido = null, id = reporteId() } = {}) {
    await withHotelContext(hotel.id, (c) => c.query(
        `INSERT INTO reportes_activos (id, curp, nombre, fecha_desaparicion, hotel_id, activo, recibido_en)
         VALUES ($1, $2, 'INVENTADO', $3, $4, TRUE, COALESCE($5::timestamptz, NOW()))`,
        [id, curp, desaparicion, hotel.id, recibido]
    ));
    return id;
}

const fechaMx = (offsetDias, hora = '12:00') => {
    const d = new Date(Date.now() + offsetDias * 86400000);
    return `${d.toLocaleDateString('en-CA', { timeZone: ZONA })} ${hora}`;
};
const hace = (anios, dias = 0) => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - anios);
    d.setDate(d.getDate() - dias);
    return d.toLocaleDateString('en-CA', { timeZone: ZONA });
};

async function filaReporte(hotel, id) {
    return (await withHotelContext(hotel.id, (c) => c.query(
        `SELECT busqueda_estado, busqueda_finalizada_en FROM reportes_activos WHERE hotel_id = $1 AND id = $2`, [hotel.id, id]
    ))).rows[0];
}
async function bitacora(hotel, id) {
    return (await withHotelContext(hotel.id, (c) => c.query(
        `SELECT fase, check_in_id, estado, http_status FROM pui_notificaciones WHERE hotel_id = $1 AND reporte_id = $2 ORDER BY id`, [hotel.id, id]
    ))).rows;
}
const notifDe = (id) => mock.de('/notificar-coincidencia').filter((l) => l.body.id === id);
const finDe = (id) => mock.de('/busqueda-finalizada').filter((l) => l.body.id === id);

// ── App mínima con las rutas reales (sin levantar todo el backend) ────
function appRutas() {
    const app = express();
    app.use(express.json());
    app.use('/', require('../src/routes/activar'));
    app.use('/', require('../src/routes/checkIns'));
    return new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
}
const tokenPui = (hotel) => jwt.sign({ sub: 'pui-gobierno', iss: 'clavepui', hotel_id: hotel.id, rfc: hotel.rfc }, process.env.JWT_SECRET, { expiresIn: '10m' });
const tokenStaff = (hotel) => jwt.sign({ sub: 1, email: 'r@local', nombre: 'Recepción', rol: 'recepcionista', hotel_id: hotel.id }, process.env.JWT_SECRET, { expiresIn: '10m' });

// ── Pruebas ───────────────────────────────────────────────────────────
async function pruebasHistorico(app, h) {
    console.log('\n── Reporte con coincidencias históricas (activar → fases 1 y 2 → finalizada)');
    mock.reiniciar();
    const viejo = await checkIn(h, CURP_A, `${hace(0, 400)} 09:15`, { hab: '210' });
    const reciente = await checkIn(h, CURP_A, fechaMx(-30, '23:40'), { hab: '305', telefono: '55 1234 5678' });
    const antes = await checkIn(h, CURP_A, `${hace(3)} 10:00`); // antes de la desaparición: fuera
    await checkIn(h, CURP_B, fechaMx(-10)); // otra CURP
    const id = reporteId();
    const t0 = Date.now();
    const r = await fetch(`${app}/activar-reporte`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenPui(h)}` },
        body: JSON.stringify({ id, curp: CURP_A, nombre: 'INVENTADO', fecha_desaparicion: hace(2) }),
    });
    caso('activar-reporte responde 200 sin esperar la búsqueda', r.status === 200 && Date.now() - t0 < 1500, `${r.status} en ${Date.now() - t0} ms`);
    const fin = await esperarHasta(async () => (await filaReporte(h, id))?.busqueda_estado === 'finalizada');
    caso('la búsqueda termina en "finalizada"', fin);
    const n = notifDe(id);
    const f1 = n.filter((l) => l.body.fase_busqueda === '1');
    const f2 = n.filter((l) => l.body.fase_busqueda === '2');
    caso('fase 1: un único aviso', f1.length === 1, String(f1.length));
    caso('fase 1 omite tipo_evento, fecha_evento, descripcion_lugar_evento y direccion_evento',
        f1[0] && !['tipo_evento', 'fecha_evento', 'descripcion_lugar_evento', 'direccion_evento'].some((k) => k in f1[0].body));
    caso('fase 1 usa el registro más reciente (teléfono del último check-in)', f1[0]?.body.telefono === '5512345678', f1[0]?.body.telefono);
    caso('fase 2: un aviso por check-in dentro del periodo (2, no el de antes de la desaparición)', f2.length === 2, String(f2.length));
    const fechas = f2.map((l) => l.body.fecha_evento).sort();
    caso('fase 2: fecha_evento = fecha local del check-in (23:40 MX no pasa al día siguiente)',
        JSON.stringify(fechas) === JSON.stringify([hace(0, 400), fechaMx(-30).slice(0, 10)].sort()), fechas.join(','));
    caso('fase 2 incluye tipo_evento y descripcion_lugar_evento con la habitación',
        f2.every((l) => l.body.tipo_evento === 'Check-in en hotel' && /habitación (210|305)$/.test(l.body.descripcion_lugar_evento)));
    caso('nombres normalizados a la regex del manual (sin punto, ’ → \')',
        f2[0]?.body.nombre_completo?.nombre === 'MA GUADALUPE' && f2[0]?.body.nombre_completo?.primer_apellido === "O'BRIEN",
        JSON.stringify(f2[0]?.body.nombre_completo));
    caso('lugar_nacimiento según el Anexo 5 (DF → CDMX)', f2[0]?.body.lugar_nacimiento === 'CDMX');
    caso('ningún aviso rechazado por el validador del manual', mock.de('/notificar-coincidencia').every((l) => validarNotificacion(l.body).length === 0));
    caso('/busqueda-finalizada una vez, con id e institucion_id', finDe(id).length === 1 && finDe(id)[0].body.institucion_id === h.rfc);
    const orden = mock.llamadas.filter((l) => l.body?.id === id).map((l) => l.body.fase_busqueda ?? 'fin');
    caso('orden: fase 1, fase 2…, y al final /busqueda-finalizada', orden[0] === '1' && orden.at(-1) === 'fin', orden.join(','));
    const estados = (await withHotelContext(h.id, (c) => c.query(
        `SELECT id, estado_pui FROM check_ins WHERE id = ANY($1)`, [[viejo.id, reciente.id, antes.id]]))).rows;
    caso('check-ins notificados en fase 2 quedan "enviado"; el de fuera no',
        estados.find((e) => e.id === viejo.id).estado_pui === 'enviado' && estados.find((e) => e.id === antes.id).estado_pui === 'sin_reporte');

    // Idempotencia: volver a procesar el mismo reporte no repite avisos
    await withHotelContext(h.id, (c) => c.query(`UPDATE reportes_activos SET busqueda_estado = 'pendiente' WHERE hotel_id = $1 AND id = $2`, [h.id, id]));
    const antesN = notifDe(id).length;
    await procesarReporte(h.id, id);
    caso('reprocesar el reporte no vuelve a notificar fases 1 ni 2', notifDe(id).length === antesN, `${antesN} → ${notifDe(id).length}`);
    caso('la bitácora tiene una fila por (fase, check-in)', (await bitacora(h, id)).length === 3);
    return id;
}

async function pruebasSinCoincidencias(h) {
    console.log('\n── Reporte sin coincidencias');
    mock.reiniciar();
    const id = await reporte(h, CURP_C, { desaparicion: hace(1) });
    await procesarReporte(h.id, id);
    caso('sin registros: no se notifica ninguna fase', notifDe(id).length === 0);
    caso('sin registros: igual llama a /busqueda-finalizada', finDe(id).length === 1);
    caso('queda "finalizada"', (await filaReporte(h, id)).busqueda_estado === 'finalizada');
}

async function pruebasSinFecha(h) {
    console.log('\n── Reporte sin fecha de desaparición');
    mock.reiniciar();
    const id = await reporte(h, CURP_A, { desaparicion: null });
    const r = await procesarReporte(h.id, id);
    caso('fase 2 omitida', r.fase2_omitida === true && notifDe(id).every((l) => l.body.fase_busqueda !== '2'));
    caso('fase 1 sí se notifica (hay registros de la CURP)', notifDe(id).filter((l) => l.body.fase_busqueda === '1').length === 1);
    caso('igual llama a /busqueda-finalizada', finDe(id).length === 1);
}

async function pruebasDoceAnios(h) {
    console.log('\n── Fecha de desaparición de hace más de 12 años');
    mock.reiniciar();
    const fuera = await checkIn(h, CURP_B, `${hace(13)} 12:00`);
    const dentro = await checkIn(h, CURP_B, `${hace(11)} 12:00`);
    const id = await reporte(h, CURP_B, { desaparicion: hace(15) });
    await procesarReporte(h.id, id);
    const ids = (await bitacora(h, id)).filter((b) => b.fase === 2).map((b) => b.check_in_id);
    caso('solo los últimos 12 años: entra el de hace 11, no el de hace 13', ids.includes(dentro.id) && !ids.includes(fuera.id), ids.join(','));
}

async function pruebasFase3YEdicion(app, h) {
    console.log('\n── Fase 3: check-in nuevo, edición de habitación y de folio');
    mock.reiniciar();
    const id = await reporte(h, CURP_C, { desaparicion: hace(1) });
    await withHotelContext(h.id, (c) => c.query(`UPDATE reportes_activos SET busqueda_estado = 'finalizada' WHERE hotel_id = $1 AND id = $2`, [h.id, id]));
    const ci = await checkIn(h, CURP_C, fechaMx(0, '00:30'), { hab: '401' });
    await intentarEncolar({ ...ci });
    const ok = await esperarHasta(async () => notifDe(id).length === 1);
    const f3 = notifDe(id)[0]?.body;
    caso('check-in nuevo con reporte activo → aviso fase 3', ok && f3?.fase_busqueda === '3');
    caso('fase 3: fecha_evento = fecha local del check-in (00:30 MX)', f3?.fecha_evento === fechaMx(0).slice(0, 10), f3?.fecha_evento);
    caso('fase 3 incluye los campos de evento', f3?.tipo_evento === 'Check-in en hotel' && /habitación 401$/.test(f3?.descripcion_lugar_evento ?? ''));
    caso('check-in queda "enviado"', await esperarHasta(async () => (await withHotelContext(h.id, (c) => c.query(`SELECT estado_pui FROM check_ins WHERE id = $1`, [ci.id]))).rows[0].estado_pui === 'enviado', 5000));

    const editar = (body) => fetch(`${app}/check-ins/${ci.id}/editar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hotel-key': h.pui_clave, Authorization: `Bearer ${tokenStaff(h)}` },
        body: JSON.stringify(body),
    });
    const e1 = await editar({ numero_habitacion: '402' });
    const re = await esperarHasta(async () => notifDe(id).length === 2);
    caso('editar la habitación → nuevo aviso fase 3 (registro modificado)', e1.status === 200 && re && /habitación 402$/.test(notifDe(id)[1]?.body.descripcion_lugar_evento ?? ''));
    const e2 = await editar({ folio_pms: 'F-9' });
    await esperar(1500);
    caso('editar solo el folio (no va a la PUI) → sin aviso nuevo', e2.status === 200 && notifDe(id).length === 2, String(notifDe(id).length));
    // Mismo contenido por otra vía (p. ej. el barrido) → no se repite
    const { notificarFase3, hotelParaPui } = require('../src/services/puiBusqueda');
    const fila = (await withHotelContext(h.id, (c) => c.query(`SELECT * FROM check_ins WHERE id = $1`, [ci.id]))).rows[0];
    await notificarFase3((await hotelParaPui(h.id)).hotel, fila);
    caso('el mismo contenido nunca se notifica dos veces en fase 3', notifDe(id).length === 2);
}

async function pruebasHotelPrueba(pr, sinEnlace) {
    console.log('\n── Hotel de prueba y hotel sin enlace con la PUI');
    mock.reiniciar();
    await checkIn(pr, CURP_A, fechaMx(-5));
    const id = await reporte(pr, CURP_A, { desaparicion: hace(1) });
    const r = await procesarReporte(pr.id, id);
    caso('hotel de prueba: se omite sin llamar a la PUI', r.omitido === 'hotel_prueba' && mock.llamadas.length === 0);
    await checkIn(sinEnlace, CURP_A, fechaMx(-5));
    const id2 = await reporte(sinEnlace, CURP_A, { desaparicion: hace(1) });
    const r2 = await procesarReporte(sinEnlace.id, id2);
    caso('hotel sin gov_pui_clave: se omite sin llamar a la PUI', r2.omitido === 'sin_enlace_pui' && mock.llamadas.length === 0);
}

async function pruebasRespuestas(h) {
    console.log('\n── Respuestas 300, 400 y 401 de la PUI');
    mock.reiniciar();
    await checkIn(h, 'MUAL800101MDFRRN09', fechaMx(-3));
    const id = await reporte(h, 'MUAL800101MDFRRN09', { desaparicion: hace(1) });
    mock.guion['/notificar-coincidencia'] = [300, 300];
    await procesarReporte(h.id, id);
    const b = await bitacora(h, id);
    caso('300 (coincidencias múltiples) se registra como "multiple" y no se reintenta',
        b.every((x) => x.estado === 'multiple' && x.http_status === 300) && notifDe(id).length === 2, JSON.stringify(b));
    caso('con 300 igual se llama a /busqueda-finalizada', finDe(id).length === 1);

    mock.reiniciar();
    puiApi.olvidarTokens();
    await checkIn(h, 'NUAL800101MDFRRN04', fechaMx(-3));
    const id2 = await reporte(h, 'NUAL800101MDFRRN04', { desaparicion: hace(1) });
    mock.guion['/notificar-coincidencia'] = [401];
    await procesarReporte(h.id, id2);
    caso('401 → pide token nuevo y reintenta una vez', mock.de('/login').length === 2 && (await bitacora(h, id2)).every((x) => x.estado === 'enviada'));

    mock.reiniciar();
    const id3 = await reporte(h, 'NUAL800101MDFRRN04', { desaparicion: hace(1) });
    mock.guion['/notificar-coincidencia'] = [400, 400];
    await procesarReporte(h.id, id3);
    caso('400 se registra como "rechazada" sin reintentar', (await bitacora(h, id3)).every((x) => x.estado === 'rechazada') && notifDe(id3).length === 2);
}

async function pruebasReintento(app, h) {
    console.log('\n── Error de la PUI con reintento (BullMQ)');
    mock.reiniciar();
    await checkIn(h, 'OUAL800101MDFRRN07', fechaMx(-2));
    const id = reporteId();
    mock.guion['/notificar-coincidencia'] = [500];
    mock.guion['/busqueda-finalizada'] = [500];
    await fetch(`${app}/activar-reporte`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenPui(h)}` },
        body: JSON.stringify({ id, curp: 'OUAL800101MDFRRN07', fecha_desaparicion: hace(1) }),
    });
    const fin = await esperarHasta(async () => (await filaReporte(h, id))?.busqueda_estado === 'finalizada', 20000);
    const n = notifDe(id);
    caso('tras un 500 el job se reintenta y termina', fin);
    caso('el aviso que falló se reenvía y los ya enviados no se repiten',
        n.filter((l) => l.body.fase_busqueda === '1').length === 2 && n.filter((l) => l.body.fase_busqueda === '2').length === 1, n.map((l) => l.body.fase_busqueda).join(','));
    caso('/busqueda-finalizada se reintenta tras su 500', finDe(id).length === 2);
}

async function pruebasLlaveYSeguridad(app, a, b) {
    console.log('\n── Mismo id de reporte en dos hoteles y token de staff');
    const id = reporteId();
    const activar = (h, token) => fetch(`${app}/activar-reporte`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id, curp: CURP_C }),
    });
    const r1 = await activar(a, tokenPui(a));
    const r2 = await activar(b, tokenPui(b));
    const filas = (await withAdminContext((c) => c.query(`SELECT hotel_id FROM reportes_activos WHERE id = $1 ORDER BY hotel_id`, [id]))).rows;
    caso('la PUI puede mandar el mismo id a dos hoteles (llave hotel_id + id)', r1.status === 200 && r2.status === 200 && filas.length === 2, `${r1.status}/${r2.status}, filas ${filas.length}`);
    const r3 = await activar(a, tokenStaff(a));
    caso('un JWT de staff no puede activar reportes (403)', r3.status === 403, String(r3.status));
    const r4 = await fetch(`${app}/activar-reporte`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenPui(a)}` },
        body: JSON.stringify({ id: reporteId(), curp: CURP_C, fecha_desaparicion: '15/03/2020' }),
    });
    caso('fecha_desaparicion con formato inválido → 400', r4.status === 400);
}

async function pruebasPayloadYGuarda() {
    console.log('\n── Payload y protección contra el API real');
    const p = construirPayload({
        fase: 3, reporteId: reporteId(), hotel: { rfc: 'TST123', nombre: 'HOTEL <script> & CIA' },
        persona: { curp: 'ZEMR850315HNERNS06', nombre: 'José Ç.', primer_apellido: '', segundo_apellido: 'X2' },
        evento: { fecha_checkin: new Date(), numero_habitacion: '1 <b>' },
    });
    caso('NE → FORÁNEO (Anexo 5)', p.lugar_nacimiento === 'FORÁNEO');
    caso('nombre normalizado y campos vacíos omitidos', p.nombre_completo?.nombre === 'José C' && !('primer_apellido' in p.nombre_completo), JSON.stringify(p.nombre_completo));
    caso('descripcion sin caracteres fuera del manual', validarNotificacion(p).length === 0, p.descripcion_lugar_evento);
    const guardada = config.pui.apiUrl;
    config.pui.apiUrl = null;
    let rechazo = false;
    try { await puiApi.notificarCoincidencia({ id: 0, rfc: 'X', gov_pui_clave: 'x' }, {}); } catch (e) { rechazo = e instanceof puiApi.ErrorPuiPermanente; }
    config.pui.apiUrl = guardada;
    caso('sin PUI_API_URL (fuera de producción) el cliente no llama al API real', rechazo);
}

(async () => {
    const hoteles = [];
    let srv;
    try {
        await new Promise((ok) => servidorMock.listen(MOCK_PUERTO, '127.0.0.1', ok));
        await initDb();
        srv = await appRutas();
        const app = `http://127.0.0.1:${srv.address().port}`;
        const a = await crearHotel('A'); hoteles.push(a);
        const b = await crearHotel('B'); hoteles.push(b);
        const pr = await crearHotel('P', { esPrueba: true }); hoteles.push(pr);
        const sinEnlace = await crearHotel('S', { gov: null }); hoteles.push(sinEnlace);
        console.log(`Mock PUI en ${process.env.PUI_API_URL} · cola ${process.env.PUI_COLA_PREFIJO}`);
        await pruebasHistorico(app, a);
        await pruebasSinCoincidencias(a);
        await pruebasSinFecha(a);
        await pruebasDoceAnios(a);
        await pruebasFase3YEdicion(app, b);
        await pruebasHotelPrueba(pr, sinEnlace);
        await pruebasRespuestas(a);
        await pruebasReintento(app, a);
        await pruebasLlaveYSeguridad(app, a, b);
        await pruebasPayloadYGuarda();
        caso('ninguna llamada salió del mock (todas a 127.0.0.1)', config.pui.apiUrl.startsWith('http://127.0.0.1:'));
    } catch (err) {
        fallas++;
        console.error('ERROR', err);
    } finally {
        await esperar(500);
        const ids = hoteles.map((h) => h.id);
        await withAdminContext(async (c) => {
            for (const t of ['pui_notificaciones', 'check_ins_ediciones', 'check_ins', 'huespedes_frecuentes', 'reportes_activos']) {
                await c.query(`DELETE FROM ${t} WHERE hotel_id = ANY($1)`, [ids]);
            }
        }).catch((e) => console.error('limpieza', e.message));
        await pool.query('DELETE FROM hoteles WHERE id = ANY($1)', [ids]).catch((e) => console.error('limpieza hoteles', e.message));
        for (const q of [busquedasQueue, puiQueue]) await q.obliterate({ force: true }).catch(() => {});
        await Promise.all([busquedasWorker.close(), puiWorker.close()]).catch(() => {});
        srv?.close();
        servidorMock.close();
        console.log(`\n${fallas === 0 ? 'Todas las pruebas pasaron.' : `${fallas} prueba(s) fallaron.`}`);
        process.exit(fallas === 0 ? 0 : 1);
    }
})();
