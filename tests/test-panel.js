/**
 * Pruebas de GET /panel y GET /configuracion (tarea 7).
 *
 *   npm run test:panel   (con el backend corriendo: Postgres; Redis no hace falta)
 *
 * Crea hoteles propios y los borra al final:
 *   A  de prueba con enlace_simulado (enlazado en local, sin clave real)
 *   B  de prueba sin enlace
 *   R  "real" (no de prueba) con una gov_pui_clave inventada y sin datos:
 *      solo para ver "aprobada" en Configuración; sin reportes ni check-ins,
 *      así que el worker nunca tiene nada que avisar.
 * Check-ins insertados ya "encolados". No llama a la PUI.
 */
require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { pool, withAdminContext, withHotelContext } = require('../src/db');
const { hora12 } = require('../src/utils/zonaHoraria');

const BASE_URL = process.env.TEST_URL || 'http://localhost:8080';
const ZONA = 'America/Mexico_City';
let fallas = 0;
function caso(nombre, ok, detalle = '') {
    if (!ok) fallas++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
}

const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: ZONA });
const ayer = () => new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: ZONA });

async function crearHotel(sufijo, { prueba = true, simulado = false, gov = null } = {}) {
    const id = crypto.randomBytes(3).toString('hex').toUpperCase();
    const { rows } = await pool.query(
        `INSERT INTO hoteles (nombre, rfc, pui_clave, gov_pui_clave, es_prueba, enlace_simulado)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, nombre, rfc, pui_clave, gov_pui_clave`,
        [`HOTEL PANEL ${sufijo}`, `TSP${id}${sufijo}`, `PruebaPanel-${id}-${sufijo}`, gov, prueba, simulado]
    );
    const h = rows[0];
    const token = (rol) => jwt.sign({ sub: 0, email: `${rol}@local`, nombre: `${rol} prueba`, rol, hotel_id: h.id }, process.env.JWT_SECRET, { expiresIn: '10m' });
    h.recepcion = token('recepcionista');
    h.gerente = token('gerente');
    return h;
}

async function checkIn(h, { nombre, hab, hora = '10:00', fecha = hoy(), estado = 'sin_reporte' }) {
    const { rows } = await withHotelContext(h.id, (c) => c.query(
        `INSERT INTO check_ins (hotel_id, curp, nombre, primer_apellido, numero_habitacion, fecha_checkin, estado_pui, encolado_pui, registrado_por)
         VALUES ($1, 'ZZPA800101HDFRRN05', $2, 'PRUEBA', $3, ($4::timestamp AT TIME ZONE $5), $6, TRUE, 'Ana Prueba') RETURNING id`,
        [h.id, nombre, hab, `${fecha} ${hora}`, ZONA, estado]
    ));
    return rows[0].id;
}

async function get(ruta, h, rol = 'gerente', clave = null) {
    const res = await fetch(`${BASE_URL}${ruta}`, { headers: { 'x-hotel-key': clave ?? h.pui_clave, Authorization: `Bearer ${h[rol]}` } });
    return { status: res.status, texto: await res.text() };
}
const json = (r) => { try { return JSON.parse(r.texto); } catch { return null; } };

