/**
 * Pruebas de GET /historial, /historial/:id y /historial/exportar (tarea 5).
 *
 *   npm run test:historial   (con el backend corriendo: Postgres; Redis no hace falta)
 *
 * Crea dos hoteles propios (A enlazado con una gov_pui_clave falsa, B sin
 * enlace), inserta check-ins y avisos inventados directamente en la BD y los
 * borra al final. No llama a la PUI: los check-ins se insertan ya
 * "encolados" para que el worker y el reencolador no los toquen.
 */
require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { pool, withAdminContext, withHotelContext } = require('../src/db');

const BASE_URL = process.env.TEST_URL || 'http://localhost:8080';
const ZONA = 'America/Mexico_City';
let fallas = 0;
function caso(nombre, ok, detalle = '') {
    if (!ok) fallas++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
}

const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: ZONA });
const diasAtras = (n) => new Date(Date.now() - n * 86400000).toLocaleDateString('en-CA', { timeZone: ZONA });

async function crearHotel(sufijo, gov) {
    const id = crypto.randomBytes(3).toString('hex').toUpperCase();
    const { rows } = await pool.query(
        `INSERT INTO hoteles (nombre, rfc, pui_clave, gov_pui_clave) VALUES ($1, $2, $3, $4) RETURNING id, nombre, pui_clave`,
        [`HOTEL HISTORIAL ${sufijo}`, `TSH${id}${sufijo}`, `PruebaHist-${id}-${sufijo}`, gov]
    );
    const h = rows[0];
    const token = (rol) => jwt.sign({ sub: 0, email: `${rol}@local`, nombre: `${rol} prueba`, rol, hotel_id: h.id }, process.env.JWT_SECRET, { expiresIn: '10m' });
    h.recepcion = token('recepcionista');
    h.gerente = token('gerente');
    return h;
}

async function checkIn(h, datos) {
    const { rows } = await withHotelContext(h.id, (c) => c.query(
        `INSERT INTO check_ins (hotel_id, curp, nombre, primer_apellido, segundo_apellido, numero_habitacion, folio_pms,
                                fecha_checkin, estado_pui, encolado_pui, registrado_por, metodo_captura)
         VALUES ($1,$2,$3,$4,$5,$6,$7, ($8::timestamp AT TIME ZONE $9), $10, TRUE, $11, $12) RETURNING id`,
        [h.id, datos.curp, datos.nombre, datos.primer ?? 'PRUEBA', datos.segundo ?? null, datos.hab ?? '101', datos.folio ?? null,
            `${datos.fecha ?? hoy()} ${datos.hora ?? '10:00'}`, ZONA, datos.estado ?? 'sin_reporte', 'Ana Prueba', datos.metodo ?? null]
    ));
    return rows[0].id;
}

