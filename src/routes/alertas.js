/**
 * Alertas v2 (tarea 6): lo usa /alertas-nuevo del frontend y el contador de
 * la navegación de las pantallas nuevas. Las rutas viejas
 * (/reportes-activos, /reportes-historial) no cambian.
 *
 *   GET /alertas            pantalla de alertas; la respuesta depende del rol
 *   GET /alertas/contador   solo el número del contador (ambos roles)
 *
 * Auth: x-hotel-key + JWT de staff (requireUsuarioStaff), así el servidor
 * conoce el rol.
 *
 * Privacidad (decisión del usuario, se aplica AQUÍ y no en la página):
 * Recepción recibe solo { rol, estado, contador }, nunca nombre, habitación,
 * CURP (ni enmascarada), fechas del check-in ni datos del reporte, aunque
 * llame al API directamente. Gerencia recibe el detalle.
 *
 * Criterio del contador (solo con el hotel enlazado; sin enlace es 0):
 *   coincidencias  pares distintos (reporte ACTIVO, check-in), sacados de lo
 *                  que el sistema de verdad decidió avisar:
 *                    a) avisos de fase 2/3 ligados a un check-in;
 *                    b) aviso de fase 1 (completar datos) → el check-in más
 *                       reciente de esa CURP, que es el que usó la fase 1;
 *                    c) check-ins con estado_pui = 'enviado' de antes de la
 *                       4c (sin ninguna fila de aviso) cuya CURP es la del
 *                       reporte.
 *                  Cada par cuenta UNA vez, sea cual sea el estado de su
 *                  aviso (enviado, pendiente, error, rechazado, múltiple).
 *   + avisos con error que no son de una coincidencia: reportes activos con
 *                  busqueda_estado = 'error' (/busqueda-finalizada agotó
 *                  sus reintentos; el reencolador lo vuelve a intentar).
 * Un aviso con error o rechazado de una coincidencia ya está contado en su
 * par, así no se cuenta dos veces. Los reportes cerrados no cuentan.
 *
 * Logs sin datos personales: solo hotel y conteos.
 */
const express = require('express');
const { pool, withHotelContext } = require('../db');
const { logger } = require('../middleware/logger');
const { requireUsuarioStaff } = require('../middleware/auth');
const { requireHotel } = require('./checkIns');
const { zonaDelHotel, fechaLocal, horaLocal } = require('../utils/zonaHoraria');
const { hotelEnlazado } = require('../utils/estadoPui');

const router = express.Router();

const MAX_CERRADOS = 50;

// pui_notificaciones.estado → estado del aviso en la pantalla
const AVISO = {
    enviada: 'enviado',
    multiple: 'multiple',
    enviando: 'pendiente',
    error: 'error',
    rechazada: 'rechazado',
};
// Orden en la lista: lo que el gobierno aún no recibió va primero
const PRIORIDAD_AVISO = { rechazado: 0, error: 1, pendiente: 2, multiple: 3, enviado: 4 };

/**
 * Pares (reporte activo, check-in) del criterio del contador. $1 = hotel.
 * Columnas: reporte_id, check_in_id, estado (de pui_notificaciones), fase,
 * http_status, intentos, actualizado_en (NULL en los de antes de la 4c).
 */
