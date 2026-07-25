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