const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logger } = require('../middleware/logger');

const router = express.Router();

/**
 * Valida los campos obligatorios según el Manual PUI sección 8.2
 */
function validatePayload(body) {
    const errors = [];

    if (!body.id) {
        errors.push("'id' es obligatorio");
    } else if (body.id.length < 36 || body.id.length > 75) {
        errors.push("'id' debe tener entre 36 y 75 caracteres");
    }

    if (!body.curp) {
        errors.push("'curp' es obligatorio");
    } else if (!/^[A-Z0-9]{18}$/.test(body.curp)) {
        errors.push("'curp' debe tener 18 caracteres en mayúsculas y números");
    }

    if (body.nombre && body.nombre.length > 50) {
        errors.push("'nombre' debe tener máximo 50 caracteres");
    }

    if (body.fecha_nacimiento &&
        !/^\d{4}-\d{2}-\d{2}$/.test(body.fecha_nacimiento)) {
        errors.push("'fecha_nacimiento' debe estar en formato YYYY-MM-DD");
    }

    if (body.sexo_asignado && !/^[MHX]$/.test(body.sexo_asignado)) {
        errors.push("'sexo_asignado' debe ser M, H o X");
    }

    return errors;
}

/**
 * POST /activar-reporte
 *
 * La PUI envía aquí los datos de una persona desaparecida.
 * Debemos guardar el reporte e iniciar la búsqueda.
 */
router.post('/activar-reporte', requireAuth, async (req, res) => {
    const errors = validatePayload(req.body);
    if (errors.length > 0) {
        return res.status(400).json({ errores: errors });
    }

    const {
        id, curp, nombre, primer_apellido, segundo_apellido,
        fecha_nacimiento, fecha_desaparicion, lugar_nacimiento,
        sexo_asignado, telefono, correo,
    } = req.body;

    try {
        await pool.query(
            `INSERT INTO reportes_activos
        (id, curp, nombre, primer_apellido, segundo_apellido,
         fecha_nacimiento, fecha_desaparicion, lugar_nacimiento,
         sexo_asignado, telefono, correo, raw_payload, activo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE)
       ON CONFLICT (id) DO UPDATE SET
         activo = TRUE,
         raw_payload = $12`,
            [
                id, curp, nombre, primer_apellido, segundo_apellido,
                fecha_nacimiento, fecha_desaparicion, lugar_nacimiento,
                sexo_asignado, telefono, correo,
                JSON.stringify(req.body),
            ]
        );

        logger.info('Reporte activado', {
            type: 'activar_reporte',
            id,
            curp: curp.substring(0, 4) + '***',
            ip: req.ip,
        });

        return res.status(200).json({
            message: 'La solicitud de activación del reporte de búsqueda se recibió correctamente.'
        });

    } catch (err) {
        logger.error('Error guardando reporte', { error: err.message, id });
        return res.status(500).json({ error: 'Error interno al procesar la solicitud' });
    }
});

/**
 * POST /activar-reporte-prueba
 *
 * El portal del gobierno llama aquí durante la inscripción
 * para verificar que el webhook responde correctamente.
 * No guarda nada en BD — solo responde 200.
 */
router.post('/activar-reporte-prueba', requireAuth, (req, res) => {
    const errors = validatePayload(req.body);
    if (errors.length > 0) {
        return res.status(400).json({ errores: errors });
    }

    logger.info('Prueba de webhook exitosa', {
        type: 'prueba_webhook',
        id: req.body.id,
        ip: req.ip,
    });

    return res.status(200).json({
        message: 'La solicitud de activación del reporte de búsqueda se recibió correctamente.'
    });
});

module.exports = router;