const SQL_PARES = `
    WITH ra AS (
        SELECT id, curp FROM reportes_activos WHERE hotel_id = $1 AND activo
    ),
    n23 AS (
        SELECT DISTINCT ON (n.reporte_id, n.check_in_id)
               n.reporte_id, n.check_in_id, n.estado, n.fase, n.http_status, n.intentos, n.actualizado_en
        FROM pui_notificaciones n JOIN ra ON ra.id = n.reporte_id
        WHERE n.hotel_id = $1 AND n.fase IN (2, 3) AND n.check_in_id > 0
        ORDER BY n.reporte_id, n.check_in_id, n.actualizado_en DESC, n.id DESC
    ),
    n1 AS (
        SELECT DISTINCT ON (n.reporte_id)
               n.reporte_id,
               (SELECT c.id FROM check_ins c WHERE c.hotel_id = $1 AND c.curp = ra.curp
                ORDER BY c.fecha_checkin DESC, c.id DESC LIMIT 1) AS check_in_id,
               n.estado, n.fase, n.http_status, n.intentos, n.actualizado_en
        FROM pui_notificaciones n JOIN ra ON ra.id = n.reporte_id
        WHERE n.hotel_id = $1 AND n.fase = 1
        ORDER BY n.reporte_id, n.actualizado_en DESC, n.id DESC
    ),
    previos AS (
        SELECT ra.id AS reporte_id, c.id AS check_in_id, 'enviada'::text AS estado, NULL::smallint AS fase,
               NULL::int AS http_status, NULL::int AS intentos, NULL::timestamptz AS actualizado_en
        FROM ra JOIN check_ins c ON c.hotel_id = $1 AND c.curp = ra.curp AND c.estado_pui = 'enviado'
        WHERE NOT EXISTS (SELECT 1 FROM pui_notificaciones x
                          WHERE x.hotel_id = $1 AND x.check_in_id = c.id AND x.fase IN (2, 3))
    )
    SELECT * FROM n23
    UNION ALL
    SELECT * FROM n1
    WHERE n1.check_in_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM n23 WHERE n23.reporte_id = n1.reporte_id AND n23.check_in_id = n1.check_in_id)
    UNION ALL
    SELECT * FROM previos p
    WHERE NOT EXISTS (SELECT 1 FROM n1 WHERE n1.reporte_id = p.reporte_id AND n1.check_in_id = p.check_in_id)`;

const SQL_BUSQUEDA_ERROR = `
    SELECT COUNT(*)::int AS n FROM reportes_activos
    WHERE hotel_id = $1 AND activo AND busqueda_estado = 'error'`;

/** Enlace del hotel con la PUI (req.hotel de requireHotel no trae gov_pui_clave). */
async function enlaceDelHotel(hotelId) {
    const r = await pool.query(`SELECT gov_pui_clave, es_prueba, enlace_simulado FROM hoteles WHERE id = $1`, [hotelId]);
    return hotelEnlazado(r.rows[0]);
}

/** Contador de la navegación con el criterio de arriba. */
async function contarAlertas(hotelId) {
    return withHotelContext(hotelId, async (c) => {
        const pares = await c.query(`SELECT COUNT(*)::int AS n FROM (${SQL_PARES}) p`, [hotelId]);
        const busqueda = await c.query(SQL_BUSQUEDA_ERROR, [hotelId]);
        return pares.rows[0].n + busqueda.rows[0].n;
    });
}

/** "PELA***": solo las 4 primeras letras de la CURP del reporte. */
const curpCorta = (curp) => `${String(curp || '').slice(0, 4)}***`;

function avisoDe(par, zona) {
    const estado = AVISO[par.estado] ?? 'error';
    const fecha = par.actualizado_en;
    // La fecha solo se muestra cuando el gobierno ya respondió
    const conFecha = fecha && ['enviado', 'multiple', 'rechazado'].includes(estado);
    return {
        estado,
        fase: par.fase,
        intentos: par.intentos,
        fecha_local: conFecha ? fechaLocal(fecha, zona) : null,
        hora_local: conFecha ? horaLocal(fecha, zona) : null,
    };
}

async function detalleGerente(hotelId, zona) {
    return withHotelContext(hotelId, async (c) => {
        const pares = await c.query(
            `SELECT p.*, ch.nombre, ch.primer_apellido, ch.segundo_apellido, ch.numero_habitacion,
                    ch.fecha_checkin, ch.registrado_por
             FROM (${SQL_PARES}) p JOIN check_ins ch ON ch.hotel_id = $1 AND ch.id = p.check_in_id`,
            [hotelId]
        );
        const activos = await c.query(
            `SELECT id, curp, recibido_en, busqueda_estado FROM reportes_activos
             WHERE hotel_id = $1 AND activo ORDER BY recibido_en DESC, id`,
            [hotelId]
        );
        const cerrados = await c.query(
            `SELECT curp, recibido_en, desactivado_en FROM reportes_activos
             WHERE hotel_id = $1 AND NOT activo
             ORDER BY desactivado_en DESC NULLS LAST, recibido_en DESC, id LIMIT ${MAX_CERRADOS}`,
            [hotelId]
        );
        const totalCerrados = await c.query(
            `SELECT COUNT(*)::int AS n FROM reportes_activos WHERE hotel_id = $1 AND NOT activo`, [hotelId]
        );
        return { pares: pares.rows, activos: activos.rows, cerrados: cerrados.rows, totalCerrados: totalCerrados.rows[0].n };
    });
}

