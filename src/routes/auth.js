const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { pool } = require('../db');
const { logger } = require('../middleware/logger');

const router = express.Router();

// Aplicado directamente sobre la ruta (no vía app.use('/', loginLimiter,
// authRoutes) en app.js) — ese montaje corría el limitador para CUALQUIER
// request, no solo POST /login, porque express aplica el middleware al
// path prefix '/' antes de que el router decida si le pertenece la ruta.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    handler: (req, res) => {
        logger.warn('Rate limit login excedido', { ip: req.ip });
        res.status(429).json({ error: 'Demasiados intentos de autenticación' });
    },
});

/**
 * POST /login
 *
 * La PUI llama aquí para obtener el Bearer token.
 * Cada hotel tiene su propia PUI_CLAVE — con ella identificamos
 * a qué tenant pertenece la solicitud.
 */
router.post('/login', loginLimiter, async (req, res) => {
    const { usuario, clave } = req.body;

    if (!usuario || !clave) {
        return res.status(400).json({
            error: 'Los campos usuario y clave son obligatorios'
        });
    }

    // El manual especifica usuario fijo "PUI" — cualquier otro valor es 401
    if (usuario !== config.pui.usuario) {
        logger.warn('Login con usuario incorrecto', {
            type: 'auth_failure',
            ip: req.ip,
        });
        return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    try {
        // Buscar el hotel por su clave única
        const result = await pool.query(
            `SELECT id, nombre, rfc
       FROM hoteles
       WHERE pui_clave = $1 AND activo = TRUE`,
            [clave]
        );

        if (result.rowCount === 0) {
            logger.warn('Login con clave no registrada', {
                type: 'auth_failure',
                ip: req.ip,
            });
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }

        const hotel = result.rows[0];

        // El JWT incluye el hotel_id para identificar el tenant
        const token = jwt.sign(
            {
                sub: 'pui-gobierno',
                iss: 'clavepui',
                hotel_id: hotel.id,
                rfc: hotel.rfc,
            },
            config.jwt.secret,
            { expiresIn: config.jwt.expirySeconds }
        );

        logger.info('Token emitido', {
            type: 'auth_success',
            hotel_id: hotel.id,
            nombre: hotel.nombre,
            ip: req.ip,
        });

        return res.status(200).json({ token });

    } catch (err) {
        logger.error('Error en login', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;