/**
 * Estado del sistema para GET /health/estado (indicador del frontend).
 *
 * Conserva lo que ya leen las páginas viejas ({ operativo, db, cola }) y
 * agrega latencias, el servicio de OCR y un nivel de tres valores:
 *   - "error":     Postgres no responde (no se puede registrar nada);
 *   - "degradado": algo lento por encima del umbral, la cola (Redis) caída
 *                  o el OCR no disponible;
 *   - "operativo": todo bien.
 * Sin datos sensibles: solo estados, milisegundos y qué servicio falla.
 */
const { performance } = require('node:perf_hooks');
const axios = require('axios');
const config = require('../config');
const { pool } = require('../db');
const { puiQueue } = require('./puiQueue');

function conTimeout(promesa, ms) {
    let timer;
    return Promise.race([
        promesa,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
    ]).finally(() => clearTimeout(timer));
}

/** Corre la verificación y mide cuánto tardó: { estado: 'ok'|'error', ms }. */
async function medir(verificar, timeoutMs) {
    const t0 = performance.now();
    try {
        await conTimeout(verificar(), timeoutMs);
        return { estado: 'ok', ms: Math.round(performance.now() - t0) };
    } catch {
        return { estado: 'error', ms: null };
    }
}

// El OCR se consulta por la red privada (GET /salud, sin token) y el
// resultado se guarda unos segundos: /health/estado lo piden todas las
// pantallas abiertas cada 60 s y no hay por qué pegarle al servicio en cada una.
let cacheOcr = null; // { valor, expira }
let ocrEnCurso = null;

async function estadoOcr() {
    if (!config.ocr.serviceUrl) return { estado: 'no_configurado', ms: null };
    if (cacheOcr && cacheOcr.expira > Date.now()) return cacheOcr.valor;
    // Varias consultas simultáneas comparten la misma llamada al servicio.
    ocrEnCurso ??= medir(
        () => axios.get(`${config.ocr.serviceUrl}/salud`, { timeout: config.health.ocrTimeoutMs }),
        config.health.ocrTimeoutMs + 200,
    ).then((valor) => {
        cacheOcr = { valor, expira: Date.now() + config.health.ocrCacheMs };
        return valor;
    }).finally(() => { ocrEnCurso = null; });
    return ocrEnCurso;
}

/**
 * Arma la respuesta a partir de las mediciones ({ estado, ms } de cada
 * servicio). Función pura, separada para poder probar cada nivel.
 */
function clasificar(db, cola, ocr, umbral) {
    const causas = [];
    if (db.estado === 'error') causas.push({ servicio: 'db', motivo: 'no_disponible' });
    else if (db.ms > umbral) causas.push({ servicio: 'db', motivo: 'lento' });
    if (cola.estado === 'error') causas.push({ servicio: 'cola', motivo: 'no_disponible' });
    else if (cola.ms > umbral) causas.push({ servicio: 'cola', motivo: 'lento' });
    if (ocr.estado === 'error') causas.push({ servicio: 'ocr', motivo: 'no_disponible' });
    else if (ocr.estado === 'no_configurado') causas.push({ servicio: 'ocr', motivo: 'no_configurado' });
    else if (ocr.ms > umbral) causas.push({ servicio: 'ocr', motivo: 'lento' });

    let nivel = 'operativo';
    if (db.estado === 'error') nivel = 'error';
    else if (causas.length > 0) nivel = 'degradado';

    return {
        // Campos de siempre (Layout.astro solo lee `operativo`)
        operativo: db.estado === 'ok' && cola.estado === 'ok',
        db: db.estado,
        cola: cola.estado,
        // Nuevos (2026-10-17)
        ocr: ocr.estado,
        nivel,
        causas,
        latencia_ms: { db: db.ms, cola: cola.ms, ocr: ocr.ms },
        umbral_lento_ms: umbral,
    };
}

async function obtenerEstado() {
    const [db, cola, ocr] = await Promise.all([
        medir(() => pool.query('SELECT 1'), 3000),
        medir(() => puiQueue.client.then((c) => c.ping()), 3000),
        estadoOcr(),
    ]);
    return clasificar(db, cola, ocr, config.health.umbralLentoMs);
}

module.exports = { obtenerEstado, clasificar };
