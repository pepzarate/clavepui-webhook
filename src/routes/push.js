const express = require('express');
const { withHotelContext } = require('../db');
const { logger } = require('../middleware/logger');
const { requireGerente } = require('../middleware/auth');
const config = require('../config');

const router = express.Router();

/**
 * GET /push/vapid-public-key
 * Clave pública VAPID que el frontend necesita para PushManager.subscribe().
 */
router.get('/push/vapid-public-key', (req, res) => {
    if (!config.webPush.publicKey) {
        return res.status(503).json({ error: 'Notificaciones push no configuradas en el servidor' });
    }
    return res.status(200).json({ publicKey: config.webPush.publicKey });
});

/**
 * POST /push/suscribir
 * Registra la suscripción push del navegador del gerente autenticado.
 */
router.post('/push/suscribir', requireGerente, async (req, res) => {
    const { endpoint, keys } = req.body;

    if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return res.status(400).json({ error: 'endpoint y keys (p256dh, auth) son obligatorios' });
    }

    try {
        await withHotelContext(req.usuario.hotel_id, (client) => client.query(
            `INSERT INTO push_subscriptions (hotel_id, usuario_id, endpoint, keys_p256dh, keys_auth)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET
         hotel_id    = $1,
         usuario_id  = $2,
         keys_p256dh = $4,
         keys_auth   = $5`,
            [req.usuario.hotel_id, req.usuario.sub, endpoint, keys.p256dh, keys.auth]
        ));

        logger.info('Suscripción push registrada', {
            type: 'push_suscripcion',
            hotel_id: req.usuario.hotel_id,
            usuario_id: req.usuario.sub,
        });

        return res.status(201).json({ message: 'Suscripción registrada correctamente' });
    } catch (err) {
        logger.error('Error registrando suscripción push', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * POST /push/desuscribir
 * Elimina la suscripción push del gerente autenticado.
 */
router.post('/push/desuscribir', requireGerente, async (req, res) => {
    const { endpoint } = req.body;

    if (!endpoint) {
        return res.status(400).json({ error: 'endpoint es obligatorio' });
    }

    try {
        await withHotelContext(req.usuario.hotel_id, (client) => client.query(
            `DELETE FROM push_subscriptions WHERE hotel_id = $1 AND endpoint = $2`,
            [req.usuario.hotel_id, endpoint]
        ));

        return res.status(200).json({ message: 'Suscripción eliminada' });
    } catch (err) {
        logger.error('Error eliminando suscripción push', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
