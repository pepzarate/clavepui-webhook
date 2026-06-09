const jwt = require('jsonwebtoken');
const config = require('../config');
const { logger } = require('./logger');

/**
 * Valida el Bearer token en cada endpoint protegido.
 * La PUI obtiene el token desde /login y lo envía aquí.
 */
function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
        logger.warn('Acceso sin token', {
            type: 'auth_failure',
            url: req.originalUrl,
            ip: req.ip,
        });
        return res.status(401).json({ error: 'Token no proporcionado' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, config.jwt.secret);
        req.puiAuth = decoded;
        next();
    } catch (err) {
        logger.warn('Token inválido o expirado', {
            type: 'auth_failure',
            url: req.originalUrl,
            ip: req.ip,
            error: err.message,
        });
        return res.status(401).json({ error: 'Token inválido o expirado' });
    }
}

module.exports = { requireAuth };