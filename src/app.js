const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { logger, auditLogger } = require('./middleware/logger');
const { initDb } = require('./db');
const { obtenerEstado } = require('./services/estadoSistema');
const { iniciarReencolador } = require('./services/puiQueue');

// Rutas
const authRoutes = require('./routes/auth');
const activarRoutes = require('./routes/activar');
const desactivarRoutes = require('./routes/desactivar');
const adminRoutes = require('./routes/admin');
const checkInsRoutes = require('./routes/checkIns');
const usuariosRoutes = require('./routes/usuarios');
const reportesRoutes = require('./routes/reportes');
const hotelesRoutes = require('./routes/hoteles');
const pushRoutes = require('./routes/push');
const ocrRoutes = require('./routes/ocr');
const cspRoutes = require('./routes/csp');
const historialRoutes = require('./routes/historial');
const alertasRoutes = require('./routes/alertas');

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
        'https://app.clavepui.com',
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
// Límite global por IP, compartido por TODO el tráfico de esa IP (dashboard
// polling, check-ins, historial, exports, etc. — no solo login). Un hotel
// activo con varios miembros de staff detrás de la misma IP (NAT) puede
// generar fácilmente 120-150 requests en 15 minutos sin que nadie esté
// atacando nada: /health/estado se consulta cada 60s en CUALQUIER pantalla
// logueada (Layout.astro, ~15 req/15min por pestaña abierta), dashboard.astro
// además pide resumen+listado cada 60s (~30 req/15min más mientras esa
// pestaña esté abierta), y sobre eso se suma el trabajo real (check-ins,
// cargas de historial, exports). 400 deja margen ~3x sobre ese escenario
// realista de varios miembros de staff activos a la vez.
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 400,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        logger.warn('Rate limit excedido', { ip: req.ip, url: req.originalUrl });
        res.status(429).json({ error: 'Demasiadas solicitudes, intenta más tarde' });
    },
});

// Reportes de CSP del frontend: antes del limitador global, con límite propio
// (ver routes/csp.js), para que no consuman el cupo de la IP del hotel
app.use('/', cspRoutes);

app.use(globalLimiter);

// ── 5. Parseo de JSON ────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// ── 6. Log de auditoría en cada solicitud ────────────────────────────────────
app.use(auditLogger);

// ── 7. Rutas ─────────────────────────────────────────────────────────────────
app.use('/', authRoutes);                 // POST /login (limitador propio en auth.js)
app.use('/', activarRoutes);              // POST /activar-reporte
// POST /activar-reporte-prueba
app.use('/', desactivarRoutes);           // POST /desactivar-reporte
app.use('/', adminRoutes);
app.use('/', checkInsRoutes);
app.use('/', historialRoutes);              // GET /historial, /historial/exportar, /historial/:id (tarea 5)
app.use('/', alertasRoutes);                // GET /alertas, /alertas/contador (tarea 6)
app.use('/', usuariosRoutes);
app.use('/', reportesRoutes);
app.use('/', hotelesRoutes);
app.use('/', pushRoutes);
app.use('/', ocrRoutes);                  // POST /ocr/ine (limitador propio en ocr.js)

// ── 8. Health check — Railway lo monitorea cada 30 segundos ──────────────────
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'clavepui-webhook',
        timestamp: new Date().toISOString(),
        env: config.nodeEnv,
    });
});

/**
 * GET /health/estado
 * Chequeo más profundo (DB + cola de Redis + servicio de OCR) para el
 * indicador de estado del sistema del frontend. Separado de /health porque
 * ese lo monitorea Railway cada 30s y no debe depender de servicios
 * externos. Detalle de la respuesta en services/estadoSistema.js.
 */
app.get('/health/estado', async (req, res) => {
    return res.status(200).json(await obtenerEstado());
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
        // Reintenta cada minuto los avisos a la PUI que no se pudieron encolar
        iniciarReencolador();
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