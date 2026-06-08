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
                    return `${timestamp} [${level}] ${message} ${metaStr}`;
                })
            )
        }),
    ],
});

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

    // Interceptar res.json para loguear la respuesta
    const originalJson = res.json.bind(res);
    res.json = function (body) {
        const duration = Date.now() - start;

        const logData = {
            type: 'request',
            method,
            url: originalUrl,
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

module.exports = { logger, auditLogger };