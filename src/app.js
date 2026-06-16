const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('./config');
require('./services/puiQueue');
const { logger, auditLogger } = require('./middleware/logger');
const { initDb } = require('./db');

// Rutas
const authRoutes = require('./routes/auth');
const activarRoutes = require('./routes/activar');
const desactivarRoutes = require('./routes/desactivar');
const adminRoutes = require('./routes/admin');
const checkInsRoutes = require('./routes/checkIns');
const usuariosRoutes = require('./routes/usuarios');
const reportesRoutes = require('./routes/reportes');

const app = express();

// ── 1. Trust proxy (Railway corre detrás de un proxy) ────────────────────────
app.set('trust proxy', 1);

// ── 2. Headers de seguridad — requisito ciberseguridad PUI ───────────────────
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'none'"],
            scriptSrc: ["'none'"],
            objectSrc: ["'none'"],
        },
    },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
    },
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
    noSniff: true,
}));

// Eliminar headers que revelan tecnología — requisito PUI
app.use((req, res, next) => {
    res.removeHeader('X-Powered-By');
    res.removeHeader('Server');
    next();
});

// ── 3. CORS restrictivo — no permitir wildcard en APIs autenticadas ───────────
app.use((req, res, next) => {
    const allowedOrigins = [
        'https://plataformadebusqueda.gob.mx',
        'https://api.clavepui.com',
        'https://clavepui-frontend.vercel.app',
        'http://localhost:4321',
        'http://localhost:4322',
        'http://localhost:4323',
    ];

    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers',
        'Content-Type, Authorization, x-hotel-key, x-admin-token');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

// ── 4. Rate limiting — requisito ciberseguridad PUI ─────────────────────────
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        logger.warn('Rate limit excedido', { ip: req.ip, url: req.originalUrl });
        res.status(429).json({ error: 'Demasiadas solicitudes, intenta más tarde' });
    },
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50, // aumentar de 20 a 50
    handler: (req, res) => {
        logger.warn('Rate limit login excedido', { ip: req.ip });
        res.status(429).json({ error: 'Demasiados intentos de autenticación' });
    },
});

app.use(globalLimiter);

// ── 5. Parseo de JSON ────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// ── 6. Log de auditoría en cada solicitud ────────────────────────────────────
app.use(auditLogger);

// ── 7. Rutas ─────────────────────────────────────────────────────────────────
app.use('/', loginLimiter, authRoutes);   // POST /login
app.use('/', activarRoutes);              // POST /activar-reporte
// POST /activar-reporte-prueba
app.use('/', desactivarRoutes);           // POST /desactivar-reporte
app.use('/', adminRoutes);
app.use('/', checkInsRoutes);
app.use('/', usuariosRoutes);
app.use('/', reportesRoutes);

// ── 8. Health check — Railway lo monitorea cada 30 segundos ──────────────────
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'clavepui-webhook',
        timestamp: new Date().toISOString(),
        env: config.nodeEnv,
    });
});

// ── 9. Métodos no permitidos — requisito PUI ─────────────────────────────────
app.use((req, res) => {
    if (['GET', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
        return res.status(405).json({ error: 'Método no permitido' });
    }
    return res.status(404).json({ error: 'Ruta no encontrada' });
});

// ── 10. Manejo de errores global — nunca exponer stack traces ────────────────
app.use((err, req, res, next) => {
    logger.error('Error no controlado', {
        error: err.message,
        url: req.originalUrl,
    });
    return res.status(500).json({ error: 'Error interno del servidor' });
});

// ── 11. Arrancar servidor ────────────────────────────────────────────────────
async function start() {
    try {
        await initDb();
        app.listen(config.port, () => {
            logger.info('ClavePUI webhook iniciado', {
                port: config.port,
                env: config.nodeEnv,
                baseUrl: config.server.baseUrl,
            });
        });
    } catch (err) {
        logger.error('Error arrancando servidor', { error: err.message });
        process.exit(1);
    }
}

start();

module.exports = app;