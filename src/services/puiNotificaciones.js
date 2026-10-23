/**
 * Envío idempotente a /notificar-coincidencia, con bitácora en
 * pui_notificaciones (una fila por hotel + reporte + fase + check-in + huella).
 *
 * - Fases 1 y 2: huella '' → un solo aviso por (reporte, fase, check-in).
 * - Fase 3: huella = sha256 del payload → un registro MODIFICADO genera un
 *   aviso nuevo (manual 6.4.c, "registros nuevos o modificados") y uno igual
 *   nunca se repite, venga del worker del check-in, de una edición o del
 *   barrido periódico.
 *
 * Antes de llamar a la PUI se "reserva" la fila (estado 'enviando', en su
 * propia transacción): si dos procesos llegan a la vez solo uno envía. Una
 * reserva de más de 2 min (proceso caído) o una fila en 'error' se puede
 * retomar. 'enviada', 'multiple' y 'rechazada' son definitivas.
 * RLS: todo con withHotelContext del hotel.
 */
const { withHotelContext } = require('../db');
const { logger } = require('../middleware/logger');
const puiApi = require('./puiApi');
const { huellaDe } = require('./puiPayload');

const DEFINITIVOS = new Set(['enviada', 'multiple', 'rechazada']);

async function reservar(hotelId, clave) {
    return withHotelContext(hotelId, async (c) => {
        const nueva = await c.query(
            `INSERT INTO pui_notificaciones (hotel_id, reporte_id, fase, check_in_id, huella, estado, intentos)
             VALUES ($1, $2, $3, $4, $5, 'enviando', 1)
             ON CONFLICT (hotel_id, reporte_id, fase, check_in_id, huella) DO NOTHING
             RETURNING id`,
            [hotelId, clave.reporteId, clave.fase, clave.checkInId, clave.huella]
        );
        if (nueva.rowCount) return { id: nueva.rows[0].id };
        const retomada = await c.query(
            `UPDATE pui_notificaciones
             SET estado = 'enviando', intentos = intentos + 1, actualizado_en = NOW()
             WHERE hotel_id = $1 AND reporte_id = $2 AND fase = $3 AND check_in_id = $4 AND huella = $5
               AND (estado = 'error' OR (estado = 'enviando' AND actualizado_en < NOW() - interval '2 minutes'))
             RETURNING id`,
            [hotelId, clave.reporteId, clave.fase, clave.checkInId, clave.huella]
        );
        if (retomada.rowCount) return { id: retomada.rows[0].id };
        const actual = await c.query(
            `SELECT estado FROM pui_notificaciones
             WHERE hotel_id = $1 AND reporte_id = $2 AND fase = $3 AND check_in_id = $4 AND huella = $5`,
            [hotelId, clave.reporteId, clave.fase, clave.checkInId, clave.huella]
        );
        return { previo: actual.rows[0]?.estado ?? 'enviando' };
    });
}

async function cerrar(hotelId, id, estado, httpStatus, error = null) {
    await withHotelContext(hotelId, (c) => c.query(
        `UPDATE pui_notificaciones
         SET estado = $2, http_status = $3, ultimo_error = $4, actualizado_en = NOW()
         WHERE id = $1`,
        [id, estado, httpStatus, error]
    ));
}

/**
 * Notifica una vez. Devuelve el estado final:
 *   'enviada' | 'multiple' | 'rechazada'           → se llamó a la PUI ahora
 *   'ya_enviada' | 'ya_multiple' | 'ya_rechazada'  → ya estaba (no se llamó)
 *   'en_curso'                                      → otro proceso lo está enviando
 * Lanza los errores de puiApi (transitorio → reintentar; permanente → no).
 */
async function notificarUnaVez({ hotel, reporteId, fase, checkInId = 0, payload }) {
    const clave = { reporteId, fase, checkInId, huella: fase === 3 ? huellaDe(payload) : '' };
    const reserva = await reservar(hotel.id, clave);
    if (!reserva.id) {
        return DEFINITIVOS.has(reserva.previo) ? `ya_${reserva.previo}` : 'en_curso';
    }
    try {
        const r = await puiApi.notificarCoincidencia(hotel, payload);
        const error = r.estado === 'rechazada' ? `400: ${r.errores.join(' | ')}`.slice(0, 500) : null;
        await cerrar(hotel.id, reserva.id, r.estado, r.status, error);
        logger[r.estado === 'enviada' ? 'info' : 'warn']('Aviso a la PUI', {
            type: 'pui_notificacion',
            hotel_id: hotel.id,
            reporteId,
            fase,
            checkinId: checkInId || null,
            resultado: r.estado,
            status: r.status,
            ...(r.errores?.length ? { errores: r.errores } : {}),
        });
        return r.estado;
    } catch (err) {
        await cerrar(hotel.id, reserva.id, 'error', null, err.message.slice(0, 500)).catch(() => {});
        logger.error('Aviso a la PUI falló', {
            type: 'pui_notificacion',
            hotel_id: hotel.id,
            reporteId,
            fase,
            checkinId: checkInId || null,
            error: err.message,
        });
        throw err;
    }
}

module.exports = { notificarUnaVez };
