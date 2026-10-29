/**
 * Historial v2 (tarea 5): lo usa /historial-nuevo del frontend. Las rutas
 * viejas (GET /check-ins, /check-ins/export, /reportes/pdf) no cambian: las
 * siguen usando las páginas actuales.
 *
 *   GET /historial?desde&hasta&estado&q&limit&offset   lista + contadores
 *   GET /historial/exportar?formato=csv|pdf&desde&hasta&estado&q
 *   GET /historial/:id                                 detalle (CURP completa,
 *                                                      método, ediciones)
 *
 * Auth: x-hotel-key + JWT de staff (requireUsuarioStaff), así el servidor
 * conoce el rol. Rango: Recepción solo el día de hoy (403 si pide otro; hasta
 * ahora eso solo lo imponía la página vieja), Gerencia cualquier rango de
 * hasta 366 días. "Hoy" y las horas en la zona del hotel (utils/zonaHoraria).
 * Estados con el vocabulario de utils/estadoPui.js. RLS: withHotelContext.
 * Logs sin datos personales (el término de búsqueda no se loguea).
 */
const express = require('express');
const { pool, withHotelContext } = require('../db');
const { logger } = require('../middleware/logger');
const { requireUsuarioStaff } = require('../middleware/auth');
const { requireHotel } = require('./checkIns');
const { enmascararCURP } = require('../utils/curp');
const { zonaDelHotel, fechaLocal, horaLocal } = require('../utils/zonaHoraria');
const { ESTADOS, sqlEstado, textoEstado, hotelEnlazado } = require('../utils/estadoPui');
const { generarPdfHistorial } = require('../services/historialPdf');

const router = express.Router();

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DIAS = 366;
const MAX_EXPORTAR = 10000;

const METODOS = {
    ocr: 'Escáner de INE',
    qr: 'QR de la credencial',
    lector: 'Lector USB',
    frecuente: 'Huésped frecuente',
    manual: 'Captura manual',
};

/** Hotel con su enlace a la PUI (req.hotel de requireHotel no trae gov_pui_clave). */
async function datosHotel(req) {
    const r = await pool.query(`SELECT gov_pui_clave, es_prueba, enlace_simulado FROM hoteles WHERE id = $1`, [req.hotel.id]);
    return { ...req.hotel, enlazado: hotelEnlazado(r.rows[0]) };
}

