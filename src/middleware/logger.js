const winston = require('winston');

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    const metaStr = Object.keys(meta).length
                        ? JSON.stringify(meta)
                        : '';
                    return `${String(timestamp)} [${level}] ${String(message)} ${metaStr}`;
                })
            )
        }),
    ],
});

// Parámetros de la URL con datos personales (GET /check-ins/curp-activa,
// /huespedes/buscar, /huespedes/buscar-por-nombre): se enmascaran igual que
// en el body. Antes de 2026-10-19 la URL se registraba completa.
const PARAMS_SENSIBLES = {
    curp: (v) => v.substring(0, 4) + '***',
    nombre: () => '***',
};

function urlSinDatosPersonales(url) {
    const i = url.indexOf('?');
    if (i === -1) return url;
    const params = new URLSearchParams(url.slice(i + 1));
    let cambio = false;
    for (const [clave, enmascarar] of Object.entries(PARAMS_SENSIBLES)) {
        if (params.has(clave)) {
            params.set(clave, enmascarar(params.get(clave)));
            cambio = true;
        }
    }
    return cambio ? `${url.slice(0, i)}?${params}` : url;
}

/**
 * Middleware de auditoría obligatorio según Manual Técnico PUI.
 * Registra toda solicitud recibida, con datos enmascarados.
 */
function auditLogger(req, res, next) {
    const start = Date.now();
    const { method, originalUrl, ip } = req;

    // Copia del body para loguear sin mutar el original
    const requestBody = { ...req.body };

    // Enmascarar datos sensibles antes de loguear
    if (requestBody.clave) requestBody.clave = '***';
    if (requestBody.curp) requestBody.curp = requestBody.curp.substring(0, 4) + '***';
    if (requestBody.password) requestBody.password = '***';
    if (requestBody.pui_clave) requestBody.pui_clave = '***';
    if (requestBody.gov_pui_clave) requestBody.gov_pui_clave = '***';
    // Nombre y contacto del huésped (POST /check-ins, /activar-reporte), desde 2026-10-19
    for (const campo of ['nombre', 'primer_apellido', 'segundo_apellido', 'telefono', 'correo']) {
        if (requestBody[campo]) requestBody[campo] = '***';
    }

    // Interceptar res.json para loguear la respuesta
    const originalJson = res.json.bind(res);
    res.json = function (body) {
        const duration = Date.now() - start;

        const logData = {
            type: 'request',
            method,
            url: urlSinDatosPersonales(originalUrl),
            ip,
            statusCode: res.statusCode,
            durationMs: duration,
            requestBody,
            responseStatus: res.statusCode < 400 ? 'success' : 'error',
        };

        if (res.statusCode >= 400) {
            logger.warn('Solicitud con error', logData);
        } else {
            logger.info('Solicitud procesada', logData);
        }

        return originalJson(body);
    };

    next();
}

module.exports = { logger, auditLogger, urlSinDatosPersonales };