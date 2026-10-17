const express = require('express');
const { pool } = require('../db');
const { logger } = require('../middleware/logger');
const { requireGerente, requireUsuarioStaff } = require('../middleware/auth');
const { requireHotel } = require('./checkIns');

const router = express.Router();

/**
 * GET /hoteles/config
 * Datos del hotel del gerente autenticado, solo lectura.
 * hoteles no tiene RLS (define a los tenants), pero el acceso igual se
 * restringe por hotel_id vía el JWT — un gerente nunca ve otro hotel.
 */
router.get('/hoteles/config', requireGerente, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT nombre, rfc, pui_clave, gov_pui_clave
       FROM hoteles
       WHERE id = $1`,
            [req.usuario.hotel_id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Hotel no encontrado' });
        }

        const hotel = result.rows[0];

        return res.status(200).json({
            nombre: hotel.nombre,
            rfc: hotel.rfc,
            pui_clave: hotel.pui_clave,
            gov_pui_clave_configurada: Boolean(hotel.gov_pui_clave),
        });
    } catch (err) {
        logger.error('Error obteniendo configuración del hotel', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * GET /hoteles/funciones
 * Feature flags del hotel, para cualquier usuario de staff (recepción o
 * gerente). Se consulta al cargar la página en vez de guardarse en la
 * sesión del login, para que activar/desactivar un flag aplique sin
 * volver a iniciar sesión. Misma auth que POST /ocr/ine: x-hotel-key +
 * JWT de staff del mismo hotel.
 */
router.get('/hoteles/funciones', requireHotel, requireUsuarioStaff, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT checkin_v2 FROM hoteles WHERE id = $1`,
            [req.hotel.id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Hotel no encontrado' });
        }

        return res.status(200).json({ checkin_v2: result.rows[0].checkin_v2 });
    } catch (err) {
        logger.error('Error obteniendo funciones del hotel', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
