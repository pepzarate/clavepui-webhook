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
        clave: process.env.PUI_CLAVE,
    },

    db: {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production'
            ? { rejectUnauthorized: false }
            : false,
    },

    server: {
        baseUrl: process.env.BASE_URL || 'http://localhost:3000',
    },
};

// Validar variables críticas al arrancar
const required = ['JWT_SECRET', 'PUI_CLAVE', 'DATABASE_URL'];
const missing = required.filter(key => !process.env[key]);

if (missing.length > 0) {
    console.error(`[Config] Variables faltantes: ${missing.join(', ')}`);
    process.exit(1);
}

module.exports = config;