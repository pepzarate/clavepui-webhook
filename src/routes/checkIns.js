const express = require('express');
const { pool } = require('../db');
const { logger } = require('../middleware/logger');
const { validarFormatoCURP, parsearCURP, enmascararCURP } = require('../utils/curp');
const { encolarNotificacionPUI } = require('../services/puiQueue');

const router = express.Router();

/**
 * Middleware de autenticación para recepcionistas.
 * Por ahora valida un API key por hotel en el header.
 * En la Fase frontend se reemplaza por JWT de sesión.
 */
async function requireHotel(req, res, next) {
    const apiKey = req.headers['x-hotel-key'];

    if (!apiKey) {
        return res.status(401).json({ error: 'API key del hotel requerida' });
    }

    try {
        const result = await pool.query(
            `SELECT id, nombre, rfc
       FROM hoteles
       WHERE pui_clave = $1 AND activo = TRUE`,
            [apiKey]
        );

        if (result.rowCount === 0) {
            return res.status(401).json({ error: 'Hotel no autorizado' });
        }

        req.hotel = result.rows[0];
        next();
    } catch (err) {
        logger.error('Error autenticando hotel', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
}

/**
 * POST /check-ins
 * Registra un nuevo check-in manualmente.
 * Dispara notificación asíncrona a la PUI.
 */
router.post('/check-ins', requireHotel, async (req, res) => {
    const {
        curp,
        nombre,
        primer_apellido,
        segundo_apellido,
        fecha_nacimiento,
        lugar_nacimiento,
        sexo_asignado,
        telefono,
        correo,
        registrado_por,
        numero_habitacion,
    } = req.body;

    // Validar CURP obligatoria
    if (!curp) {
        return res.status(400).json({ error: 'La CURP es obligatoria' });
    }

    if (!validarFormatoCURP(curp)) {
        return res.status(400).json({
            error: 'CURP inválida. Debe tener 18 caracteres en mayúsculas y números.'
        });
    }

    // Extraer datos automáticos de la CURP si no vienen en el body
    const datosCURP = parsearCURP(curp);
    const fechaNac = fecha_nacimiento || datosCURP?.fechaNacimiento;
    const lugarNac = lugar_nacimiento || datosCURP?.lugarNacimiento;
    const sexo = sexo_asignado || datosCURP?.sexoAsignado;

    try {
        // Guardar check-in en BD
        const result = await pool.query(
            `INSERT INTO check_ins
                (hotel_id, curp, nombre, primer_apellido, segundo_apellido,
                fecha_nacimiento, lugar_nacimiento, sexo_asignado,
                telefono, correo, registrado_por, numero_habitacion, estado_pui)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pendiente')
            RETURNING *`,
            [
                req.hotel.id,
                curp,
                nombre,
                primer_apellido,
                segundo_apellido,
                fechaNac,
                lugarNac,
                sexo,
                telefono,
                correo,
                registrado_por || 'recepcion',
                numero_habitacion || null,
            ]
        );

        const checkIn = result.rows[0];

        // Encolar notificación a la PUI de forma asíncrona
        await encolarNotificacionPUI({
            ...checkIn,
            rfc_hotel: req.hotel.rfc,
            // El reporte_pui_id se llenará cuando el gobierno
            // active un reporte de búsqueda para esta CURP
            reporte_pui_id: null,
        });

        logger.info('Check-in registrado', {
            type: 'check_in',
            id: checkIn.id,
            hotel_id: req.hotel.id,
            curp: enmascararCURP(curp),
        });

        return res.status(201).json({
            message: 'Check-in registrado correctamente',
            checkin: {
                id: checkIn.id,
                curp: enmascararCURP(curp),
                nombre: checkIn.nombre,
                primer_apellido: checkIn.primer_apellido,
                segundo_apellido: checkIn.segundo_apellido,
                fecha_checkin: checkIn.fecha_checkin,
                estado_pui: checkIn.estado_pui,
                fecha_nacimiento: fechaNac,
                lugar_nacimiento: lugarNac,
                sexo_asignado: sexo,
                numero_habitacion: checkIn.numero_habitacion,
            },
        });

    } catch (err) {
        logger.error('Error registrando check-in', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * GET /check-ins
 * Lista los check-ins del hotel con filtros opcionales.
 * Soporta: ?fecha=2026-06-12 ?estado=pendiente ?limit=50 ?offset=0
 */
router.get('/check-ins', requireHotel, async (req, res) => {
    const {
        fecha,
        estado,
        limit = 50,
        offset = 0,
    } = req.query;

    try {
        let query = `
      SELECT
        id, curp, nombre, primer_apellido, segundo_apellido,
        fecha_nacimiento, lugar_nacimiento, sexo_asignado,
        numero_habitacion,
        fecha_checkin, estado_pui, intentos_pui, registrado_por
        FROM check_ins
      WHERE hotel_id = $1
    `;
        const params = [req.hotel.id];
        let paramIdx = 2;

        if (fecha) {
            query += ` AND DATE(fecha_checkin AT TIME ZONE 'America/Mexico_City') = $${paramIdx}`;
            params.push(fecha);
            paramIdx++;
        }

        if (estado) {
            query += ` AND estado_pui = $${paramIdx}`;
            params.push(estado);
            paramIdx++;
        }

        query += ` ORDER BY fecha_checkin DESC`;
        query += ` LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
        params.push(Number.parseInt(limit), Number.parseInt(offset));

        const result = await pool.query(query, params);

        // Enmascarar CURPs en la respuesta
        const checkins = result.rows.map(row => ({
            ...row,
            curp: enmascararCURP(row.curp),
        }));

        // Contar totales para paginación
        let countQuery = `SELECT COUNT(*) FROM check_ins WHERE hotel_id = $1`;
        const countParams = [req.hotel.id];
        let countParamIdx = 2;

        if (fecha) {
            countQuery += ` AND DATE(fecha_checkin AT TIME ZONE 'America/Mexico_City') = $${countParamIdx}`;
            countParams.push(fecha);
            countParamIdx++;
        }

        if (estado) {
            countQuery += ` AND estado_pui = $${countParamIdx}`;
            countParams.push(estado);
        }

        const countResult = await pool.query(countQuery, countParams);

        return res.status(200).json({
            total: Number.parseInt(countResult.rows[0].count),
            limit: Number.parseInt(limit),
            offset: Number.parseInt(offset),
            checkins,
        });

    } catch (err) {
        logger.error('Error listando check-ins', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * GET /check-ins/resumen
 * Resumen del día para el dashboard del gerente.
 */
router.get('/check-ins/resumen', requireHotel, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT
         COUNT(*)                                          AS total,
         COUNT(*) FILTER (WHERE estado_pui = 'enviado')   AS enviados,
         COUNT(*) FILTER (WHERE estado_pui = 'pendiente') AS pendientes,
         COUNT(*) FILTER (WHERE estado_pui = 'error')     AS errores
       FROM check_ins
       WHERE hotel_id = $1
         AND DATE(fecha_checkin AT TIME ZONE 'America/Mexico_City') = CURRENT_DATE AT TIME ZONE 'America/Mexico_City'`,
            [req.hotel.id]
        );

        const row = result.rows[0];

        return res.status(200).json({
            fecha: new Date().toISOString().split('T')[0],
            hotel: req.hotel.nombre,
            total: Number.parseInt(row.total),
            enviados: Number.parseInt(row.enviados),
            pendientes: Number.parseInt(row.pendientes),
            errores: Number.parseInt(row.errores),
        });

    } catch (err) {
        logger.error('Error obteniendo resumen', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * GET /check-ins/export
 * Exporta los check-ins en formato CSV para evidencia legal.
 */
router.get('/check-ins/export', requireHotel, async (req, res) => {
    const { fecha_inicio, fecha_fin } = req.query;

    try {
        let query = `
      SELECT
        id, curp, nombre, primer_apellido, segundo_apellido,
        fecha_nacimiento, lugar_nacimiento, sexo_asignado,
        numero_habitacion,
        fecha_checkin, estado_pui, registrado_por
        FROM check_ins
      WHERE hotel_id = $1
    `;
        const params = [req.hotel.id];
        let paramIdx = 2;

        if (fecha_inicio) {
            query += ` AND DATE(fecha_checkin AT TIME ZONE 'America/Mexico_City') >= $${paramIdx}`;
            params.push(fecha_inicio);
            paramIdx++;
        }

        if (fecha_fin) {
            query += ` AND DATE(fecha_checkin AT TIME ZONE 'America/Mexico_City') <= $${paramIdx}`;
            params.push(fecha_fin);
            paramIdx++;
        }

        query += ` ORDER BY fecha_checkin DESC`;

        const result = await pool.query(query, params);

        // Generar CSV
        const headers = [
            'ID', 'CURP', 'Nombre', 'Primer Apellido', 'Segundo Apellido',
            'Fecha Nacimiento', 'Lugar Nacimiento', 'Sexo', 'Habitación',
            'Fecha Check-in', 'Estado PUI', 'Registrado Por'
        ].join(',');

        const rows = result.rows.map(row => [
            row.id,
            row.curp,
            row.nombre || '',
            row.primer_apellido || '',
            row.segundo_apellido || '',
            row.fecha_nacimiento || '',
            row.lugar_nacimiento || '',
            row.sexo_asignado || '',
            row.numero_habitacion || '',
            row.fecha_checkin,
            row.estado_pui,
            row.registrado_por || '',
        ].join(','));

        const csv = [headers, ...rows].join('\n');
        const filename = `checkins_${req.hotel.nombre.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.csv`;

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        logger.info('Export CSV generado', {
            type: 'export_csv',
            hotel_id: req.hotel.id,
            total: result.rows.length,
        });

        return res.send('\uFEFF' + csv); // BOM para Excel en español

    } catch (err) {
        logger.error('Error exportando CSV', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * GET /reportes-activos
 * Lista los reportes de búsqueda activos recibidos de la PUI.
 */
router.get('/reportes-activos', requireHotel, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, curp, nombre, primer_apellido,
              recibido_en, activo
       FROM reportes_activos
       WHERE hotel_id = $1 AND activo = TRUE
       ORDER BY recibido_en DESC`,
            [req.hotel.id]
        );

        return res.status(200).json({ reportes: result.rows });
    } catch (err) {
        logger.error('Error obteniendo reportes activos', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * GET /reportes-historial
 * Lista el historial de reportes (activos e inactivos).
 */
router.get('/reportes-historial', requireHotel, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, curp, nombre, primer_apellido,
              recibido_en, activo
       FROM reportes_activos
       WHERE hotel_id = $1
       ORDER BY recibido_en DESC
       LIMIT 50`,
            [req.hotel.id]
        );

        return res.status(200).json({ reportes: result.rows });
    } catch (err) {
        logger.error('Error obteniendo historial reportes', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;