async function aviso(h, checkInId, estado, fase = 3) {
    await withAdminContext((c) => c.query(
        `INSERT INTO pui_notificaciones (hotel_id, reporte_id, fase, check_in_id, huella, estado)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [h.id, `REP-${crypto.randomUUID()}`, fase, checkInId, crypto.randomUUID(), estado]
    ));
}

async function get(ruta, h, rol = 'gerente', otraClave = null) {
    const res = await fetch(`${BASE_URL}${ruta}`, {
        headers: { 'x-hotel-key': otraClave ?? h.pui_clave, Authorization: `Bearer ${h[rol]}` },
    });
    const tipo = res.headers.get('content-type') || '';
    const cuerpo = tipo.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, tipo, cuerpo };
}

(async () => {
    const hoteles = [];
    try {
        const A = await crearHotel('A', 'clave-falsa-de-prueba'); hoteles.push(A);
        const B = await crearHotel('B', null); hoteles.push(B);

        // ── Datos de A (enlazado): un check-in por estado ──
        const ids = {
            sin: await checkIn(A, { curp: 'PEGJ900101HDFRRN05', nombre: 'JOSÉ', primer: 'PÉREZ', hab: '101, 102', folio: 'F-1', estado: 'sin_reporte', metodo: 'ocr' }),
            revision: await checkIn(A, { curp: 'LOMA010203MJCPRNA1', nombre: 'ANA', primer: 'LÓPEZ', hab: '202', estado: 'pendiente', hora: '00:05' }),
            error: await checkIn(A, { curp: 'MUAL800101MDFRRN09', nombre: 'MARTA', primer: 'MUÑOZ', hab: '303', estado: 'error', hora: '23:55' }),
            enviadoViejo: await checkIn(A, { curp: 'NUAL800101MDFRRN04', nombre: 'NORA', hab: '404', estado: 'enviado' }),
            avisoError: await checkIn(A, { curp: 'OUAL800101MDFRRN07', nombre: 'OSCAR', hab: '405', estado: 'error' }),
            rechazado: await checkIn(A, { curp: 'QUAL800101MDFRRN02', nombre: 'QUIQUE', hab: '406', estado: 'error' }),
            multiple: await checkIn(A, { curp: 'RUAL800101MDFRRN08', nombre: 'RAUL', hab: '407', estado: 'enviado' }),
            pendienteAviso: await checkIn(A, { curp: 'SUAL800101MDFRRN03', nombre: 'SARA', hab: '408', estado: 'pendiente' }),
            ayer: await checkIn(A, { curp: 'TUAL800101MDFRRN06', nombre: 'TERESA', hab: '509', fecha: diasAtras(1) }),
        };
        await aviso(A, ids.avisoError, 'error');
        await aviso(A, ids.rechazado, 'rechazada', 2);
        await aviso(A, ids.multiple, 'multiple');
        await aviso(A, ids.pendienteAviso, 'enviando');
        await withHotelContext(A.id, (c) => c.query(
            `INSERT INTO check_ins_ediciones (check_in_id, hotel_id, campo, valor_anterior, valor_nuevo, editado_por)
             VALUES ($1, $2, 'folio_pms', 'F-0', 'F-1', 'Ana Prueba')`, [ids.sin, A.id]
        ));
        // ── Datos de B (sin enlace): mismo nombre que en A, estados variados ──
        await checkIn(B, { curp: 'PEGJ900101HDFRRN05', nombre: 'JOSÉ', primer: 'PÉREZ', estado: 'sin_reporte' });
        await checkIn(B, { curp: 'BBBB900101HDFRRN05', nombre: 'BETO', estado: 'error' });

        console.log('\n── Rango por rol');
        let r = await get('/historial', A, 'recepcion');
        caso('Recepción: hoy sin parámetros → 200', r.status === 200 && r.cuerpo.rango.desde === hoy() && r.cuerpo.puede_elegir_rango === false);
        r = await get(`/historial?desde=${diasAtras(1)}&hasta=${hoy()}`, A, 'recepcion');
        caso('Recepción: pedir ayer → 403', r.status === 403, `${r.status} ${r.cuerpo.error}`);
        r = await get(`/historial/exportar?formato=csv&desde=${diasAtras(1)}&hasta=${diasAtras(1)}`, A, 'recepcion');
        caso('Recepción: exportar ayer → 403', r.status === 403);
        r = await get(`/historial?desde=${diasAtras(1)}&hasta=${hoy()}`, A, 'gerente');
        caso('Gerencia: ayer y hoy → incluye el de ayer', r.status === 200 && r.cuerpo.resumen.total === 9, String(r.cuerpo.resumen?.total));
        r = await get(`/historial?desde=${hoy()}&hasta=${diasAtras(1)}`, A, 'gerente');
        caso('Desde posterior a Hasta → 400', r.status === 400);
        r = await get(`/historial?desde=${diasAtras(400)}&hasta=${hoy()}`, A, 'gerente');
        caso('Rango de más de 366 días → 400', r.status === 400);
        r = await get('/historial', A, 'recepcion', B.pui_clave);
        caso('JWT de un hotel con la x-hotel-key de otro → 403', r.status === 403);

        console.log('\n── Mapeo de estados (hotel A enlazado)');
        r = await get('/historial?limit=100', A, 'gerente');
        const por = Object.fromEntries(r.cuerpo.checkins.map((c) => [c.id, c]));
        const es = (id, estado, aviso) => por[id]?.estado === estado && (aviso === undefined || por[id]?.aviso === aviso);
        caso('sin_reporte → Sin coincidencia', es(ids.sin, 'sin_coincidencia'));
        caso('pendiente → En revisión', es(ids.revision, 'en_revision'));
        caso('error sin aviso → Error al verificar', es(ids.error, 'error'));
        caso('enviado sin fila de aviso (anterior a 4c) → Coincidencia / aviso enviado', es(ids.enviadoViejo, 'coincidencia', 'enviado'));
        caso('error con aviso en error → Coincidencia / aviso con error', es(ids.avisoError, 'coincidencia', 'error'));
        caso('aviso rechazado (400) → Coincidencia / rechazado', es(ids.rechazado, 'coincidencia', 'rechazado'));
        caso('aviso 300 → Coincidencia / múltiple', es(ids.multiple, 'coincidencia', 'multiple'));
        caso('aviso enviándose → Coincidencia / pendiente', es(ids.pendienteAviso, 'coincidencia', 'pendiente'));
        const res = r.cuerpo.resumen;
        caso('contadores con el mismo mapeo (incluye Error)',
            res.total === 8 && res.sin_coincidencia === 1 && res.en_revision === 1 && res.error === 1 && res.coincidencia === 5 && res.registrado === 0,
            JSON.stringify(res));
        caso('hora local del hotel (00:05 y 23:55 siguen siendo hoy)', por[ids.revision]?.hora_local === '00:05' && por[ids.error]?.hora_local === '23:55');
        caso('CURP enmascarada en la lista', por[ids.sin]?.curp === 'PEGJ**************');
        caso('es_hoy en la lista', por[ids.sin]?.es_hoy === true);

        console.log('\n── Hotel B sin enlace');
        r = await get('/historial', B, 'gerente');
        caso('todos "Registrado" aunque estado_pui diga error', r.cuerpo.hotel_enlazado === false && r.cuerpo.checkins.every((c) => c.estado === 'registrado') && r.cuerpo.resumen.registrado === 2);

        console.log('\n── Filtro y búsqueda');
        r = await get('/historial?estado=coincidencia', A, 'recepcion');
        caso('filtro Coincidencia: 5', r.cuerpo.total === 5 && r.cuerpo.checkins.every((c) => c.estado === 'coincidencia'));
        caso('el resumen no cambia con el filtro', r.cuerpo.resumen.total === 8);
        r = await get('/historial?estado=inventado', A);
        caso('estado desconocido → 400', r.status === 400);
        r = await get(`/historial?q=${encodeURIComponent('perez')}`, A, 'recepcion');
        caso('"perez" encuentra "PÉREZ" (sin acentos)', r.cuerpo.total === 1 && r.cuerpo.checkins[0].id === ids.sin);
        r = await get(`/historial?q=${encodeURIComponent('Muñoz')}`, A);
        caso('"Muñoz" encuentra "MUÑOZ"', r.cuerpo.total === 1 && r.cuerpo.checkins[0].id === ids.error);
        r = await get(`/historial?q=${encodeURIComponent('munoz')}`, A);
        caso('"munoz" también', r.cuerpo.total === 1);
        r = await get('/historial?q=LOMA01', A);
        caso('por CURP parcial', r.cuerpo.total === 1 && r.cuerpo.checkins[0].id === ids.revision);
        r = await get(`/historial?q=${encodeURIComponent('101, 102')}`, A);
        caso('por habitación "101, 102"', r.cuerpo.total === 1);
        r = await get('/historial?q=F-1', A);
        caso('por folio', r.cuerpo.total === 1 && r.cuerpo.checkins[0].id === ids.sin);
        r = await get(`/historial?q=${encodeURIComponent('%%')}`, A);
        caso('comodines como texto literal ("%%" no trae todo)', r.status === 200 && r.cuerpo.total === 0);
        r = await get('/historial?q=a', A);
        caso('búsqueda de 1 letra → 400', r.status === 400);
        r = await get(`/historial?q=${encodeURIComponent('perez')}`, B);
        caso('el otro hotel solo ve su propio PÉREZ', r.cuerpo.total === 1 && !r.cuerpo.checkins.some((c) => Object.values(ids).includes(c.id)));
        r = await get(`/historial?q=perez&estado=coincidencia`, A);
        caso('búsqueda + filtro sin resultados → total 0 con resumen del rango', r.cuerpo.total === 0 && r.cuerpo.resumen.total === 8);

        console.log('\n── Detalle');
        r = await get(`/historial/${ids.sin}`, A, 'recepcion');
        caso('CURP completa, método, registrado por', r.status === 200 && r.cuerpo.curp_completa === 'PEGJ900101HDFRRN05'
            && r.cuerpo.metodo_texto === 'Escáner de INE' && r.cuerpo.registrado_por === 'Ana Prueba');
        caso('historial de ediciones', r.cuerpo.ediciones?.length === 1 && r.cuerpo.ediciones[0].valor_anterior === 'F-0' && r.cuerpo.ediciones[0].editado_por === 'Ana Prueba');
        r = await get(`/historial/${ids.ayer}`, A, 'recepcion');
        caso('Recepción: detalle de ayer → 403', r.status === 403);
        r = await get(`/historial/${ids.ayer}`, A, 'gerente');
        caso('Gerencia: detalle de ayer → 200', r.status === 200);
        r = await get(`/historial/${ids.sin}`, B, 'gerente');
        caso('detalle de un check-in de otro hotel → 404', r.status === 404);

        console.log('\n── Exportar');
        r = await get('/historial/exportar?formato=csv&estado=coincidencia', A, 'recepcion');
        const csv = r.cuerpo.toString('utf8');
        caso('CSV 200 con BOM y encabezado nuevo', r.status === 200 && csv.startsWith('﻿"Fecha","Hora","Habitación"'));
        caso('CSV respeta el filtro (5 filas + encabezado)', csv.trim().split('\r\n').length === 6, String(csv.trim().split('\r\n').length));
        caso('CSV usa los nombres nuevos', csv.includes('"Coincidencia (aviso rechazado por la PUI)"') && !/Sin reporte|"Enviado"/.test(csv));
        r = await get(`/historial/exportar?formato=csv&q=${encodeURIComponent('101, 102')}`, A);
        caso('CSV: "101, 102" en una sola celda', r.cuerpo.toString('utf8').includes('"101, 102"'));
        r = await get('/historial/exportar?formato=pdf', A, 'recepcion');
        caso('PDF 200', r.status === 200 && r.tipo.includes('application/pdf') && r.cuerpo.subarray(0, 4).toString() === '%PDF');
        r = await get('/historial/exportar?formato=xls', A);
        caso('formato desconocido → 400', r.status === 400);

        const { generarCsv } = require('../src/routes/historial');
        const linea = generarCsv([{ fecha: '2026-10-27', hora: '10:00', habitacion: '=1+1', folio: '-2', curp: 'X', nombre: 'A "B"', primer_apellido: '', segundo_apellido: '', estado: 'Registrado', metodo: '', registrado_por: '@x' }]).split('\r\n')[1];
        caso('CSV sin fórmulas ni comillas rotas', linea.includes(`"'=1+1"`) && linea.includes(`"'-2"`) && linea.includes('"A ""B"""') && linea.includes(`"'@x"`), linea);
    } catch (err) {
        fallas++;
        console.error('ERROR', err);
    } finally {
        const ids = hoteles.map((h) => h.id);
        await withAdminContext(async (c) => {
            for (const t of ['pui_notificaciones', 'check_ins_ediciones', 'check_ins']) await c.query(`DELETE FROM ${t} WHERE hotel_id = ANY($1)`, [ids]);
        }).catch((e) => console.error('limpieza', e.message));
        await pool.query('DELETE FROM hoteles WHERE id = ANY($1)', [ids]).catch((e) => console.error('limpieza', e.message));
        console.log(`\n${fallas === 0 ? 'Todas las pruebas pasaron.' : `${fallas} prueba(s) fallaron.`}`);
        process.exit(fallas === 0 ? 0 : 1);
    }
})();
