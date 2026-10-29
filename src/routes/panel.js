/**
 * Panel y Configuración v2 (tarea 7): los usan /panel-nuevo y
 * /configuracion-nuevo del frontend. Las rutas viejas (/check-ins/resumen,
 * /hoteles/config) no cambian.
 *
 *   GET /panel           cifras de hoy con el vocabulario de estados de la
 *                        tarea 5 + los últimos 5 check-ins
 *   GET /configuracion   datos del hotel y si las credenciales existen
 *
 * Auth: x-hotel-key + JWT de staff + soloGerente: Recepción recibe 403
 * aunque llame al API directo. RLS: withHotelContext.
 *
 * Configuración nunca devuelve credenciales ni partes de ellas (ni la
 * pui_clave ni la gov_pui_clave): solo si existen. Logs sin datos personales.
 */
const express = require('express');
const { pool, withHotelContext } = require('../db');
const { logger } = require('../middleware/logger');
const { requireUsuarioStaff, soloGerente } = require('../middleware/auth');
const { requireHotel } = require('./checkIns');
const { zonaDelHotel, fechaLocal, horaLocal } = require('../utils/zonaHoraria');
const { ESTADOS, hotelEnlazado } = require('../utils/estadoPui');
const { datosHotel, consultaRango } = require('./historial');

const router = express.Router();

const MAX_ULTIMOS = 5;

router.get('/panel', requireHotel, requireUsuarioStaff, soloGerente, async (req, res) => {
    const zona = zonaDelHotel(req.hotel);
    const hoy = fechaLocal(new Date(), zona);
    try {
        const hotel = await datosHotel(req);
        // Mismos parámetros que /historial ($1 hotel, $2 desde, $3 hasta, $4 zona, $5 enlazado)
        const p = [req.hotel.id, hoy, hoy, zona, hotel.enlazado];
        const r = await withHotelContext(req.hotel.id, async (c) => {
            const resumen = await c.query(
                `SELECT estado_v2, COUNT(*)::int AS n FROM (${consultaRango({ conFiltros: false })}) x GROUP BY estado_v2`, p
            );
            const ultimos = await c.query(
                `${consultaRango({ conFiltros: false })} ORDER BY t.fecha_checkin DESC, t.id DESC LIMIT ${MAX_ULTIMOS}`, p
            );
            return { resumen: resumen.rows, ultimos: ultimos.rows };
        });
        const conteo = Object.fromEntries(ESTADOS.map((e) => [e, 0]));
        for (const { estado_v2, n } of r.resumen) conteo[estado_v2] = n;
        return res.json({
            fecha_local: hoy,
            hotel_enlazado: hotel.enlazado,
            resumen: { total: Object.values(conteo).reduce((a, b) => a + b, 0), ...conteo },
            ultimos: r.ultimos.map((f) => ({
                id: f.id,
                nombre: f.nombre,
                primer_apellido: f.primer_apellido,
                segundo_apellido: f.segundo_apellido,
                numero_habitacion: f.numero_habitacion,
                fecha_local: fechaLocal(f.fecha_checkin, zona),
                hora_local: horaLocal(f.fecha_checkin, zona),
                estado: f.estado_v2,
                aviso: f.aviso_v2,
            })),
        });
    } catch (err) {
        logger.error('Error en panel', { error: err.message, hotel_id: req.hotel.id });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.get('/configuracion', requireHotel, requireUsuarioStaff, soloGerente, async (req, res) => {
    try {
        const r = await pool.query(
            `SELECT nombre, rfc, pui_clave, gov_pui_clave, es_prueba, enlace_simulado FROM hoteles WHERE id = $1`,
            [req.hotel.id]
        );
        if (r.rowCount === 0) return res.status(404).json({ error: 'Hotel no encontrado' });
        const h = r.rows[0];
        // Solo booleanos derivados: ningún carácter de las claves sale de aquí
        return res.json({
            nombre: h.nombre,
            rfc: h.rfc,
            credencial_pui: h.pui_clave ? 'configurada' : 'pendiente',
            // Mismo criterio que el resto de la app (utils/estadoPui.js): un
            // hotel de prueba solo cuenta como aprobado con el enlace simulado
            // y fuera de producción
            aprobacion_gobierno: hotelEnlazado(h) ? 'aprobada' : 'pendiente',
        });
    } catch (err) {
        logger.error('Error en configuración', { error: err.message, hotel_id: req.hotel.id });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
