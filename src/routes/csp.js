const express = require('express');
const rateLimit = require('express-rate-limit');
const { logger } = require('../middleware/logger');

const router = express.Router();

/**
 * POST /csp-report
 * Recibe los reportes de la Content-Security-Policy del frontend
 * (clavepui-frontend/vercel.json, por ahora en modo Report-Only).
 *
 * Se monta ANTES del limitador global (app.js): una página que viole la
 * política en cada carga no debe gastar las 400 solicitudes/15 min de la IP
 * del hotel. Tiene su propio límite y, al pasarlo, responde 204 sin loguear.
 *
 * Sin datos personales: solo la directiva, el ORIGEN de lo bloqueado y la
 * RUTA de la página (sin query). Nunca `script-sample` ni la URL completa.
 */
const cspLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: false,
    legacyHeaders: false,
    handler: (req, res) => res.status(204).end(),
});

const parsearReporte = express.json({
    limit: '20kb',
    type: ['application/csp-report', 'application/reports+json', 'application/json'],
});

/** Origen de una URL, o la palabra clave tal cual ('inline', 'eval', ...). */
function soloOrigen(valor) {
    if (typeof valor !== 'string' || !valor) return null;
    try {
        return new URL(valor).origin;
    } catch {
        return valor.slice(0, 40);
    }
}

function soloRuta(valor) {
    try {
        return new URL(valor).pathname;
    } catch {
        return null;
    }
}

router.post('/csp-report', cspLimiter, parsearReporte, (req, res) => {
    // Formato viejo (report-uri): { "csp-report": {...} }; nuevo (Reporting API): [{ type, body }]
    const reportes = Array.isArray(req.body)
        ? req.body.filter((r) => r?.type === 'csp-violation').map((r) => r.body ?? {})
        : [req.body?.['csp-report'] ?? {}];

    for (const r of reportes.slice(0, 10)) {
        logger.warn('Violación de CSP', {
            type: 'csp_violacion',
            directiva: String(r['effective-directive'] ?? r.effectiveDirective ?? r['violated-directive'] ?? '').slice(0, 60),
            bloqueado: soloOrigen(r['blocked-uri'] ?? r.blockedURL),
            pagina: soloRuta(r['document-uri'] ?? r.documentURL),
            modo: r.disposition ?? null,
        });
    }
    return res.status(204).end();
});

module.exports = router;
module.exports.soloOrigen = soloOrigen;
