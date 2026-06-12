const express = require('express');
const { pool } = require('../db');
const { logger } = require('../middleware/logger');

const router = express.Router();

/**
 * POST /admin/hoteles
 * Endpoint temporal para registrar hoteles en producción.
 * Protegido con un token de admin definido en .env
 */
router.post('/admin/hoteles', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];

    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'No autorizado' });
    }

    const { nombre, rfc, pui_clave } = req.body;

    if (!nombre || !rfc || !pui_clave) {
        return res.status(400).json({
            error: 'nombre, rfc y pui_clave son obligatorios'
        });
    }

    try {
        const result = await pool.query(
            `INSERT INTO hoteles (nombre, rfc, pui_clave)
       VALUES ($1, $2, $3)
       ON CONFLICT (rfc) DO UPDATE SET
         nombre    = $1,
         pui_clave = $3,
         activo    = TRUE
       RETURNING id, nombre, rfc`,
            [nombre, rfc, pui_clave]
        );

        const hotel = result.rows[0];
        logger.info('Hotel registrado via admin', { hotel_id: hotel.id, nombre: hotel.nombre });

        return res.status(200).json({
            message: 'Hotel registrado correctamente',
            hotel
        });

    } catch (err) {
        logger.error('Error registrando hotel', { error: err.message });
        return res.status(500).json({ error: 'Error interno' });
    }
});

module.exports = router;