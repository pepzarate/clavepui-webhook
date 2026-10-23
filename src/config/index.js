require('dotenv').config();

const config = {
    port: Number.parseInt(process.env.PORT) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    isProd: process.env.NODE_ENV === 'production',

    jwt: {
        secret: process.env.JWT_SECRET,
        expirySeconds: Number.parseInt(process.env.JWT_EXPIRY_SECONDS) || 3600,
    },

    pui: {
        usuario: 'PUI', // valor fijo que define el manual — nunca cambia
        // Aviso a la PUI (puiQueue.js): POST /check-ins no espera a Redis más
        // que esto; si no alcanza, el check-in queda pendiente de encolar
        // (check_ins.encolado_pui = false) y el reencolador lo reintenta.
        encolarTimeoutMs: Number.parseInt(process.env.PUI_ENCOLAR_TIMEOUT_MS) || 2000,
        reencolarIntervaloMs: Number.parseInt(process.env.PUI_REENCOLAR_INTERVALO_MS) || 60000,
        // Antigüedad mínima de un pendiente para reencolarlo: deja terminar
        // el intento de la propia request (que dura hasta encolarTimeoutMs).
        reencolarGraciaMs: Number.parseInt(process.env.PUI_REENCOLAR_GRACIA_MS) || 30000,
        // API del gobierno (Manual Técnico, sección 7). Fuera de producción
        // NO hay valor por defecto: sin PUI_API_URL explícita (p. ej. el mock
        // de las pruebas) el cliente se niega a llamar, así nunca se le pega
        // al API real desde local ni desde las pruebas (services/puiApi.js).
        apiUrl: process.env.PUI_API_URL
            || (process.env.NODE_ENV === 'production' ? 'https://www.api.plataformadebusqueda.gob.mx/api/2_3_0' : null),
        apiTimeoutMs: Number.parseInt(process.env.PUI_API_TIMEOUT_MS) || 10000,
        // Reintento de la búsqueda histórica (fases 1 y 2) que quedó en error
        busquedaReintentoMs: Number.parseInt(process.env.PUI_BUSQUEDA_REINTENTO_MS) || 30 * 60 * 1000,
        // Barrido de la fase 3 (búsqueda continua periódica)
        barridoMs: Number.parseInt(process.env.PUI_BARRIDO_MS) || 60 * 60 * 1000,
    },

    db: {
        connectionString: process.env.DATABASE_URL,
        // Rol restringido (sin SUPERUSER/BYPASSRLS) para queries tenant-scoped —
        // las policies de RLS solo protegen de verdad si este rol no puede
        // saltárselas. En local, DATABASE_URL ya apunta a un rol sin privilegios
        // de superusuario, así que reusarlo como fallback es seguro; en Railway
        // DATABASE_URL es el rol "postgres" (superusuario) y es obligatorio
        // configurar DATABASE_URL_TENANT aparte.
        tenantConnectionString: process.env.DATABASE_URL_TENANT || process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production'
            ? { rejectUnauthorized: false }
            : false,
    },

    server: {
        baseUrl: process.env.BASE_URL || 'http://localhost:3000',
    },

    // Servicio de OCR de INE (RapidOCR, tools/poc-paddleocr en el repo del
    // frontend). Opcional: sin estas variables POST /ocr/ine responde 503 y
    // el resto de la app funciona igual.
    ocr: {
        serviceUrl: (process.env.OCR_SERVICE_URL || '').replace(/\/$/, ''),
        serviceToken: process.env.OCR_SERVICE_TOKEN || '',
        timeoutMs: Number.parseInt(process.env.OCR_TIMEOUT_MS) || 10000,
    },

    // GET /health/estado (services/estadoSistema.js)
    health: {
        // Arriba de esto, un servicio que responde cuenta como lento → "degradado"
        umbralLentoMs: Number.parseInt(process.env.HEALTH_UMBRAL_LENTO_MS) || 1000,
        // GET /salud del servicio de OCR: timeout corto y resultado en caché
        ocrTimeoutMs: Number.parseInt(process.env.HEALTH_OCR_TIMEOUT_MS) || 1500,
        ocrCacheMs: Number.parseInt(process.env.HEALTH_OCR_CACHE_MS) || 15000,
    },

    webPush: {
        publicKey: process.env.VAPID_PUBLIC_KEY,
        privateKey: process.env.VAPID_PRIVATE_KEY,
        // mailto de contacto requerido por el estándar VAPID, no un email
        // que reciba correos — los navegadores solo lo usan si necesitan
        // contactar al operador del servicio push.
        subject: process.env.VAPID_SUBJECT || 'mailto:soporte@clavepui.com',
    },
};

// Validar variables críticas al arrancar
const required = ['JWT_SECRET', 'DATABASE_URL'];
const missing = required.filter(key => !process.env[key]);

if (missing.length > 0) {
    console.error(`[Config] Variables faltantes: ${missing.join(', ')}`);
    process.exit(1);
}

module.exports = config;