const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { withAdminContext } = require('../db');
const { logger } = require('../middleware/logger');
const config = require('../config');

const router = express.Router();

/**
 * POST /auth/login
 * Login para recepcionistas y gerentes del sistema.
 * Diferente al POST /login que es exclusivo para la PUI del gobierno.
 */
router.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({
            error: 'Email y contraseña son obligatorios'
        });
    }

    try {
        // Búsqueda cross-tenant por email: todavía no sabemos el hotel_id
        // en este punto del login, así que corre con contexto admin.
        const result = await withAdminContext((client) => client.query(
            `SELECT
         u.id, u.nombre, u.email, u.password_hash, u.rol,
         u.hotel_id,
         h.nombre AS hotel_nombre,
         h.rfc    AS hotel_rfc,
         h.pui_clave
       FROM usuarios u
       JOIN hoteles h ON h.id = u.hotel_id
       WHERE u.email = $1
         AND u.activo = TRUE
         AND h.activo = TRUE`,
            [email.toLowerCase().trim()]
        ));

        if (result.rowCount === 0) {
            logger.warn('Login fallido — usuario no encontrado', {
                type: 'auth_failure',
                email,
                ip: req.ip,
            });
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }

        const usuario = result.rows[0];

        // Verificar contraseña
        const passwordValido = await bcrypt.compare(password, usuario.password_hash);

        if (!passwordValido) {
            logger.warn('Login fallido — contraseña incorrecta', {
                type: 'auth_failure',
                email,
                ip: req.ip,
            });
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }

        // Generar JWT de sesión
        const token = jwt.sign(
            {
                sub: usuario.id,
                email: usuario.email,
                nombre: usuario.nombre,
                rol: usuario.rol,
                hotel_id: usuario.hotel_id,
                hotel_nombre: usuario.hotel_nombre,
            },
            config.jwt.secret,
            { expiresIn: '8h' } // turno de trabajo
        );

        logger.info('Login exitoso', {
            type: 'auth_success',
            usuario: usuario.id,
            hotel_id: usuario.hotel_id,
            rol: usuario.rol,
            ip: req.ip,
        });

        return res.status(200).json({
            token,
            usuario: {
                id: usuario.id,
                nombre: usuario.nombre,
                email: usuario.email,
                rol: usuario.rol,
            },
            hotel: {
                id: usuario.hotel_id,
                nombre: usuario.hotel_nombre,
                rfc: usuario.hotel_rfc,
                pui_clave: usuario.pui_clave,
            },
        });

    } catch (err) {
        logger.error('Error en login', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * POST /auth/usuarios
 * Crea un nuevo usuario recepcionista o gerente.
 * Solo accesible con token de admin.
 */
router.post('/auth/usuarios', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];

    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'No autorizado' });
    }

    const { hotel_id, nombre, email, password, rol = 'recepcionista' } = req.body;

    if (!hotel_id || !nombre || !email || !password) {
        return res.status(400).json({
            error: 'hotel_id, nombre, email y password son obligatorios'
        });
    }

    if (!['recepcionista', 'gerente'].includes(rol)) {
        return res.status(400).json({
            error: 'El rol debe ser recepcionista o gerente'
        });
    }

    if (password.length < 8) {
        return res.status(400).json({
            error: 'La contraseña debe tener al menos 8 caracteres'
        });
    }

    try {
        const password_hash = await bcrypt.hash(password, 12);

        const result = await withAdminContext((client) => client.query(
            `INSERT INTO usuarios (hotel_id, nombre, email, password_hash, rol)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET
         nombre        = $2,
         password_hash = $4,
         rol           = $5,
         activo        = TRUE
       RETURNING id, nombre, email, rol, hotel_id`,
            [hotel_id, nombre, email.toLowerCase().trim(), password_hash, rol]
        ));

        const usuario = result.rows[0];

        logger.info('Usuario creado', {
            type: 'usuario_creado',
            id: usuario.id,
            hotel_id: usuario.hotel_id,
            rol: usuario.rol,
        });

        return res.status(201).json({
            message: 'Usuario creado correctamente',
            usuario: {
                id: usuario.id,
                nombre: usuario.nombre,
                email: usuario.email,
                rol: usuario.rol,
                hotel_id: usuario.hotel_id,
            },
        });

    } catch (err) {
        logger.error('Error creando usuario', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * GET /auth/me
 * Devuelve los datos del usuario autenticado.
 * El frontend lo usa para verificar si la sesión sigue activa.
 */
router.get('/auth/me', async (req, res) => {
    const authHeader = req.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Token requerido' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, config.jwt.secret);

        return res.status(200).json({
            usuario: {
                id: decoded.sub,
                nombre: decoded.nombre,
                email: decoded.email,
                rol: decoded.rol,
            },
            hotel: {
                id: decoded.hotel_id,
                nombre: decoded.hotel_nombre,
            },
        });

    } catch (err) {
        return res.status(401).json({ error: 'Token inválido o expirado' });
    }
});

module.exports = router;