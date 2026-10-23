const { Queue, Worker, UnrecoverableError } = require('bullmq');
const config = require('../config');
const { pool, withHotelContext } = require('../db');
const { logger } = require('../middleware/logger');
const { enmascararCURP } = require('../utils/curp');
const { notificarGerentes } = require('./webPush');
const { ErrorPuiPermanente } = require('./puiApi');
const {
    notificarFase3, hotelParaPui, marcarCheckInEnviado, reencolarBusquedas, barridoFase3,
} = require('./puiBusqueda');

// Configuración de conexión a Redis
const connection = {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
};
// Prefijo de las llaves de BullMQ. Solo las pruebas lo cambian
// (PUI_COLA_PREFIJO) para no mezclar sus jobs con los de un backend corriendo.
const prefix = process.env.PUI_COLA_PREFIJO || 'bull';

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
    prefix,
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
        // Los hoteles de prueba nunca se encolan (POST /check-ins ya los marca)
        const hoteles = await pool.query(`SELECT id, rfc FROM hoteles WHERE NOT es_prueba`);
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
    const vuelta = async () => {
        await reencolarPendientes();
        await reencolarBusquedas(); // fases 1 y 2 que no se encolaron o quedaron en error
    };
    vuelta();
    const timer = setInterval(vuelta, config.pui.reencolarIntervaloMs);
    timer.unref();
    // Fase 3 periódica (resincronización): el manual sugiere cada hora,
    // cada 4 horas o una vez al día; aquí cada config.pui.barridoMs (1 h)
    const barrido = setInterval(barridoFase3, config.pui.barridoMs);
    barrido.unref();
    return timer;
}

/**
 * Tras editar un check-in (habitación/folio): revisar de nuevo la fase 3,
 * porque es un registro modificado. jobId único por edición; si Redis no
 * responde, el barrido periódico lo recoge. Nunca lanza.
 */
async function encolarEdicion(checkIn) {
    const add = puiQueue.add(
        'notificar-coincidencia',
        { checkIn: { id: checkIn.id, hotel_id: checkIn.hotel_id }, motivo: 'edicion' },
        {
            jobId: `${jobIdDe(checkIn.id)}-edicion-${Date.now()}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 50 },
        }
    );
    let timer;
    try {
        await Promise.race([add, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), config.pui.encolarTimeoutMs); })]);
        return true;
    } catch (err) {
        add.catch(() => {});
        logger.warn('Revisión de edición pendiente (la toma el barrido)', {
            type: 'cola_pui_pendiente', checkinId: checkIn.id, hotel_id: checkIn.hotel_id,
            motivo: err.message === 'timeout' ? 'timeout' : 'redis_no_disponible',
        });
        return false;
    } finally {
        clearTimeout(timer);
    }
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

/** Defensa extra: un hotel de prueba nunca llega a la PUI aunque algo lo encole. */
async function esHotelDePrueba(hotelId) {
    const r = await pool.query(`SELECT es_prueba FROM hoteles WHERE id = $1`, [hotelId]);
    return r.rows[0]?.es_prueba === true;
}

/**
 * Worker que procesa la cola y hace las llamadas reales a la PUI.
 * Se ejecuta en segundo plano mientras el servidor atiende requests.
 */
const puiWorker = new Worker(
    'pui-notificaciones',
    async (job) => {
        const { checkIn: datosJob, motivo } = job.data;
        const edicion = motivo === 'edicion';

        logger.info('Procesando notificación PUI', {
            type: 'worker_pui',
            checkinId: datosJob.id,
            intento: job.attemptsMade + 1,
            ...(edicion ? { motivo } : {}),
        });

        if (await esHotelDePrueba(datosJob.hotel_id)) {
            logger.info('Hotel de prueba — no se notifica a la PUI', {
                type: 'worker_pui',
                checkinId: datosJob.id,
                hotel_id: datosJob.hotel_id,
            });
            return;
        }

        // Una edición se revisa aunque el check-in ya esté 'enviado': es un
        // registro modificado (manual 6.4.c). La huella evita repetir avisos.
        if (!edicion && (await yaNotificado(datosJob))) {
            logger.info('Check-in ya notificado o inexistente — se omite', {
                type: 'worker_pui',
                checkinId: datosJob.id,
                hotel_id: datosJob.hotel_id,
            });
            return;
        }

        // Siempre la fila actual (el job puede traer datos de antes de una edición)
        const fila = await withHotelContext(datosJob.hotel_id, (client) => client.query(
            `SELECT * FROM check_ins WHERE id = $1 AND hotel_id = $2`,
            [datosJob.id, datosJob.hotel_id]
        ));
        const checkIn = fila.rows[0];
        if (!checkIn) return;

        try {
            const { hotel, motivo: sinPui } = await hotelParaPui(checkIn.hotel_id);
            const reportes = await withHotelContext(checkIn.hotel_id, (client) => client.query(
                `SELECT COUNT(*)::int AS n FROM reportes_activos
                 WHERE hotel_id = $1 AND curp = $2 AND activo = TRUE`,
                [checkIn.hotel_id, checkIn.curp]
            ));

            if (reportes.rows[0].n === 0) {
                // Sin reporte activo para esta CURP: nada que notificar
                if (!edicion) {
                    await withHotelContext(checkIn.hotel_id, (client) => client.query(
                        `UPDATE check_ins SET estado_pui = 'sin_reporte' WHERE id = $1`,
                        [checkIn.id]
                    ));
                }
                logger.info('Sin reporte activo para esta CURP — sin acción', {
                    type: 'worker_pui',
                    checkinId: checkIn.id,
                });
                return;
            }

            if (!hotel) {
                // Hay reporte pero el hotel no tiene enlace con la PUI: no se
                // notifica ni se reintenta (no se arregla solo)
                await withHotelContext(checkIn.hotel_id, (client) => client.query(
                    `UPDATE check_ins SET estado_pui = 'error', ultimo_error = $2 WHERE id = $1`,
                    [checkIn.id, `No se notificó: ${sinPui}`]
                ));
                logger.warn('Coincidencia sin enlace con la PUI', { type: 'worker_pui', checkinId: checkIn.id, motivo: sinPui });
                return;
            }

            // Fase 3: un aviso por reporte activo (idempotente, ver puiNotificaciones.js)
            const r = await notificarFase3(hotel, checkIn);

            if (r.coincidencias > 0) {
                await marcarCheckInEnviado(checkIn.hotel_id, checkIn.id);
                logger.info('Coincidencia notificada a PUI', {
                    type: 'pui_coincidencia',
                    checkinId: checkIn.id,
                    reportes: r.coincidencias,
                });
            } else if (r.rechazos.length > 0) {
                await withHotelContext(checkIn.hotel_id, (client) => client.query(
                    `UPDATE check_ins SET estado_pui = 'error', intentos_pui = intentos_pui + 1,
                            ultimo_error = 'La PUI rechazó el aviso (400): revisar pui_notificaciones'
                     WHERE id = $1`,
                    [checkIn.id]
                ));
                return;
            }

            // Alertar a los gerentes del hotel — coincidencia con persona buscada
            if (PUSH_NOTIFICATIONS_ENABLED && r.coincidencias > 0) {
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

            // Credenciales rechazadas o error de configuración: reintentar no sirve
            if (err instanceof ErrorPuiPermanente) throw new UnrecoverableError(err.message);
            throw err;
        }
    },
    { connection, concurrency: 5, prefix }
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
    encolarEdicion,
    jobIdDe,
    puiWorker,
};