router.get('/alertas/contador', requireHotel, requireUsuarioStaff, async (req, res) => {
    try {
        const enlazado = await enlaceDelHotel(req.hotel.id);
        const contador = enlazado ? await contarAlertas(req.hotel.id) : 0;
        return res.json({ contador });
    } catch (err) {
        logger.error('Error en contador de alertas', { error: err.message, hotel_id: req.hotel.id });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.get('/alertas', requireHotel, requireUsuarioStaff, async (req, res) => {
    const esGerente = req.usuarioStaff.rol === 'gerente';
    try {
        const enlazado = await enlaceDelHotel(req.hotel.id);
        if (!enlazado) {
            return res.json({ rol: req.usuarioStaff.rol, estado: 'no_enlazado', contador: 0 });
        }

        if (!esGerente) {
            // Recepción: solo el conteo y el estado general. Los reportes sin
            // coincidencia se ven igual que "sin coincidencias".
            const contador = await contarAlertas(req.hotel.id);
            return res.json({
                rol: req.usuarioStaff.rol,
                estado: contador > 0 ? 'requiere_atencion' : 'sin_coincidencias',
                contador,
            });
        }

        const zona = zonaDelHotel(req.hotel);
        const d = await detalleGerente(req.hotel.id, zona);
        const coincidenciasPorReporte = {};
        for (const p of d.pares) coincidenciasPorReporte[p.reporte_id] = (coincidenciasPorReporte[p.reporte_id] || 0) + 1;

        const coincidencias = d.pares
            .map((p) => ({
                check_in_id: p.check_in_id,
                nombre: p.nombre,
                primer_apellido: p.primer_apellido,
                segundo_apellido: p.segundo_apellido,
                numero_habitacion: p.numero_habitacion,
                fecha_local: fechaLocal(p.fecha_checkin, zona),
                hora_local: horaLocal(p.fecha_checkin, zona),
                registrado_por: p.registrado_por,
                aviso: avisoDe(p, zona),
                _orden: new Date(p.fecha_checkin).getTime(),
            }))
            .sort((a, b) => (PRIORIDAD_AVISO[a.aviso.estado] - PRIORIDAD_AVISO[b.aviso.estado]) || (b._orden - a._orden))
            .map(({ _orden, ...c }) => c);

        const reportesActivos = d.activos.map((r) => ({
            curp: curpCorta(r.curp),
            recibido_local: fechaLocal(r.recibido_en, zona),
            busqueda: r.busqueda_estado,
            coincidencias: coincidenciasPorReporte[r.id] || 0,
        }));
        const busquedaError = d.activos.filter((r) => r.busqueda_estado === 'error').length;
        const contador = d.pares.length + busquedaError;

        let estado = 'sin_reportes';
        if (coincidencias.length > 0) estado = 'coincidencia';
        else if (reportesActivos.length > 0) estado = 'reportes_sin_coincidencia';

        return res.json({
            rol: req.usuarioStaff.rol,
            estado,
            contador,
            coincidencias,
            reportes_activos: reportesActivos,
            reportes_cerrados: d.cerrados.map((r) => ({
                curp: curpCorta(r.curp),
                recibido_local: fechaLocal(r.recibido_en, zona),
                cerrado_local: r.desactivado_en ? fechaLocal(r.desactivado_en, zona) : null,
            })),
            total_cerrados: d.totalCerrados,
        });
    } catch (err) {
        logger.error('Error en alertas', { error: err.message, hotel_id: req.hotel.id });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
module.exports.contarAlertas = contarAlertas;
