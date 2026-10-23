/**
 * Búsqueda de la PUI en los datos del hotel (Manual Técnico, sección 6,
 * paso 4; definiciones 5.5–5.7).
 *
 * Al recibir un reporte (/activar-reporte) se encola un job en
 * 'pui-busquedas' (sin retrasar la respuesta al gobierno) que hace:
 *   Fase 1 — completar datos básicos: el registro MÁS RECIENTE de esa CURP en
 *            el hotel (último check-in; nombres faltantes de
 *            huespedes_frecuentes). Un único aviso, fase "1", SIN campos de
 *            evento. Si no hay registro o ningún dato, no se notifica.
 *   Fase 2 — histórica: check-ins de esa CURP desde fecha_desaparicion hasta
 *            la recepción del reporte, acotado a los últimos 12 años
 *            (contados desde la recepción). Sin fecha de desaparición, la
 *            fase se omite. Un aviso por check-in, fase "2", con evento.
 *   Al terminar las dos: /busqueda-finalizada, haya o no coincidencias (y
 *   también si la fase 2 se omitió: "una vez concluidos estos dos primeros
 *   pasos").
 *   Fase 3 — continua: cada check-in nuevo (worker de puiQueue.js), cada
 *            edición, y un barrido periódico (resincronización) revisan los
 *            reportes activos. Fase "3", con evento.
 *
 * Criterio de coincidencia, igual en las tres fases: CURP exacta (mismo
 * hotel). El nombre no se usa para decidir.
 *
 * Nunca notifica: hoteles con es_prueba, hoteles sin enlace con la PUI
 * (gov_pui_clave vacía) ni reportes desactivados. RLS: todo con
 * withHotelContext del hotel del reporte. Logs sin datos personales.
 */
const { Queue, Worker, UnrecoverableError } = require('bullmq');
const config = require('../config');
const { pool, withHotelContext } = require('../db');
const { logger } = require('../middleware/logger');
const { construirPayload, tieneDatosParaCompletar } = require('./puiPayload');
const { notificarUnaVez } = require('./puiNotificaciones');
const puiApi = require('./puiApi');
const { ZONA_HORARIA_DEFAULT } = require('../utils/zonaHoraria');

const connection = { url: process.env.REDIS_URL || 'redis://localhost:6379' };
const prefix = process.env.PUI_COLA_PREFIJO || 'bull'; // ver puiQueue.js

const busquedasQueue = new Queue('pui-busquedas', {
    connection: { ...connection, enableOfflineQueue: false },
    prefix,
});

