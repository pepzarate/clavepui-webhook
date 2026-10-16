const express = require('express');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const config = require('../config');
const { logger } = require('../middleware/logger');
const { requireUsuarioStaff } = require('../middleware/auth');
const { requireHotel } = require('./checkIns');

const router = express.Router();

const TIPOS_IMAGEN = ['image/jpeg', 'image/png'];

// Lectura del cuerpo: la imagen en BINARIO (Content-Type image/jpeg o
// image/png), no multipart — así no hace falta una dependencia nueva
// (multer) y el reenvío al servicio de OCR es el mismo buffer tal cual.
// Montado solo en esta ruta: el resto de la app sigue con express.json 1mb.
const leerImagen = express.raw({ type: TIPOS_IMAGEN, limit: '5mb' });

// 60 lecturas / 15 min por usuario de staff (no por IP: varios recepcionistas
// detrás de la misma IP del hotel no se estorban). Montado directo sobre la
// ruta y DESPUÉS de autenticar, para que solo cuente requests a /ocr/ine y
// se pueda usar el id del usuario (ver lección del loginLimiter en CLAUDE.md).
const ocrIneLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${req.usuarioStaff.hotel_id}:${req.usuarioStaff.id}`,
    handler: (req, res) => {
        logger.warn('Rate limit de OCR INE excedido', {
            hotel_id: req.usuarioStaff.hotel_id, usuario: req.usuarioStaff.id,
        });
        res.status(429).json({
            error: 'limite_excedido',
            mensaje: 'Demasiadas lecturas de INE en poco tiempo. Espera unos minutos o captura los datos a mano.',
        });
    },
});

/**
 * Corre express.raw y traduce sus errores a respuestas claras (si no, el
 * manejador global los convertiría en un 500 genérico).
 */
function recibirImagen(req, res, next) {
    leerImagen(req, res, (err) => {
        if (err?.type === 'entity.too.large') {
            return res.status(413).json({ error: 'imagen_muy_grande', mensaje: 'La imagen pesa más de 5 MB.' });
        }
        if (err) {
            return res.status(400).json({ error: 'imagen_invalida', mensaje: 'No se pudo leer la imagen enviada.' });
        }
        // express.raw solo llena req.body si el Content-Type es uno de los permitidos.
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(415).json({
                error: 'tipo_no_soportado',
                mensaje: 'Envía la imagen en binario con Content-Type image/jpeg o image/png.',
            });
        }
        // El Content-Type lo pone el cliente: confirmar con la firma real del archivo.
        const b = req.body;
        const esJpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
        const esPng = b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        if (!esJpeg && !esPng) {
            return res.status(400).json({ error: 'imagen_invalida', mensaje: 'El archivo no es un JPEG ni un PNG válido.' });
        }
        req.tipoImagen = esJpeg ? 'image/jpeg' : 'image/png';
        next();
    });
}

/** Log sin datos personales: nada de CURP, nombre, texto ni imagen. */
function logLectura(req, extra) {
    logger.info('OCR INE', {
        hotel_id: req.usuarioStaff.hotel_id,
        usuario: req.usuarioStaff.id,
        ...extra,
    });
}

const siNo = (v) => (v === true ? 'sí' : v === false ? 'no' : 'null');

/**
 * POST /ocr/ine
 * Lee CURP y nombre del frente de una INE: reenvía la imagen al servicio de
 * OCR (RapidOCR, tools/poc-paddleocr en el repo del frontend) y regresa los
 * datos para PRELLENAR el formulario — no crea ningún check-in.
 *
 * Auth: igual que POST /check-ins/:id/editar (x-hotel-key + JWT de staff).
 * Cuerpo: la imagen en binario, Content-Type image/jpeg o image/png, ≤ 5 MB.
 *
 * 200 { curp, nombre, tiempos } · 422 sin_curp · 400 imagen_invalida
 * 413 imagen_muy_grande · 415 tipo_no_soportado · 429 limite_excedido
 * 503 ocr_no_disponible / ocr_no_configurado / ocr_ocupado · 504 ocr_timeout · 502 ocr_error
 */
router.post('/ocr/ine', requireHotel, requireUsuarioStaff, ocrIneLimiter, recibirImagen, async (req, res) => {
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);

    if (!config.ocr.serviceUrl || !config.ocr.serviceToken) {
        logger.error('OCR INE sin configurar: faltan OCR_SERVICE_URL / OCR_SERVICE_TOKEN');
        return res.status(503).json({
            error: 'ocr_no_configurado',
            mensaje: 'La lectura de INE no está configurada en el servidor. Captura los datos a mano.',
        });
    }

    let r;
    try {
        r = await axios.post(`${config.ocr.serviceUrl}/ocr/ine`, req.body, {
            headers: { 'Content-Type': req.tipoImagen, 'X-OCR-Token': config.ocr.serviceToken },
            timeout: config.ocr.timeoutMs,
            maxBodyLength: 6 * 1024 * 1024,
            validateStatus: () => true, // los códigos del servicio se traducen abajo
        });
    } catch (err) {
        const timeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
        logLectura(req, { ms: ms(), resultado: timeout ? 'timeout' : 'servicio_caido', codigo: err.code });
        return timeout
            ? res.status(504).json({
                error: 'ocr_timeout',
                mensaje: 'La lectura tardó demasiado. Intenta de nuevo o captura los datos a mano.',
            })
            : res.status(503).json({
                error: 'ocr_no_disponible',
                mensaje: 'El servicio de lectura de INE no está disponible. Captura los datos a mano.',
            });
    }

    if (r.status === 400) {
        logLectura(req, { ms: ms(), resultado: 'imagen_invalida' });
        return res.status(400).json({ error: 'imagen_invalida', mensaje: 'No se pudo leer la imagen. Toma otra foto.' });
    }
    if (r.status === 503 && r.data?.error === 'ocupado') {
        // El servicio corre una lectura a la vez con cola corta; si se llena
        // responde 503 al instante en vez de acumular. Es temporal: reintentar.
        logLectura(req, { ms: ms(), resultado: 'ocupado' });
        return res.status(503).json({
            error: 'ocr_ocupado',
            mensaje: 'El lector de INE está ocupado con otras lecturas. Intenta de nuevo en unos segundos.',
        });
    }
    if (r.status !== 200) {
        // 401/503 del servicio = token o configuración mal: es un problema
        // nuestro, no del recepcionista.
        logger.error('OCR INE: el servicio de OCR respondió con error', { status: r.status });
        logLectura(req, { ms: ms(), resultado: 'error_servicio', status_servicio: r.status });
        return res.status(502).json({
            error: 'ocr_error',
            mensaje: 'El servicio de lectura de INE respondió con un error. Captura los datos a mano.',
        });
    }

    const { curp, nombre, tiempos, texto_ocr, lineas } = r.data;
    const tiemposTotal = { ...tiempos, backend_total_ms: ms() };
    logLectura(req, {
        ms: tiemposTotal.backend_total_ms,
        curp_valido: siNo(curp?.valido),
        nombre_coincide: siNo(nombre?.coincide_con_curp),
    });

    if (!curp?.valido) {
        return res.status(422).json({
            error: 'sin_curp',
            mensaje: 'No se encontró un CURP válido en la imagen. Acomoda la INE en el recuadro e intenta de nuevo, o captura los datos a mano.',
            tiempos: tiemposTotal,
        });
    }

    // texto_ocr/lineas solo llegan si el servicio corre con OCR_DEBUG=1.
    return res.json({
        curp,
        nombre,
        tiempos: tiemposTotal,
        ...(texto_ocr !== undefined && { texto_ocr, lineas }),
    });
});

module.exports = router;
