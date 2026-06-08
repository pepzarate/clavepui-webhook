const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { logger } = require('../middleware/logger');

const router = express.Router();

/**
 * POST /login
 *
 * La PUI llama aquí para obtener el Bearer token.
 * Manual PUI sección 8.1:
 * - usuario: siempre el string fijo "PUI"
 * - clave: 16-20 chars, mayúscula + número + char especial
 */
router.post('/login', (req, res) => {
    const { usuario, clave } = req.body;

    if (!usuario || !clave) {
        return res.status(400).json({
            error: 'Los campos usuario y clave son obligatorios'
        });
    }

    // El manual especifica usuario fijo "PUI" — cualquier otro valor es 401
    if (usuario !== config.pui.usuario) {
        logger.warn('Login con usuario incorrecto', {
            type: 'auth_failure',
            ip: req.ip,
        });
        return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    if (clave !== config.pui.clave) {
        logger.warn('Login con clave incorrecta', {
            type: 'auth_failure',
            ip: req.ip,
        });
        return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign(
        {
            sub: 'pui-gobierno',
            iss: 'clavepui',
        },
        config.jwt.secret,
        { expiresIn: config.jwt.expirySeconds }
    );

    logger.info('Token emitido para la PUI', {
        type: 'auth_success',
        ip: req.ip,
    });

    return res.status(200).json({ token });
});

module.exports = router;