const OPCIONES_JOB = {
    attempts: 6,
    // 30 s, 1 min, 2 min, 4 min, 8 min (las pruebas lo acortan)
    backoff: { type: 'exponential', delay: Number.parseInt(process.env.PUI_BUSQUEDA_BACKOFF_MS) || 30000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
};

// Sin ":" (BullMQ no lo admite en ids propios)
const jobIdBusqueda = (hotelId, reporteId) => `busqueda-${hotelId}-${reporteId}`;

/** Datos del hotel para la PUI, o el motivo por el que no se notifica. */
async function hotelParaPui(hotelId) {
    const r = await pool.query(
        `SELECT id, nombre, rfc, gov_pui_clave, es_prueba, activo FROM hoteles WHERE id = $1`,
        [hotelId]
    );
    const hotel = r.rows[0];
    if (!hotel) return { motivo: 'hotel_inexistente' };
    if (hotel.es_prueba) return { motivo: 'hotel_prueba' };
    if (!hotel.gov_pui_clave) return { motivo: 'sin_enlace_pui' };
    return { hotel };
}

const coincidio = (estado) => ['enviada', 'multiple', 'ya_enviada', 'ya_multiple'].includes(estado);

async function marcarCheckInEnviado(hotelId, checkInId) {
    await withHotelContext(hotelId, (c) => c.query(
        `UPDATE check_ins SET estado_pui = 'enviado', intentos_pui = intentos_pui + 1, ultimo_error = NULL
         WHERE id = $1 AND hotel_id = $2`,
        [checkInId, hotelId]
    ));
}

async function reporteActivo(hotelId, reporteId) {
    const r = await withHotelContext(hotelId, (c) => c.query(
        `SELECT activo FROM reportes_activos WHERE hotel_id = $1 AND id = $2`, [hotelId, reporteId]
    ));
    return r.rows[0]?.activo === true;
}

/** Fases 1 y 2 + /busqueda-finalizada de un reporte. Idempotente. */
async function procesarReporte(hotelId, reporteId) {
    const { hotel, motivo } = await hotelParaPui(hotelId);
    if (!hotel) {
        logger.info('Búsqueda de reporte omitida', { type: 'pui_busqueda', hotel_id: hotelId, reporteId, motivo });
        return { omitido: motivo };
    }
    const zona = ZONA_HORARIA_DEFAULT;
    const reporte = (await withHotelContext(hotelId, (c) => c.query(
        `SELECT id, curp, activo, busqueda_estado, recibido_en,
                CASE WHEN fecha_desaparicion ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN fecha_desaparicion END AS fecha_desaparicion,
                ((recibido_en AT TIME ZONE $3)::date - interval '12 years')::date AS limite_12_anios
         FROM reportes_activos WHERE hotel_id = $1 AND id = $2`,
        [hotelId, reporteId, zona]
    ))).rows[0];
    if (!reporte || !reporte.activo) return { omitido: 'reporte_inactivo' };
    if (reporte.busqueda_estado === 'finalizada') return { omitido: 'ya_finalizada' };

    await withHotelContext(hotelId, (c) => c.query(
        `UPDATE reportes_activos SET busqueda_intentada_en = NOW() WHERE hotel_id = $1 AND id = $2`,
        [hotelId, reporteId]
    ));
    const resumen = { fase1: 'sin_datos', fase2: 0, fase2_omitida: !reporte.fecha_desaparicion };

    // ── Fase 1: el registro más reciente de esa CURP ──
    const persona = (await withHotelContext(hotelId, (c) => c.query(
        `SELECT c.curp,
                COALESCE(NULLIF(c.nombre, ''), f.nombre)                     AS nombre,
                COALESCE(NULLIF(c.primer_apellido, ''), f.primer_apellido)   AS primer_apellido,
                COALESCE(NULLIF(c.segundo_apellido, ''), f.segundo_apellido) AS segundo_apellido,
                c.telefono, c.correo
         FROM check_ins c
         LEFT JOIN huespedes_frecuentes f ON f.hotel_id = c.hotel_id AND f.curp = c.curp
         WHERE c.hotel_id = $1 AND c.curp = $2
         ORDER BY c.fecha_checkin DESC
         LIMIT 1`,
        [hotelId, reporte.curp]
    ))).rows[0];
    if (persona) {
        const payload = construirPayload({ fase: 1, reporteId, hotel, persona });
        if (tieneDatosParaCompletar(payload)) {
            resumen.fase1 = await notificarUnaVez({ hotel, reporteId, fase: 1, payload });
        }
    }

    // ── Fase 2: histórica, desde la desaparición (máx. 12 años) ──
    if (reporte.fecha_desaparicion) {
        const { rows } = await withHotelContext(hotelId, (c) => c.query(
            `SELECT * FROM check_ins
             WHERE hotel_id = $1 AND curp = $2
               AND DATE(fecha_checkin AT TIME ZONE $3) >= GREATEST($4::date, $5::date)
               AND fecha_checkin <= $6
             ORDER BY fecha_checkin`,
            [hotelId, reporte.curp, zona, reporte.fecha_desaparicion, reporte.limite_12_anios, reporte.recibido_en]
        ));
        for (const checkIn of rows) {
            if (!(await reporteActivo(hotelId, reporteId))) return { ...resumen, omitido: 'desactivado_en_proceso' };
            const payload = construirPayload({ fase: 2, reporteId, hotel, persona: checkIn, evento: checkIn });
            const estado = await notificarUnaVez({ hotel, reporteId, fase: 2, checkInId: checkIn.id, payload });
            if (coincidio(estado)) {
                resumen.fase2++;
                if (estado === 'enviada' || estado === 'multiple') await marcarCheckInEnviado(hotelId, checkIn.id);
            }
        }
    }

    // ── Fin de la búsqueda histórica (siempre, haya o no coincidencias) ──
    if (!(await reporteActivo(hotelId, reporteId))) return { ...resumen, omitido: 'desactivado_en_proceso' };
    await puiApi.busquedaFinalizada(hotel, reporteId);
    await withHotelContext(hotelId, (c) => c.query(
        `UPDATE reportes_activos SET busqueda_estado = 'finalizada', busqueda_finalizada_en = NOW()
         WHERE hotel_id = $1 AND id = $2`,
        [hotelId, reporteId]
    ));
    logger.info('Búsqueda histórica finalizada', { type: 'pui_busqueda', hotel_id: hotelId, reporteId, ...resumen });
    return resumen;
}

/**
 * Fase 3 de un check-in contra los reportes activos de su CURP. La usan el
 * worker de check-ins (puiQueue.js), las ediciones y el barrido. Devuelve
 * cuántos reportes coincidieron (0 = sin reporte activo).
 */
async function notificarFase3(hotel, checkIn) {
    const reportes = (await withHotelContext(hotel.id, (c) => c.query(
        `SELECT id FROM reportes_activos WHERE hotel_id = $1 AND curp = $2 AND activo = TRUE`,
        [hotel.id, checkIn.curp]
    ))).rows;
    let coincidencias = 0;
    const rechazos = [];
    for (const reporte of reportes) {
        const payload = construirPayload({ fase: 3, reporteId: reporte.id, hotel, persona: checkIn, evento: checkIn });
        const estado = await notificarUnaVez({ hotel, reporteId: reporte.id, fase: 3, checkInId: checkIn.id, payload });
        if (coincidio(estado)) coincidencias++;
        if (estado === 'rechazada') rechazos.push(reporte.id);
    }
    return { reportes: reportes.length, coincidencias, rechazos };
}

/**
 * Barrido de la fase 3 (resincronización, manual 6.4.c y "Requisitos del API
 * institucional"): para cada reporte activo, los check-ins de su CURP
 * posteriores a su recepción o editados después. Lo ya notificado con el
 * mismo contenido se salta (huella); lo modificado se vuelve a notificar.
 */
let barriendo = false;
async function barridoFase3() {
    if (barriendo) return { revisados: 0 };
    barriendo = true;
    let revisados = 0;
    try {
        const hoteles = await pool.query(
            `SELECT id FROM hoteles WHERE NOT es_prueba AND activo AND gov_pui_clave IS NOT NULL`
        );
        for (const { id } of hoteles.rows) {
            const { hotel } = await hotelParaPui(id);
            if (!hotel) continue;
            const { rows } = await withHotelContext(id, (c) => c.query(
                `SELECT DISTINCT c.*
                 FROM reportes_activos r
                 JOIN check_ins c ON c.hotel_id = r.hotel_id AND c.curp = r.curp
                 WHERE r.hotel_id = $1 AND r.activo
                   AND (c.fecha_checkin > r.recibido_en
                        OR EXISTS (SELECT 1 FROM check_ins_ediciones e
                                   WHERE e.check_in_id = c.id AND e.editado_en > r.recibido_en))`,
                [id]
            ));
            for (const checkIn of rows) {
                revisados++;
                const r = await notificarFase3(hotel, checkIn);
                if (r.coincidencias > 0) await marcarCheckInEnviado(id, checkIn.id);
            }
        }
    } catch (err) {
        logger.error('Error en el barrido de la fase 3', { type: 'pui_barrido', error: err.message });
    } finally {
        barriendo = false;
    }
    return { revisados };
}

/** Encola la búsqueda de un reporte sin esperar a Redis más de lo configurado. Nunca lanza. */
async function intentarEncolarBusqueda(hotelId, reporteId) {
    const add = busquedasQueue.add('fases-1-2', { hotelId, reporteId }, { jobId: jobIdBusqueda(hotelId, reporteId), ...OPCIONES_JOB });
    let timer;
    try {
        await Promise.race([add, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), config.pui.encolarTimeoutMs); })]);
        return true;
    } catch (err) {
        add.catch(() => {});
        logger.warn('Búsqueda de reporte pendiente de encolar', {
            type: 'pui_busqueda_pendiente', hotel_id: hotelId, reporteId,
            motivo: err.message === 'timeout' ? 'timeout' : 'redis_no_disponible',
        });
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/** Reencola búsquedas pendientes o en error (Redis caído, reintentos agotados). */
async function reencolarBusquedas() {
    let encoladas = 0;
    try {
        const hoteles = await pool.query(
            `SELECT id FROM hoteles WHERE NOT es_prueba AND activo AND gov_pui_clave IS NOT NULL`
        );
        for (const { id } of hoteles.rows) {
            const { rows } = await withHotelContext(id, (c) => c.query(
                `SELECT id FROM reportes_activos
                 WHERE hotel_id = $1 AND activo AND busqueda_estado IN ('pendiente', 'error')
                   AND recibido_en < NOW() - make_interval(secs => $2::float / 1000)
                   AND (busqueda_intentada_en IS NULL
                        OR busqueda_intentada_en < NOW() - make_interval(secs => $3::float / 1000))
                 LIMIT 50`,
                [id, config.pui.reencolarGraciaMs, config.pui.busquedaReintentoMs]
            ));
            for (const r of rows) {
                if (!(await intentarEncolarBusqueda(id, r.id))) return encoladas;
                encoladas++;
            }
        }
    } catch (err) {
        logger.error('Error reencolando búsquedas de reportes', { type: 'pui_busqueda', error: err.message });
    }
    return encoladas;
}

const busquedasWorker = new Worker(
    'pui-busquedas',
    async (job) => {
        const { hotelId, reporteId } = job.data;
        try {
            return await procesarReporte(hotelId, reporteId);
        } catch (err) {
            if (err instanceof puiApi.ErrorPuiPermanente) throw new UnrecoverableError(err.message);
            throw err;
        }
    },
    { connection, concurrency: 2, prefix }
);

busquedasWorker.on('failed', async (job, err) => {
    if (!job) return;
    const agotado = err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    logger.error('Búsqueda de reporte falló', {
        type: 'pui_busqueda', hotel_id: job.data.hotelId, reporteId: job.data.reporteId,
        intento: job.attemptsMade, definitivo: agotado, error: err.message,
    });
    if (agotado) {
        await withHotelContext(job.data.hotelId, (c) => c.query(
            `UPDATE reportes_activos SET busqueda_estado = 'error' WHERE hotel_id = $1 AND id = $2 AND busqueda_estado <> 'finalizada'`,
            [job.data.hotelId, job.data.reporteId]
        )).catch(() => {});
    }
});

module.exports = {
    busquedasQueue,
    busquedasWorker,
    jobIdBusqueda,
    procesarReporte,
    notificarFase3,
    barridoFase3,
    hotelParaPui,
    marcarCheckInEnviado,
    intentarEncolarBusqueda,
    reencolarBusquedas,
};
