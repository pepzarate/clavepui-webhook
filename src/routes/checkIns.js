const express = require('express');
const { pool, withHotelContext } = require('../db');
const { logger } = require('../middleware/logger');
const { requireUsuarioStaff } = require('../middleware/auth');
const { validarFormatoCURP, parsearCURP, enmascararCURP } = require('../utils/curp');
const { encolarNotificacionPUI } = require('../services/puiQueue');

const router = express.Router();

/**
 * Middleware de autenticación para recepcionistas.
 * Por ahora valida un API key por hotel en el header.
 * En la Fase frontend se reemplaza por JWT de sesión.
 */
async function requireHotel(req, res, next) {
    const apiKey = req.headers['x-hotel-key'];

    if (!apiKey) {
        return res.status(401).json({ error: 'API key del hotel requerida' });
    }

    try {
        const result = await pool.query(
            `SELECT id, nombre, rfc
       FROM hoteles
       WHERE pui_clave = $1 AND activo = TRUE`,
            [apiKey]
        );

        if (result.rowCount === 0) {
            return res.status(401).json({ error: 'Hotel no autorizado' });
        }

        req.hotel = result.rows[0];
        next();
    } catch (err) {
        logger.error('Error autenticando hotel', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
}

/**
 * POST /check-ins
 * Registra un nuevo check-in manualmente.
 * Dispara notificación asíncrona a la PUI.
 */
router.post('/check-ins', requireHotel, async (req, res) => {
    const {
        curp,
        nombre,
        primer_apellido,
        segundo_apellido,
        fecha_nacimiento,
        lugar_nacimiento,
        sexo_asignado,
        telefono,
        correo,
        registrado_por,
        numero_habitacion,
        folio_pms,
    } = req.body;

    // Validar CURP obligatoria
    if (!curp) {
        return res.status(400).json({ error: 'La CURP es obligatoria' });
    }

    if (!validarFormatoCURP(curp)) {
        return res.status(400).json({
            error: 'CURP inválida. Debe tener 18 caracteres en mayúsculas y números.'
        });
    }

    // Extraer datos automáticos de la CURP si no vienen en el body
    const datosCURP = parsearCURP(curp);
    const fechaNac = fecha_nacimiento || datosCURP?.fechaNacimiento;
    const lugarNac = lugar_nacimiento || datosCURP?.lugarNacimiento;
    const sexo = sexo_asignado || datosCURP?.sexoAsignado;

    try {
        const { checkIn, folioDuplicado, curpDuplicadaHoy } = await withHotelContext(req.hotel.id, async (client) => {
            if (folio_pms) {
                const folioExistente = await client.query(
                    `SELECT 1 FROM check_ins WHERE hotel_id = $1 AND folio_pms = $2`,
                    [req.hotel.id, folio_pms]
                );
                if (folioExistente.rowCount > 0) {
                    return { checkIn: null, folioDuplicado: true, curpDuplicadaHoy: false };
                }
            }

            const curpHoy = await client.query(
                `SELECT 1 FROM check_ins
         WHERE hotel_id = $1 AND curp = $2
           AND DATE(fecha_checkin AT TIME ZONE 'America/Mexico_City') = $3`,
                [req.hotel.id, curp, new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })]
            );

            // Guardar check-in en BD
            const result = await client.query(
                `INSERT INTO check_ins
                    (hotel_id, curp, nombre, primer_apellido, segundo_apellido,
                    fecha_nacimiento, lugar_nacimiento, sexo_asignado,
                    telefono, correo, registrado_por, numero_habitacion, folio_pms, estado_pui)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pendiente')
                RETURNING *`,
                [
                    req.hotel.id,
                    curp,
                    nombre,
                    primer_apellido,
                    segundo_apellido,
                    fechaNac,
                    lugarNac,
                    sexo,
                    telefono,
                    correo,
                    registrado_por || 'recepcion',
                    numero_habitacion || null,
                    folio_pms || null,
                ]
            );

            // Registrar/actualizar huésped frecuente (para autofill en visitas futuras)
            await client.query(
                `INSERT INTO huespedes_frecuentes
                    (hotel_id, curp, nombre, primer_apellido, segundo_apellido,
                    fecha_nacimiento, lugar_nacimiento, sexo_asignado)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                ON CONFLICT (hotel_id, curp) DO UPDATE SET
                    veces_hospedado  = huespedes_frecuentes.veces_hospedado + 1,
                    ultima_visita    = NOW(),
                    nombre           = COALESCE(EXCLUDED.nombre, huespedes_frecuentes.nombre),
                    primer_apellido  = COALESCE(EXCLUDED.primer_apellido, huespedes_frecuentes.primer_apellido),
                    segundo_apellido = COALESCE(EXCLUDED.segundo_apellido, huespedes_frecuentes.segundo_apellido)`,
                [req.hotel.id, curp, nombre, primer_apellido, segundo_apellido, fechaNac, lugarNac, sexo]
            );

            return { checkIn: result.rows[0], folioDuplicado: false, curpDuplicadaHoy: curpHoy.rowCount > 0 };
        });

        if (folioDuplicado) {
            return res.status(409).json({ error: 'Folio ya registrado para este hotel' });
        }

        // Encolar notificación a la PUI de forma asíncrona
        await encolarNotificacionPUI({
            ...checkIn,
            rfc_hotel: req.hotel.rfc,
            // El reporte_pui_id se llenará cuando el gobierno
            // active un reporte de búsqueda para esta CURP
            reporte_pui_id: null,
        });

        logger.info('Check-in registrado', {
            type: 'check_in',
            id: checkIn.id,
            hotel_id: req.hotel.id,
            curp: enmascararCURP(curp),
        });

        return res.status(201).json({
            message: 'Check-in registrado correctamente',
            aviso_curp_duplicada: curpDuplicadaHoy,
            checkin: {
                id: checkIn.id,
                curp: enmascararCURP(curp),
                nombre: checkIn.nombre,
                primer_apellido: checkIn.primer_apellido,
                segundo_apellido: checkIn.segundo_apellido,
                fecha_checkin: checkIn.fecha_checkin,
                estado_pui: checkIn.estado_pui,
                fecha_nacimiento: fechaNac,
                lugar_nacimiento: lugarNac,
                sexo_asignado: sexo,
                numero_habitacion: checkIn.numero_habitacion,
                folio_pms: checkIn.folio_pms,
            },
        });

    } catch (err) {
        logger.error('Error registrando check-in', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * POST /check-ins/:id/editar
 *
 * Edita folio_pms y/o numero_habitacion de un check-in — nunca CURP,
 * nombre, apellidos ni ningún otro dato de identidad del huésped.
 * Solo permitido sobre check-ins del día actual (America/Mexico_City),
 * sin importar el rol del usuario.
 *
 * Se usa POST en vez de PATCH: el middleware global de CORS en app.js
 * solo declara Access-Control-Allow-Methods: GET, POST, OPTIONS (parte
 * del endurecimiento de seguridad documentado como requisito PUI) — un
 * PATCH real desde el navegador fallaría el preflight. Ampliar ese
 * allowlist es una decisión de alcance mayor que este endpoint, así que
 * se sigue la convención ya usada en /activar-reporte, /desactivar-reporte,
 * etc. de rutas de acción con verbo explícito sobre POST.
 *
 * Requiere tanto x-hotel-key (requireHotel) como el JWT de sesión del
 * staff (requireUsuarioStaff) — ambos deben coincidir en el mismo hotel.
 *
 * El body solo puede traer folio_pms y/o numero_habitacion — cualquier
 * otro campo que venga en el body se ignora silenciosamente (no se
 * rechaza la request por eso).
 */
router.post('/check-ins/:id/editar', requireHotel, requireUsuarioStaff, async (req, res) => {
    const checkInId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(checkInId)) {
        return res.status(400).json({ error: 'ID de check-in inválido' });
    }

    const camposPermitidos = ['numero_habitacion', 'folio_pms'];
    const cambios = {};
    for (const campo of camposPermitidos) {
        if (Object.prototype.hasOwnProperty.call(req.body, campo)) {
            cambios[campo] = req.body[campo];
        }
    }

    if (Object.keys(cambios).length === 0) {
        return res.status(400).json({
            error: 'Debes enviar folio_pms y/o numero_habitacion para editar'
        });
    }

    try {
        const resultado = await withHotelContext(req.hotel.id, async (client) => {
            const hoyMX = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

            // Verificación explícita de hotel_id además de RLS (defensa en
            // profundidad) y validación de que el check-in es de hoy.
            const actual = await client.query(
                `SELECT id, numero_habitacion, folio_pms,
                    DATE(fecha_checkin AT TIME ZONE 'America/Mexico_City') = $3 AS es_hoy
                 FROM check_ins
                 WHERE id = $1 AND hotel_id = $2`,
                [checkInId, req.hotel.id, hoyMX]
            );

            if (actual.rowCount === 0) {
                return { status: 404, error: 'Check-in no encontrado' };
            }

            const checkIn = actual.rows[0];

            if (!checkIn.es_hoy) {
                return { status: 403, error: 'Solo se pueden editar check-ins del día actual' };
            }

            // Misma validación de folio duplicado que Feature 14 aplica en
            // la creación (POST /check-ins) — no permitir que la edición
            // introduzca un folio que la creación sí hubiera bloqueado.
            if (cambios.folio_pms) {
                const folioExistente = await client.query(
                    `SELECT 1 FROM check_ins
                     WHERE hotel_id = $1 AND folio_pms = $2 AND id != $3`,
                    [req.hotel.id, cambios.folio_pms, checkInId]
                );
                if (folioExistente.rowCount > 0) {
                    return { status: 409, error: 'Folio ya registrado para este hotel' };
                }
            }

            const sets = [];
            const params = [];
            let idx = 1;
            for (const campo of camposPermitidos) {
                if (!(campo in cambios)) continue;
                sets.push(`${campo} = $${idx}`);
                params.push(cambios[campo] || null);
                idx++;
            }
            params.push(checkInId);

            const actualizado = await client.query(
                `UPDATE check_ins SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, numero_habitacion, folio_pms`,
                params
            );

            // Solo se audita cuando el valor realmente cambia — la UI
            // siempre manda ambos campos aunque el usuario solo haya
            // tocado uno, y guardar sin cambios no debe generar ruido en
            // el rastro de auditoría.
            for (const campo of Object.keys(cambios)) {
                const valorAnterior = checkIn[campo];
                const valorNuevo = cambios[campo] || null;
                if (valorAnterior === valorNuevo) continue;

                await client.query(
                    `INSERT INTO check_ins_ediciones
                        (check_in_id, hotel_id, campo, valor_anterior, valor_nuevo, editado_por)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                        checkInId,
                        req.hotel.id,
                        campo,
                        valorAnterior,
                        valorNuevo,
                        req.usuarioStaff.nombre || req.usuarioStaff.email,
                    ]
                );
            }

            return { checkin: actualizado.rows[0] };
        });

        if (resultado.error) {
            return res.status(resultado.status).json({ error: resultado.error });
        }

        logger.info('Check-in editado', {
            type: 'check_in_editado',
            id: checkInId,
            hotel_id: req.hotel.id,
            editado_por: req.usuarioStaff.email,
            campos: Object.keys(cambios),
        });

        return res.status(200).json({
            message: 'Check-in actualizado correctamente',
            checkin: resultado.checkin,
        });

    } catch (err) {
        logger.error('Error editando check-in', { error: err.message, id: checkInId });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * GET /check-ins
 * Lista los check-ins del hotel con filtros opcionales.
 * Soporta: ?fecha=2026-06-12 ?estado=pendiente ?limit=50 ?offset=0
 */
router.get('/check-ins', requireHotel, async (req, res) => {
    const {
        fecha,
        estado,
        limit = 50,
        offset = 0,
    } = req.query;

    try {
        let query = `
      SELECT
        id, curp, nombre, primer_apellido, segundo_apellido,
        fecha_nacimiento, lugar_nacimiento, sexo_asignado,
        numero_habitacion, folio_pms,
        fecha_checkin, estado_pui, intentos_pui, registrado_por
        FROM check_ins
      WHERE hotel_id = $1
    `;
        const params = [req.hotel.id];
        let paramIdx = 2;

        if (fecha) {
            query += ` AND DATE(fecha_checkin AT TIME ZONE 'America/Mexico_City') = $${paramIdx}`;
            params.push(fecha);
            paramIdx++;
        }

        if (estado) {
            query += ` AND estado_pui = $${paramIdx}`;
            params.push(estado);
            paramIdx++;
        }

        query += ` ORDER BY fecha_checkin DESC`;
        query += ` LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
        params.push(Number.parseInt(limit), Number.parseInt(offset));

        // Contar totales para paginación
        let countQuery = `SELECT COUNT(*) FROM check_ins WHERE hotel_id = $1`;
        const countParams = [req.hotel.id];
        let countParamIdx = 2;

        if (fecha) {
            countQuery += ` AND DATE(fecha_checkin AT TIME ZONE 'America/Mexico_City') = $${countParamIdx}`;
            countParams.push(fecha);
            countParamIdx++;
        }

        if (estado) {
            countQuery += ` AND estado_pui = $${countParamIdx}`;
            countParams.push(estado);
        }

        const { result, countResult } = await withHotelContext(req.hotel.id, async (client) => {
            const result = await client.query(query, params);
            const countResult = await client.query(countQuery, countParams);
            return { result, countResult };
        });

        // Enmascarar CURPs en la respuesta
        const checkins = result.rows.map(row => ({
            ...row,
            curp: enmascararCURP(row.curp),
        }));

        return res.status(200).json({
            total: Number.parseInt(countResult.rows[0].count),
            limit: Number.parseInt(limit),
            offset: Number.parseInt(offset),
            checkins,
        });

    } catch (err) {
        logger.error('Error listando check-ins', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * GET /check-ins/resumen
 * Resumen del día para el dashboard del gerente.
 */
router.get('/check-ins/resumen', requireHotel, async (req, res) => {
    try {
        const result = await withHotelContext(req.hotel.id, (client) => client.query(
            `SELECT
                COUNT(*)                                              AS total,
                COUNT(*) FILTER (WHERE estado_pui = 'enviado')       AS enviados,
                COUNT(*) FILTER (WHERE estado_pui = 'pendiente')     AS pendientes,
                COUNT(*) FILTER (WHERE estado_pui = 'error')         AS errores,
                COUNT(*) FILTER (WHERE estado_pui = 'sin_reporte')   AS sin_reporte
            FROM check_ins
            WHERE hotel_id = $1
                AND DATE(fecha_checkin AT TIME ZONE 'America/Mexico_City') = $2`,
            [req.hotel.id, new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })]
        ));

        const row = result.rows[0];

        return res.status(200).json({
            fecha: new Date().toISOString().split('T')[0],
            hotel: req.hotel.nombre,
            total: Number.parseInt(row.total),
            enviados: Number.parseInt(row.enviados),
            pendientes: Number.parseInt(row.pendientes),
            errores: Number.parseInt(row.errores),
            sin_reporte: Number.parseInt(row.sin_reporte),
        });

    } catch (err) {
        logger.error('Error obteniendo resumen', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * GET /check-ins/export
 * Exporta los check-ins en formato CSV para evidencia legal.
 */
router.get('/check-ins/export', requireHotel, async (req, res) => {
    const { fecha_inicio, fecha_fin } = req.query;

    try {
        let query = `
      SELECT
        id, curp, nombre, primer_apellido, segundo_apellido,
        fecha_nacimiento, lugar_nacimiento, sexo_asignado,
        numero_habitacion, folio_pms,
        fecha_checkin, estado_pui, registrado_por
        FROM check_ins
      WHERE hotel_id = $1
    `;
        const params = [req.hotel.id];
        let paramIdx = 2;

        if (fecha_inicio) {
            query += ` AND DATE(fecha_checkin AT TIME ZONE 'America/Mexico_City') >= $${paramIdx}`;
            params.push(fecha_inicio);
            paramIdx++;
        }

        if (fecha_fin) {
            query += ` AND DATE(fecha_checkin AT TIME ZONE 'America/Mexico_City') <= $${paramIdx}`;
            params.push(fecha_fin);
            paramIdx++;
        }

        query += ` ORDER BY fecha_checkin DESC`;

        const result = await withHotelContext(req.hotel.id, (client) => client.query(query, params));

        // Generar CSV
        const headers = [
            'ID', 'CURP', 'Nombre', 'Primer Apellido', 'Segundo Apellido',
            'Fecha Nacimiento', 'Lugar Nacimiento', 'Sexo', 'Habitación', 'Folio',
            'Fecha Check-in', 'Estado PUI', 'Registrado Por'
        ].join(',');

        const rows = result.rows.map(row => [
            row.id,
            row.curp,
            row.nombre || '',
            row.primer_apellido || '',
            row.segundo_apellido || '',
            row.fecha_nacimiento || '',
            row.lugar_nacimiento || '',
            row.sexo_asignado || '',
            row.numero_habitacion || '',
            row.folio_pms || '',
            new Date(row.fecha_checkin).toLocaleDateString('es-MX', {
                timeZone: 'America/Mexico_City',
                day: '2-digit', month: '2-digit', year: 'numeric',
            }),
            row.estado_pui,
            row.registrado_por || '',
        ].join(','));

        const csv = [headers, ...rows].join('\n');
        const filename = `checkins_${req.hotel.nombre.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.csv`;

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        logger.info('Export CSV generado', {
            type: 'export_csv',
            hotel_id: req.hotel.id,
            total: result.rows.length,
        });

        return res.send('\uFEFF' + csv); // BOM para Excel en español

    } catch (err) {
        logger.error('Error exportando CSV', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * GET /huespedes/buscar?curp=...
 * Busca un huésped frecuente por CURP exacta, para autocompletar el
 * formulario de check-in en visitas recurrentes.
 */
router.get('/huespedes/buscar', requireHotel, async (req, res) => {
    const { curp } = req.query;

    if (!curp || !validarFormatoCURP(String(curp))) {
        return res.status(400).json({ error: 'CURP inválida' });
    }

    try {
        const result = await withHotelContext(req.hotel.id, (client) => client.query(
            `SELECT curp, nombre, primer_apellido, segundo_apellido,
              fecha_nacimiento, lugar_nacimiento, sexo_asignado,
              veces_hospedado, ultima_visita
       FROM huespedes_frecuentes
       WHERE hotel_id = $1 AND curp = $2`,
            [req.hotel.id, curp]
        ));

        if (result.rowCount === 0) {
            return res.status(200).json({ encontrado: false });
        }

        return res.status(200).json({ encontrado: true, huesped: result.rows[0] });
    } catch (err) {
        logger.error('Error buscando huésped frecuente', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * GET /reportes-activos
 * Lista los reportes de búsqueda activos recibidos de la PUI.
 */
router.get('/reportes-activos', requireHotel, async (req, res) => {
    try {
        const result = await withHotelContext(req.hotel.id, (client) => client.query(
            `SELECT id, curp, nombre, primer_apellido,
              recibido_en, activo
       FROM reportes_activos
       WHERE hotel_id = $1 AND activo = TRUE
       ORDER BY recibido_en DESC`,
            [req.hotel.id]
        ));

        return res.status(200).json({ reportes: result.rows });
    } catch (err) {
        logger.error('Error obteniendo reportes activos', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * GET /reportes-historial
 * Lista el historial de reportes (activos e inactivos).
 */
router.get('/reportes-historial', requireHotel, async (req, res) => {
    try {
        const result = await withHotelContext(req.hotel.id, (client) => client.query(
            `SELECT id, curp, nombre, primer_apellido,
              recibido_en, activo
       FROM reportes_activos
       WHERE hotel_id = $1
       ORDER BY recibido_en DESC
       LIMIT 50`,
            [req.hotel.id]
        ));

        return res.status(200).json({ reportes: result.rows });
    } catch (err) {
        logger.error('Error obteniendo historial reportes', { error: err.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;