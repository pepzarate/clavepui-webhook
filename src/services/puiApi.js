/**
 * Cliente del API de la PUI (Manual Técnico, sección 7; copia en
 * docs/pui/Manual_Tecnico_Plataforma_Unica_de_Identidad_Instituciones_Diversas.pdf de este repo).
 *
 *   POST /login                  { institucion_id: RFC, clave } → { token }   (7.1)
 *   POST /notificar-coincidencia  payload de puiPayload.js                  (7.2)
 *   POST /busqueda-finalizada     { id, institucion_id }                     (7.3)
 *
 * - URL base en config.pui.apiUrl. Fuera de producción no hay valor por
 *   defecto: sin PUI_API_URL el cliente lanza en vez de llamar (nunca se le
 *   pega al API real desde local ni desde pruebas).
 * - Token por hotel en memoria; el manual da 1 h de vigencia y recomienda
 *   renovarlo antes del 80 %: se renueva a los 45 min. Ante un 401 se pide
 *   uno nuevo y se reintenta una vez.
 * - Respuestas de /notificar-coincidencia (7.2):
 *     200 → 'enviada'; 300 (coincidencias múltiples) → 'multiple'; 400 →
 *     'rechazada' (error en los campos: reintentar no sirve).
 *     El manual no dice qué hacer con el 300: es una respuesta definitiva de
 *     la PUI (identificó a más de una persona), no un fallo nuestro, así que
 *     se registra y no se reintenta.
 *   500, red o timeout → ErrorPuiTransitorio (el job se reintenta con espera).
 *   403 en /login (credenciales inválidas) → ErrorPuiPermanente.
 * - Logs sin datos personales: solo hotel, endpoint, código y duración.
 */
const axios = require('axios');
const config = require('../config');
const { logger } = require('../middleware/logger');

class ErrorPuiTransitorio extends Error {}
class ErrorPuiPermanente extends Error {}

const VIGENCIA_TOKEN_MS = 45 * 60 * 1000; // < 80 % de 1 h
const tokens = new Map(); // hotel_id → { token, obtenido }

function urlBase() {
    if (!config.pui.apiUrl) {
        throw new ErrorPuiPermanente('PUI_API_URL no configurada: fuera de producción no se llama al API real de la PUI');
    }
    return config.pui.apiUrl.replace(/\/+$/, '');
}

async function post(ruta, body, token) {
    const t0 = Date.now();
    try {
        const res = await axios.post(`${urlBase()}${ruta}`, body, {
            headers: { 'Content-Type': 'application/json; charset=utf-8', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            timeout: config.pui.apiTimeoutMs,
            validateStatus: () => true, // los códigos se interpretan aquí (300 no es error)
        });
        return { status: res.status, data: res.data, ms: Date.now() - t0 };
    } catch (err) {
        if (err instanceof ErrorPuiPermanente) throw err;
        throw new ErrorPuiTransitorio(`sin respuesta de ${ruta}: ${err.code || err.message}`);
    }
}

/** Token vigente del hotel (lo pide si no hay o si se fuerza). */
async function obtenerToken(hotel, { forzar = false } = {}) {
    const guardado = tokens.get(hotel.id);
    if (!forzar && guardado && Date.now() - guardado.obtenido < VIGENCIA_TOKEN_MS) return guardado.token;
    const r = await post('/login', { institucion_id: hotel.rfc, clave: hotel.gov_pui_clave });
    logger.info('Login a la PUI', { type: 'pui_api', hotel_id: hotel.id, endpoint: '/login', status: r.status, ms: r.ms });
    if (r.status === 200 && r.data?.token) {
        tokens.set(hotel.id, { token: r.data.token, obtenido: Date.now() });
        return r.data.token;
    }
    tokens.delete(hotel.id);
    if (r.status === 403 || r.status === 401) throw new ErrorPuiPermanente(`login rechazado por la PUI (${r.status})`);
    throw new ErrorPuiTransitorio(`login a la PUI respondió ${r.status}`);
}

/** POST autenticado; ante 401 renueva el token y reintenta una vez. */
async function postAutenticado(hotel, ruta, body) {
    let r = await post(ruta, body, await obtenerToken(hotel));
    if (r.status === 401) {
        r = await post(ruta, body, await obtenerToken(hotel, { forzar: true }));
    }
    logger.info('Llamada a la PUI', { type: 'pui_api', hotel_id: hotel.id, endpoint: ruta, status: r.status, ms: r.ms });
    return r;
}

/**
 * /notificar-coincidencia. Devuelve { estado, status, errores? }:
 * 'enviada' | 'multiple' | 'rechazada'. Lanza ErrorPuiTransitorio en 5xx,
 * 401 persistente, red o timeout.
 */
async function notificarCoincidencia(hotel, payload) {
    const r = await postAutenticado(hotel, '/notificar-coincidencia', payload);
    if (r.status === 200) return { estado: 'enviada', status: 200 };
    if (r.status === 300) return { estado: 'multiple', status: 300 };
    if (r.status === 400) {
        // Los mensajes de la PUI nombran campos y reglas, no valores
        const errores = Array.isArray(r.data?.errores) ? r.data.errores.map((e) => String(e).slice(0, 200)) : [];
        return { estado: 'rechazada', status: 400, errores };
    }
    throw new ErrorPuiTransitorio(`/notificar-coincidencia respondió ${r.status}`);
}

/** /busqueda-finalizada. true si la PUI respondió 200; lanza si hay que reintentar. */
async function busquedaFinalizada(hotel, reporteId) {
    const r = await postAutenticado(hotel, '/busqueda-finalizada', { id: reporteId, institucion_id: hotel.rfc });
    if (r.status === 200) return true;
    if (r.status >= 400 && r.status < 500 && r.status !== 401) {
        throw new ErrorPuiPermanente(`/busqueda-finalizada respondió ${r.status}`);
    }
    throw new ErrorPuiTransitorio(`/busqueda-finalizada respondió ${r.status}`);
}

/** Solo para pruebas */
function olvidarTokens() {
    tokens.clear();
}

module.exports = {
    notificarCoincidencia,
    busquedaFinalizada,
    ErrorPuiTransitorio,
    ErrorPuiPermanente,
    olvidarTokens,
};