/** Valida rango, filtro y búsqueda según el rol. Devuelve { error, status } o los filtros. */
function leerFiltros(req) {
    const zona = zonaDelHotel(req.hotel);
    const hoy = fechaLocal(new Date(), zona);
    const desde = String(req.query.desde || hoy);
    const hasta = String(req.query.hasta || desde);
    if (!FECHA.test(desde) || !FECHA.test(hasta)) return { status: 400, error: 'Fechas con formato YYYY-MM-DD' };
    if (desde > hasta) return { status: 400, error: '"Desde" no puede ser posterior a "Hasta"' };
    if (req.usuarioStaff.rol !== 'gerente' && (desde !== hoy || hasta !== hoy)) {
        return { status: 403, error: 'Recepción solo puede consultar el día de hoy' };
    }
    const dias = (Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86400000;
    if (dias > MAX_DIAS) return { status: 400, error: `El rango máximo es de ${MAX_DIAS} días` };

    const estado = req.query.estado ? String(req.query.estado) : null;
    if (estado && !ESTADOS.includes(estado)) return { status: 400, error: 'Estado PUI desconocido' };

    let q = req.query.q ? String(req.query.q).trim() : '';
    if (q && q.length < 2) return { status: 400, error: 'Escribe al menos 2 caracteres para buscar' };
    if (q.length > 50) q = q.slice(0, 50);
    // Comodines de LIKE como texto literal (mismo criterio que buscar-por-nombre)
    const patron = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null;

    return { zona, hoy, desde, hasta, estado, patron, hayFiltro: Boolean(estado || q) };
}

/**
 * Consulta del rango con el estado v2 calculado. Parámetros:
 *   $1 hotel, $2 desde, $3 hasta, $4 zona, $5 enlazado, $6 estado, $7 patrón
 */
function consultaRango({ conFiltros }) {
    return `
        SELECT * FROM (
            SELECT c.id, c.curp, c.nombre, c.primer_apellido, c.segundo_apellido,
                   c.numero_habitacion, c.folio_pms, c.fecha_checkin, c.registrado_por,
                   c.metodo_captura, c.editado_tras_escaneo,
                   ${sqlEstado(5)}
            FROM check_ins c
            WHERE c.hotel_id = $1
              AND DATE(c.fecha_checkin AT TIME ZONE $4) BETWEEN $2::date AND $3::date
        ) t
        ${conFiltros ? `WHERE ($6::text IS NULL OR t.estado_v2 = $6)
          AND ($7::text IS NULL
               OR clavepui_sin_acentos(CONCAT_WS(' ', t.nombre, t.primer_apellido, t.segundo_apellido))
                  ILIKE clavepui_sin_acentos($7) ESCAPE '\\'
               OR t.curp ILIKE $7 ESCAPE '\\'
               OR t.numero_habitacion ILIKE $7 ESCAPE '\\'
               OR t.folio_pms ILIKE $7 ESCAPE '\\')` : ''}`;
}

function filaLista(f, zona, hoy) {
    const fecha = fechaLocal(f.fecha_checkin, zona);
    return {
        id: f.id,
        nombre: f.nombre,
        primer_apellido: f.primer_apellido,
        segundo_apellido: f.segundo_apellido,
        curp: enmascararCURP(f.curp),
        numero_habitacion: f.numero_habitacion,
        folio_pms: f.folio_pms,
        fecha_local: fecha,
        hora_local: horaLocal(f.fecha_checkin, zona),
        es_hoy: fecha === hoy,
        estado: f.estado_v2,
        aviso: f.aviso_v2,
    };
}

router.get('/historial', requireHotel, requireUsuarioStaff, async (req, res) => {
    const filtros = leerFiltros(req);
    if (filtros.error) return res.status(filtros.status).json({ error: filtros.error });
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 100);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    try {
        const hotel = await datosHotel(req);
        const p = [req.hotel.id, filtros.desde, filtros.hasta, filtros.zona, hotel.enlazado, filtros.estado, filtros.patron];
        const r = await withHotelContext(req.hotel.id, async (c) => {
            const resumen = await c.query(
                `SELECT estado_v2, COUNT(*)::int AS n FROM (${consultaRango({ conFiltros: false })}) x GROUP BY estado_v2`,
                p.slice(0, 5)
            );
            const total = await c.query(`SELECT COUNT(*)::int AS n FROM (${consultaRango({ conFiltros: true })}) x`, p);
            const filas = await c.query(
                `${consultaRango({ conFiltros: true })} ORDER BY t.fecha_checkin DESC, t.id DESC LIMIT ${limit} OFFSET ${offset}`,
                p
            );
            return { resumen: resumen.rows, total: total.rows[0].n, filas: filas.rows };
        });
        const conteo = Object.fromEntries(ESTADOS.map((e) => [e, 0]));
        for (const { estado_v2, n } of r.resumen) conteo[estado_v2] = n;
        const totalRango = Object.values(conteo).reduce((a, b) => a + b, 0);
        return res.json({
            rango: { desde: filtros.desde, hasta: filtros.hasta, hoy: filtros.hoy },
            hotel_enlazado: hotel.enlazado,
            puede_elegir_rango: req.usuarioStaff.rol === 'gerente',
            resumen: { total: totalRango, ...conteo },
            total: r.total,
            limit,
            offset,
            checkins: r.filas.map((f) => filaLista(f, filtros.zona, filtros.hoy)),
        });
    } catch (err) {
        logger.error('Error en historial', { error: err.message, hotel_id: req.hotel.id });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.get('/historial/exportar', requireHotel, requireUsuarioStaff, async (req, res) => {
    const formato = req.query.formato === 'pdf' ? 'pdf' : req.query.formato === 'csv' ? 'csv' : null;
    if (!formato) return res.status(400).json({ error: 'formato debe ser csv o pdf' });
    const filtros = leerFiltros(req);
    if (filtros.error) return res.status(filtros.status).json({ error: filtros.error });
    try {
        const hotel = await datosHotel(req);
        const p = [req.hotel.id, filtros.desde, filtros.hasta, filtros.zona, hotel.enlazado, filtros.estado, filtros.patron];
        const { rows } = await withHotelContext(req.hotel.id, (c) => c.query(
            `${consultaRango({ conFiltros: true })} ORDER BY t.fecha_checkin DESC, t.id DESC LIMIT ${MAX_EXPORTAR + 1}`, p
        ));
        if (rows.length > MAX_EXPORTAR) {
            return res.status(413).json({ error: `Son más de ${MAX_EXPORTAR} registros: acota el rango o los filtros` });
        }
        const filas = rows.map((f) => ({
            fecha: fechaLocal(f.fecha_checkin, filtros.zona),
            hora: horaLocal(f.fecha_checkin, filtros.zona),
            habitacion: f.numero_habitacion || '',
            folio: f.folio_pms || '',
            curp: f.curp,
            nombre: f.nombre || '',
            primer_apellido: f.primer_apellido || '',
            segundo_apellido: f.segundo_apellido || '',
            estado: textoEstado(f.estado_v2, f.aviso_v2),
            estado_clave: f.estado_v2,
            metodo: METODOS[f.metodo_captura] || '',
            registrado_por: f.registrado_por || '',
        }));
        const base = `checkins_${filtros.desde}${filtros.hasta !== filtros.desde ? `_${filtros.hasta}` : ''}`;
        logger.info('Exportación de historial', {
            type: 'historial_exportar', hotel_id: req.hotel.id, formato, total: filas.length,
            rango: [filtros.desde, filtros.hasta], filtrado: filtros.hayFiltro,
        });
        if (formato === 'csv') {
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
            return res.send(`﻿${generarCsv(filas)}`);
        }
        const pdf = await generarPdfHistorial({ hotel: req.hotel, desde: filtros.desde, hasta: filtros.hasta, filas, filtrado: filtros.hayFiltro });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`);
        return res.send(pdf);
    } catch (err) {
        logger.error('Error exportando historial', { error: err.message, hotel_id: req.hotel.id, formato });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * CSV con todas las celdas entre comillas (comas en nombres o habitaciones
 * "101, 102" no rompen columnas) y sin fórmulas: una celda que empieza con
 * = + - @ o tabulador lleva un apóstrofo delante (inyección en Excel).
 */
function generarCsv(filas) {
    const celda = (v) => {
        let s = String(v ?? '');
        if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
        return `"${s.replace(/"/g, '""')}"`;
    };
    const encabezado = ['Fecha', 'Hora', 'Habitación', 'Folio', 'CURP', 'Nombre', 'Primer apellido',
        'Segundo apellido', 'Estado PUI', 'Capturado por', 'Registrado por'];
    const lineas = filas.map((f) => [f.fecha, f.hora, f.habitacion, f.folio, f.curp, f.nombre, f.primer_apellido,
        f.segundo_apellido, f.estado, f.metodo, f.registrado_por].map(celda).join(','));
    return [encabezado.map(celda).join(','), ...lineas].join('\r\n');
}

router.get('/historial/:id', requireHotel, requireUsuarioStaff, async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID inválido' });
    try {
        const hotel = await datosHotel(req);
        const zona = zonaDelHotel(req.hotel);
        const hoy = fechaLocal(new Date(), zona);
        const r = await withHotelContext(req.hotel.id, async (c) => {
            const fila = await c.query(
                `SELECT c.id, c.curp, c.nombre, c.primer_apellido, c.segundo_apellido, c.numero_habitacion,
                        c.folio_pms, c.fecha_checkin, c.registrado_por, c.metodo_captura, c.editado_tras_escaneo,
                        ${sqlEstado(3)}
                 FROM check_ins c WHERE c.id = $1 AND c.hotel_id = $2`,
                [id, req.hotel.id, hotel.enlazado]
            );
            if (!fila.rowCount) return null;
            const ediciones = await c.query(
                `SELECT campo, valor_anterior, valor_nuevo, editado_por, editado_en
                 FROM check_ins_ediciones WHERE check_in_id = $1 AND hotel_id = $2 ORDER BY editado_en DESC, id DESC`,
                [id, req.hotel.id]
            );
            return { fila: fila.rows[0], ediciones: ediciones.rows };
        });
        if (!r) return res.status(404).json({ error: 'Check-in no encontrado' });
        const f = r.fila;
        const fecha = fechaLocal(f.fecha_checkin, zona);
        if (req.usuarioStaff.rol !== 'gerente' && fecha !== hoy) {
            return res.status(403).json({ error: 'Recepción solo puede consultar el día de hoy' });
        }
        return res.json({
            ...filaLista(f, zona, hoy),
            curp_completa: f.curp,
            registrado_por: f.registrado_por,
            metodo_captura: f.metodo_captura,
            metodo_texto: METODOS[f.metodo_captura] ?? null,
            editado_tras_escaneo: f.editado_tras_escaneo,
            ediciones: r.ediciones.map((e) => ({
                campo: e.campo,
                valor_anterior: e.valor_anterior,
                valor_nuevo: e.valor_nuevo,
                editado_por: e.editado_por,
                fecha_local: fechaLocal(e.editado_en, zona),
                hora_local: horaLocal(e.editado_en, zona),
            })),
        });
    } catch (err) {
        logger.error('Error en detalle de historial', { error: err.message, hotel_id: req.hotel.id });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
module.exports.generarCsv = generarCsv;
// Para routes/panel.js (tarea 7): mismo rango y mismo mapeo de estados
module.exports.datosHotel = datosHotel;
module.exports.consultaRango = consultaRango;
