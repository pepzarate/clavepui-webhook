const { Queue, Worker } = require('bullmq');
const axios = require('axios');
const { pool, withHotelContext } = require('../db');
const { logger } = require('../middleware/logger');
const { enmascararCURP } = require('../utils/curp');
const { notificarGerentes } = require('./webPush');

// Configuración de conexión a Redis
const connection = {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
};

// Cola de envíos a la PUI
const puiQueue = new Queue('pui-notificaciones', { connection });

/**
 * Agrega un check-in a la cola para notificar a la PUI.
 * El worker lo procesa de forma asíncrona con reintentos.
 */
async function encolarNotificacionPUI(checkIn) {
    await puiQueue.add(
        'notificar-coincidencia',
        { checkIn },
        {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 5000, // 5s, 25s, 125s
            },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 50 },
        }
    );

    logger.info('Check-in encolado para PUI', {
        type: 'cola_pui',
        checkinId: checkIn.id,
        hotel_id: checkIn.hotel_id,
    });
}

/**
 * Worker que procesa la cola y hace las llamadas reales a la PUI.
 * Se ejecuta en segundo plano mientras el servidor atiende requests.
 */
const puiWorker = new Worker(
    'pui-notificaciones',
    async (job) => {
        const { checkIn } = job.data;

        logger.info('Procesando notificación PUI', {
            type: 'worker_pui',
            checkinId: checkIn.id,
            intento: job.attemptsMade + 1,
        });

        try {
            // Buscar si hay reportes activos que coincidan con esta CURP.
            // Sin filtro de hotel_id en el texto de la query a propósito: la
            // policy de RLS (contexto seteado abajo) es la que garantiza que
            // solo se vean reportes del mismo hotel del check-in.
            const reportes = await withHotelContext(checkIn.hotel_id, (client) => client.query(
                `SELECT id, curp FROM reportes_activos
         WHERE curp = $1 AND activo = TRUE`,
                [checkIn.curp]
            ));

            if (reportes.rowCount === 0) {
                // No hay reporte activo para esta CURP — no notificar
                // Marcar como enviado porque no hay nada que reportar
                await withHotelContext(checkIn.hotel_id, (client) => client.query(
                    `UPDATE check_ins SET estado_pui = 'sin_reporte'
           WHERE id = $1`,
                    [checkIn.id]
                ));

                logger.info('Sin reporte activo para esta CURP — sin acción', {
                    type: 'worker_pui',
                    checkinId: checkIn.id,
                });
                return;
            }

            // Hay reporte activo — notificar coincidencia a la PUI
            for (const reporte of reportes.rows) {
                // 1. Obtener token de la PUI
                const hotelResult = await pool.query(
                    `SELECT gov_pui_clave FROM hoteles WHERE id = $1`,
                    [checkIn.hotel_id]
                );

                if (hotelResult.rowCount === 0 || !hotelResult.rows[0].gov_pui_clave) {
                    throw new Error(`Hotel ${checkIn.hotel_id} no tiene gov_pui_clave configurada`);
                }

                const govClave = hotelResult.rows[0].gov_pui_clave;

                const loginRes = await axios.post(
                    'https://www.api.plataformadebusqueda.gob.mx/api/2_3_0/login',
                    {
                        institucion_id: checkIn.rfc_hotel,
                        clave: govClave,
                    },
                    { timeout: 10000 }
                );

                const token = loginRes.data.token;

                // 2. Notificar coincidencia
                await axios.post(
                    'https://www.api.plataformadebusqueda.gob.mx/api/2_3_0/notificar-coincidencia',
                    {
                        id: reporte.id,
                        curp: checkIn.curp,
                        nombre: checkIn.nombre,
                        primer_apellido: checkIn.primer_apellido,
                        segundo_apellido: checkIn.segundo_apellido,
                        fecha_nacimiento: checkIn.fecha_nacimiento,
                        lugar_nacimiento: checkIn.lugar_nacimiento,
                        sexo_asignado: checkIn.sexo_asignado,
                        institucion_id: checkIn.rfc_hotel,
                        fase_busqueda: '3',
                        tipo_evento: 'Check-in hotelero',
                        fecha_evento: new Date().toISOString().split('T')[0],
                    },
                    {
                        headers: { Authorization: `Bearer ${token}` },
                        timeout: 10000,
                    }
                );

                logger.info('Coincidencia notificada a PUI', {
                    type: 'pui_coincidencia',
                    checkinId: checkIn.id,
                    reporteId: reporte.id,
                });
            }

            // 3. Actualizar estado
            await withHotelContext(checkIn.hotel_id, (client) => client.query(
                `UPDATE check_ins
         SET estado_pui   = 'enviado',
             intentos_pui = intentos_pui + 1
         WHERE id = $1`,
                [checkIn.id]
            ));

            // 4. Alertar a los gerentes del hotel — coincidencia con persona buscada
            notificarGerentes(checkIn.hotel_id, {
                title: 'Alerta PUI — coincidencia detectada',
                body: `CURP ${enmascararCURP(checkIn.curp)} coincide con un reporte activo de búsqueda.`,
            }).catch((err) => {
                logger.error('Error enviando alertas push de coincidencia PUI', {
                    error: err.message,
                    hotel_id: checkIn.hotel_id,
                });
            });

        } catch (err) {
            await withHotelContext(checkIn.hotel_id, (client) => client.query(
                `UPDATE check_ins
         SET estado_pui   = 'error',
             intentos_pui = intentos_pui + 1,
             ultimo_error = $2
         WHERE id = $1`,
                [checkIn.id, err.message]
            ));

            logger.error('Error notificando a PUI', {
                type: 'pui_error',
                checkinId: checkIn.id,
                error: err.message,
            });

            throw err;
        }
    },
    { connection, concurrency: 5 }
);

puiWorker.on('completed', (job) => {
    logger.info('Job completado', { jobId: job.id });
});

puiWorker.on('failed', (job, err) => {
    logger.error('Job fallido definitivamente', {
        jobId: job.id,
        error: err.message,
    });
});

module.exports = { puiQueue, encolarNotificacionPUI };