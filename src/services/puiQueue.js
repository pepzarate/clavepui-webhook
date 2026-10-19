const { Queue, Worker } = require('bullmq');
const axios = require('axios');
const config = require('../config');
const { pool, withHotelContext } = require('../db');
const { logger } = require('../middleware/logger');
const { enmascararCURP } = require('../utils/curp');
const { notificarGerentes } = require('./webPush');

// Configuración de conexión a Redis
const connection = {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
};

// Feature 18 (alertas push) pausada temporalmente — ver CLAUDE.md.
// Reactivar: volver a poner esto en true. El flujo de cumplimiento con la
// PUI (login, notificar-coincidencia, estado_pui = 'enviado') no depende
// de este flag y sigue corriendo igual esté en true o false.
const PUSH_NOTIFICATIONS_ENABLED = false;

// Cola de envíos a la PUI. Sin cola offline de ioredis: si Redis no está
// conectado, add() falla de inmediato en vez de quedarse esperando (y
// mandarse sola minutos después, cuando ya se marcó como pendiente). El
// Worker usa su propia conexión, con la configuración de siempre.
const puiQueue = new Queue('pui-notificaciones', {
    connection: { ...connection, enableOfflineQueue: false },
});

// jobId determinista: si el mismo check-in se encola dos veces (la request y
// el reencolador, o un add que terminó tarde), BullMQ ignora el segundo
// mientras el primero siga en Redis. Sin ":" (BullMQ no lo admite en ids
// propios). Si el job ya se purgó (removeOnComplete), el worker igual
// descarta lo que ya está 'enviado' (ver yaNotificado()).
function jobIdDe(checkInId) {
    return `checkin-${checkInId}`;
}

/**
 * Agrega un check-in a la cola para notificar a la PUI.
 * El worker lo procesa de forma asíncrona con reintentos.
 * Puede tardar o fallar si Redis no responde: desde una request usar
 * intentarEncolar(), que tiene timeout y nunca lanza.
 */
async function encolarNotificacionPUI(checkIn) {
    await puiQueue.add(
        'notificar-coincidencia',
        { checkIn },
        {
            jobId: jobIdDe(checkIn.id),
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

async function marcarEncolado(checkIn) {
    await withHotelContext(checkIn.hotel_id, (client) => client.query(
        `UPDATE check_ins SET encolado_pui = TRUE WHERE id = $1 AND encolado_pui = FALSE`,
        [checkIn.id]
    ));
}

/**
 * Encola el aviso a la PUI sin esperar a Redis más de
 * PUI_ENCOLAR_TIMEOUT_MS. Nunca lanza: la base de datos es la fuente de
 * verdad y el check-in ya está guardado. Si no se pudo, queda con
 * encolado_pui = false y reencolarPendientes() lo reintenta.
 * Devuelve true si quedó en la cola.
 */
async function intentarEncolar(checkIn) {
    const add = encolarNotificacionPUI(checkIn);
    let timer;
    const limite = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), config.pui.encolarTimeoutMs);
    });
    try {
        await Promise.race([add, limite]);
    } catch (err) {
        logger.warn('Aviso a la PUI pendiente de encolar', {
            type: 'cola_pui_pendiente',
            checkinId: checkIn.id,
            hotel_id: checkIn.hotel_id,
            motivo: err.message === 'timeout' ? 'timeout' : 'redis_no_disponible',
        });
        // Si el add todavía termina después del timeout, se marca entonces.
        add.then(() => marcarEncolado(checkIn)).catch(() => {});
        return false;
    } finally {
        clearTimeout(timer);
    }
    try {
        await marcarEncolado(checkIn);
    } catch {
        // Ya está en la cola; si el reencolador lo vuelve a mandar, el jobId lo descarta.
        logger.warn('Aviso a la PUI encolado pero sin marcar en BD', {
            type: 'cola_pui_pendiente',
            checkinId: checkIn.id,
            hotel_id: checkIn.hotel_id,
            motivo: 'db_error',
        });
    }
    return true;
}

/**
 * Reencola los check-ins que quedaron con encolado_pui = false (Redis caído
 * o lento al registrarlos). Recorre hotel por hotel con withHotelContext, así
 * que respeta RLS como el worker. Si Redis sigue sin responder, se detiene
 * en el primer fallo y espera a la siguiente vuelta.
 */
let reencolando = false;

async function reencolarPendientes() {
    if (reencolando) return { pendientes: 0, encolados: 0 };
    reencolando = true;
    let pendientes = 0;
    let encolados = 0;
    try {
        const hoteles = await pool.query(`SELECT id, rfc FROM hoteles`);
        recorrer: for (const hotel of hoteles.rows) {
            const { rows } = await withHotelContext(hotel.id, (client) => client.query(
                `SELECT * FROM check_ins
                 WHERE hotel_id = $1 AND encolado_pui = FALSE
                   AND creado_en < NOW() - make_interval(secs => $2::float / 1000)
                 ORDER BY creado_en
                 LIMIT 100`,
                [hotel.id, config.pui.reencolarGraciaMs]
            ));
            pendientes += rows.length;
            for (const checkIn of rows) {
                const ok = await intentarEncolar({ ...checkIn, rfc_hotel: hotel.rfc, reporte_pui_id: null });
                if (!ok) break recorrer;
                encolados++;
            }
        }
        if (pendientes > 0) {
            logger.info('Reencolado de avisos a la PUI', { type: 'cola_pui_reencolado', pendientes, encolados });
        }
    } catch (err) {
        logger.error('Error reencolando avisos a la PUI', { type: 'cola_pui_reencolado', error: err.message });
    } finally {
        reencolando = false;
    }
    return { pendientes, encolados };
}

function iniciarReencolador() {
    reencolarPendientes();
    const timer = setInterval(reencolarPendientes, config.pui.reencolarIntervaloMs);
    timer.unref();
    return timer;
}

/**
 * ¿Este check-in ya se notificó a la PUI (o ya no existe)? Protege contra
 * avisos duplicados si un job se vuelve a encolar después de que el
 * original se purgó de Redis.
 */
async function yaNotificado(checkIn) {
    const r = await withHotelContext(checkIn.hotel_id, (client) => client.query(
        `SELECT estado_pui FROM check_ins WHERE id = $1`,
        [checkIn.id]
    ));
    return r.rowCount === 0 || r.rows[0].estado_pui === 'enviado';
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

        if (await yaNotificado(checkIn)) {
            logger.info('Check-in ya notificado o inexistente — se omite', {
                type: 'worker_pui',
                checkinId: checkIn.id,
                hotel_id: checkIn.hotel_id,
            });
            return;
        }

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
            if (PUSH_NOTIFICATIONS_ENABLED) {
                notificarGerentes(checkIn.hotel_id, {
                    title: 'Alerta PUI — coincidencia detectada',
                    body: `CURP ${enmascararCURP(checkIn.curp)} coincide con un reporte activo de búsqueda.`,
                }).catch((err) => {
                    logger.error('Error enviando alertas push de coincidencia PUI', {
                        error: err.message,
                        hotel_id: checkIn.hotel_id,
                    });
                });
            }

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

module.exports = {
    puiQueue,
    encolarNotificacionPUI,
    intentarEncolar,
    reencolarPendientes,
    iniciarReencolador,
    jobIdDe,
};