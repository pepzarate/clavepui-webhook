/**
 * Vocabulario único de estados frente a la PUI (tarea 5). Lo usan la lista,
 * los contadores, el filtro y las exportaciones de /historial; el frontend
 * tiene el mismo texto en src/utils/estadosPui.ts.
 *
 * Valores reales de los que sale (revisados después de la 4c):
 *   check_ins.estado_pui:          pendiente | sin_reporte | enviado | error
 *   pui_notificaciones.estado:     enviando | enviada | multiple | rechazada | error
 *     (solo las fases 2 y 3 están ligadas a un check-in; la fase 1 usa
 *      check_in_id = 0)
 *   hoteles: gov_pui_clave (enlace con la PUI) y es_prueba
 *
 * Mapeo (en este orden):
 *   registrado        hotel SIN enlace (sin gov_pui_clave o de prueba): el
 *                     check-in se guardó pero no se compara. Es el de todos
 *                     los hoteles hoy. Se decide por el enlace ACTUAL del hotel.
 *   coincidencia      estado_pui = 'enviado' o tiene un aviso de fase 2/3 en
 *                     pui_notificaciones. Sub-estado del aviso (el último):
 *                       enviada → enviado · multiple → multiple (300) ·
 *                       enviando → pendiente · error → error (se reintenta) ·
 *                       rechazada → rechazado (400) · sin fila → enviado si
 *                       estado_pui = 'enviado' (avisos anteriores a la 4c)
 *   en_revision       estado_pui = 'pendiente'
 *   sin_coincidencia  estado_pui = 'sin_reporte'
 *   error             estado_pui = 'error' sin aviso ligado (no se pudo
 *                     comparar; el sistema reintenta). Un valor de estado_pui
 *                     desconocido también cae aquí, para no esconderlo.
 */
const ESTADOS = ['registrado', 'sin_coincidencia', 'en_revision', 'coincidencia', 'error'];

const ETIQUETAS = {
    registrado: 'Registrado',
    sin_coincidencia: 'Sin coincidencia',
    en_revision: 'En revisión',
    coincidencia: 'Coincidencia',
    error: 'Error al verificar',
};

const ETIQUETAS_AVISO = {
    enviado: 'aviso enviado',
    multiple: 'aviso enviado, coincidencias múltiples',
    pendiente: 'aviso pendiente',
    error: 'aviso con error, se reintenta',
    rechazado: 'aviso rechazado por la PUI',
};

/**
 * Columnas SQL `estado_v2` y `aviso_v2` para una consulta sobre check_ins
 * con alias `c`. `paramEnlazado` es el número de parámetro (boolean) con el
 * enlace del hotel.
 */
function sqlEstado(paramEnlazado) {
    const ultimoAviso = `(SELECT n.estado FROM pui_notificaciones n
        WHERE n.hotel_id = c.hotel_id AND n.check_in_id = c.id AND n.fase IN (2, 3)
        ORDER BY n.actualizado_en DESC, n.id DESC LIMIT 1)`;
    return `
        CASE
            WHEN NOT $${paramEnlazado}::boolean THEN 'registrado'
            WHEN c.estado_pui = 'enviado' OR ${ultimoAviso} IS NOT NULL THEN 'coincidencia'
            WHEN c.estado_pui = 'pendiente' THEN 'en_revision'
            WHEN c.estado_pui = 'sin_reporte' THEN 'sin_coincidencia'
            ELSE 'error'
        END AS estado_v2,
        CASE
            WHEN NOT $${paramEnlazado}::boolean THEN NULL
            ELSE CASE ${ultimoAviso}
                WHEN 'enviada' THEN 'enviado'
                WHEN 'multiple' THEN 'multiple'
                WHEN 'enviando' THEN 'pendiente'
                WHEN 'error' THEN 'error'
                WHEN 'rechazada' THEN 'rechazado'
                ELSE CASE WHEN c.estado_pui = 'enviado' THEN 'enviado' END
            END
        END AS aviso_v2`;
}

/** Texto para exportar: "Coincidencia (aviso enviado)", "Registrado", … */
function textoEstado(estado, aviso) {
    const base = ETIQUETAS[estado] ?? estado;
    return estado === 'coincidencia' && aviso ? `${base} (${ETIQUETAS_AVISO[aviso] ?? aviso})` : base;
}

/**
 * ¿El hotel está enlazado con la PUI? Un hotel de prueba nunca cuenta, salvo
 * que tenga enlace_simulado y NO estemos en producción: así se prueban en
 * local las pantallas de un hotel enlazado sin ninguna clave real. Mostrarlo
 * como enlazado no cambia nada del envío: el worker omite los de prueba.
 */
const hotelEnlazado = (hotel) => {
    if (hotel?.es_prueba) return Boolean(hotel.enlace_simulado) && process.env.NODE_ENV !== 'production';
    return Boolean(hotel?.gov_pui_clave);
};

module.exports = { ESTADOS, ETIQUETAS, ETIQUETAS_AVISO, sqlEstado, textoEstado, hotelEnlazado };
