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

/**
 * Middleware que verifica que el usuario tenga rol de gerente.
 */
function requireGerente(req, res, next) {
    const authHeader = req.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Token requerido' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, config.jwt.secret);

        if (decoded.rol !== 'gerente') {
            return res.status(403).json({ error: 'Acceso restringido a gerentes' });
        }

        req.usuario = decoded;
        next();

    } catch (err) {
        return res.status(401).json({ error: 'Token inválido o expirado' });
    }
}

/**
 * Valida el JWT de sesión del staff (recepcionista/gerente) emitido por
 * POST /auth/login — mismo JWT_SECRET y mismo formato de claims que ya
 * decodifica GET /auth/me (sub, nombre, email, rol, hotel_id). Adjunta
 * la identidad decodificada en req.usuarioStaff.
 *
 * Debe montarse DESPUÉS de requireHotel en la cadena de middlewares: si
 * req.hotel ya está seteado (desde x-hotel-key), se compara que el
 * hotel_id del JWT coincida — evita que alguien mande el JWT de un hotel
 * junto con la x-hotel-key de otro.
 *
 * Alcance acotado por ahora al endpoint de edición de check-ins — no se
 * aplica retroactivamente a los demás endpoints existentes de check-ins.
 */
function requireUsuarioStaff(req, res, next) {
    const authHeader = req.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Token de sesión requerido' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, config.jwt.secret);

        // El JWT de la PUI gobierno (POST /login) usa el mismo secreto pero
        // no trae rol de staff — rechazarlo aquí en vez de dejarlo pasar.
        if (!['recepcionista', 'gerente'].includes(decoded.rol)) {
            return res.status(401).json({ error: 'Token no corresponde a un usuario staff' });
        }

        if (req.hotel && decoded.hotel_id !== req.hotel.id) {
            logger.warn('JWT de staff no coincide con el hotel de x-hotel-key', {
                type: 'auth_failure',
                jwt_hotel_id: decoded.hotel_id,
                hotel_key_hotel_id: req.hotel.id,
                ip: req.ip,
            });
            return res.status(403).json({ error: 'El token de sesión no corresponde a este hotel' });
        }

        req.usuarioStaff = {
            id: decoded.sub,
            nombre: decoded.nombre,
            email: decoded.email,
            rol: decoded.rol,
            hotel_id: decoded.hotel_id,
        };
        next();

    } catch (err) {
        return res.status(401).json({ error: 'Token inválido o expirado' });
    }
}

module.exports = { requireAuth, requireGerente, requireUsuarioStaff };
