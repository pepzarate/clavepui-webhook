const webpush = require('web-push');
const config = require('../config');
const { withHotelContext } = require('../db');
const { logger } = require('../middleware/logger');

const configurado = Boolean(config.webPush.publicKey && config.webPush.privateKey);

if (configurado) {
    webpush.setVapidDetails(
        config.webPush.subject,
        config.webPush.publicKey,
        config.webPush.privateKey
    );
} else {
    logger.warn('VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY no configuradas — notificaciones push deshabilitadas');
}

/**
 * Envía una notificación push a todos los gerentes suscritos de un hotel.
 * Suscripciones vencidas (404/410 del navegador) se borran automáticamente.
 */
async function notificarGerentes(hotelId, payload) {
    if (!configurado) return;

    const subs = await withHotelContext(hotelId, (client) => client.query(
        `SELECT id, endpoint, keys_p256dh, keys_auth FROM push_subscriptions WHERE hotel_id = $1`,
        [hotelId]
    ));

    for (const sub of subs.rows) {
        try {
            await webpush.sendNotification(
                {
                    endpoint: sub.endpoint,
                    keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
                },
                JSON.stringify(payload)
            );
        } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) {
                await withHotelContext(hotelId, (client) => client.query(
                    `DELETE FROM push_subscriptions WHERE id = $1`,
                    [sub.id]
                ));
                logger.info('Suscripción push vencida eliminada', { hotel_id: hotelId, subscriptionId: sub.id });
            } else {
                logger.error('Error enviando notificación push', { error: err.message, hotel_id: hotelId });
            }
        }
    }
}

module.exports = { notificarGerentes, configurado };