(async () => {
    const hoteles = [];
    try {
        const A = await crearHotel('A', { simulado: true }); hoteles.push(A);
        const B = await crearHotel('B'); hoteles.push(B);
        const R = await crearHotel('R', { prueba: false, gov: `gov-inventada-${crypto.randomUUID()}` }); hoteles.push(R);

        // A: uno por estado (y uno de ayer, que no cuenta)
        await checkIn(A, { nombre: 'SINCO', hab: '101', hora: '08:00', estado: 'sin_reporte' });
        await checkIn(A, { nombre: 'SINCO DOS', hab: '102', hora: '08:30', estado: 'sin_reporte' });
        await checkIn(A, { nombre: 'REVISION', hab: '103', hora: '09:00', estado: 'pendiente' });
        await checkIn(A, { nombre: 'FALLA', hab: '104', hora: '09:30', estado: 'error' });
        const coin = await checkIn(A, { nombre: 'COINCIDE', hab: '105', hora: '15:30', estado: 'enviado' });
        await checkIn(A, { nombre: 'AYER', hab: '106', fecha: ayer(), estado: 'error' });
        // B: estados variados, pero sin enlace todo es "registrado"
        await checkIn(B, { nombre: 'UNO', hab: '201', estado: 'error' });
        await checkIn(B, { nombre: 'DOS', hab: '202', estado: 'enviado' });

        console.log('\n── Solo Gerencia');
        for (const ruta of ['/panel', '/configuracion']) {
            let r = await get(ruta, A, 'recepcion');
            caso(`Recepción en ${ruta} → 403 sin datos`, r.status === 403 && !/SINCO|PRUEBA000|HOTEL PANEL/.test(r.texto), r.texto);
            r = await get(ruta, A, 'gerente', B.pui_clave);
            caso(`${ruta}: JWT de A con la clave de B → 403`, r.status === 403);
            const sin = await fetch(`${BASE_URL}${ruta}`);
            caso(`${ruta}: sin credenciales → 401`, sin.status === 401);
        }

        console.log('\n── Panel, hotel enlazado (simulado)');
        let r = await get('/panel', A);
        let p = json(r);
        caso('200 con la fecha de hoy', r.status === 200 && p.fecha_local === hoy() && p.hotel_enlazado === true);
        caso('cifras por estado: total 5, sin coincidencia 2, en revisión 1, coincidencia 1, error 1, registrado 0',
            p.resumen.total === 5 && p.resumen.sin_coincidencia === 2 && p.resumen.en_revision === 1
            && p.resumen.coincidencia === 1 && p.resumen.error === 1 && p.resumen.registrado === 0, JSON.stringify(p.resumen));
        caso('el check-in de ayer no cuenta', !p.ultimos.some((u) => u.nombre === 'AYER'));
        caso('últimos: 5, el más reciente primero, con hora local 24 h', p.ultimos.length === 5 && p.ultimos[0].id === coin && p.ultimos[0].hora_local === '15:30');
        caso('últimos con estado y aviso del vocabulario de la tarea 5', p.ultimos[0].estado === 'coincidencia' && p.ultimos[0].aviso === 'enviado');
        caso('últimos sin CURP', !r.texto.includes('ZZPA'));

        console.log('\n── Panel, hotel sin enlace');
        r = await get('/panel', B);
        p = json(r);
        caso('todo "registrado", nada en revisión, coincidencia ni error',
            p.hotel_enlazado === false && p.resumen.total === 2 && p.resumen.registrado === 2
            && p.resumen.en_revision === 0 && p.resumen.coincidencia === 0 && p.resumen.error === 0, JSON.stringify(p.resumen));
        caso('últimos también "registrado"', p.ultimos.every((u) => u.estado === 'registrado' && u.aviso === null));

        console.log('\n── Panel, sin check-ins hoy');
        r = await get('/panel', R);
        p = json(r);
        caso('total 0 y lista vacía', r.status === 200 && p.resumen.total === 0 && p.ultimos.length === 0);

        console.log('\n── Configuración sin credenciales');
        for (const [h, aprobacion, nombre] of [[A, 'aprobada', 'de prueba con enlace simulado'], [B, 'pendiente', 'de prueba sin enlace'], [R, 'aprobada', 'real con gov_pui_clave']]) {
            r = await get('/configuracion', h);
            const c = json(r);
            caso(`${nombre}: aprobación ${aprobacion}, credencial configurada`, c.aprobacion_gobierno === aprobacion && c.credencial_pui === 'configurada', r.texto);
            caso(`${nombre}: solo nombre, rfc, credencial_pui y aprobacion_gobierno`,
                JSON.stringify(Object.keys(c).sort()) === '["aprobacion_gobierno","credencial_pui","nombre","rfc"]');
            caso(`${nombre}: ningún carácter de las claves`, !r.texto.includes(h.pui_clave) && !r.texto.includes(h.pui_clave.slice(-4))
                && !(h.gov_pui_clave && r.texto.includes(h.gov_pui_clave.slice(-4))) && !/ultimos4|pui_clave"|gov_pui_clave/.test(r.texto));
        }
        // Hotel de prueba con una gov_pui_clave cargada por error: sigue pendiente
        await pool.query(`UPDATE hoteles SET gov_pui_clave = 'x-de-prueba', enlace_simulado = FALSE WHERE id = $1`, [B.id]);
        r = await get('/configuracion', B);
        caso('de prueba con gov_pui_clave pero sin enlace simulado: pendiente', json(r).aprobacion_gobierno === 'pendiente');

        console.log('\n── Formato de 12 h (PDF)');
        caso('hora12: 00:05, 09:40, 12:00, 15:30, 23:59',
            ['00:05', '09:40', '12:00', '15:30', '23:59'].map(hora12).join('|') === '12:05 a.m.|9:40 a.m.|12:00 p.m.|3:30 p.m.|11:59 p.m.');
        const pdf = await fetch(`${BASE_URL}/historial/exportar?formato=pdf`, { headers: { 'x-hotel-key': A.pui_clave, Authorization: `Bearer ${A.gerente}` } });
        caso('PDF del día se sigue generando', pdf.status === 200 && (pdf.headers.get('content-type') || '').includes('pdf'));
    } catch (err) {
        fallas++;
        console.error('ERROR', err);
    } finally {
        const ids = hoteles.map((h) => h.id);
        await withAdminContext(async (c) => {
            for (const t of ['pui_notificaciones', 'check_ins']) await c.query(`DELETE FROM ${t} WHERE hotel_id = ANY($1)`, [ids]);
        }).catch((e) => console.error('limpieza', e.message));
        await pool.query('DELETE FROM hoteles WHERE id = ANY($1)', [ids]).catch((e) => console.error('limpieza', e.message));
        console.log(`\n${fallas === 0 ? 'Todas las pruebas pasaron.' : `${fallas} prueba(s) fallaron.`}`);
        process.exit(fallas === 0 ? 0 : 1);
    }
})();
