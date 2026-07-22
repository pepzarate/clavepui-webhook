const express = require('express');
const { pool, withAdminContext } = require('../db');
const { logger } = require('../middleware/logger');

const router = express.Router();

/**
 * POST /admin/hoteles
 * Endpoint temporal para registrar hoteles en producción.
 * Protegido con un token de admin definido en .env
 */
router.post('/admin/hoteles', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];

    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'No autorizado' });
    }

    const { nombre, rfc, pui_clave } = req.body;

    if (!nombre || !rfc || !pui_clave) {
        return res.status(400).json({
            error: 'nombre, rfc y pui_clave son obligatorios'
        });
    }

    try {
        const result = await pool.query(
            `INSERT INTO hoteles (nombre, rfc, pui_clave)
       VALUES ($1, $2, $3)
       ON CONFLICT (rfc) DO UPDATE SET
         nombre    = $1,
         pui_clave = $3,
         activo    = TRUE
       RETURNING id, nombre, rfc`,
            [nombre, rfc, pui_clave]
        );

        const hotel = result.rows[0];
        logger.info('Hotel registrado via admin', { hotel_id: hotel.id, nombre: hotel.nombre });

        return res.status(200).json({
            message: 'Hotel registrado correctamente',
            hotel
        });

    } catch (err) {
        logger.error('Error registrando hotel', { error: err.message });
        return res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * POST /admin/limpiar-pruebas
 * Marca todos los registros de prueba como sin_reporte.
 * Usar solo durante desarrollo — eliminar antes de entrega final.
 */
router.post('/admin/limpiar-pruebas', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];

    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'No autorizado' });
    }

    try {
        const result = await withAdminContext((client) => client.query(
            `UPDATE check_ins
       SET estado_pui   = 'sin_reporte',
           intentos_pui = 0,
           ultimo_error = null
       WHERE estado_pui IN ('pendiente', 'error')
       RETURNING id`
        ));

        return res.status(200).json({
            message: `${result.rowCount} registros actualizados`,
        });

    } catch (err) {
        return res.status(500).json({ error: 'Error interno' });
    }
});

router.post('/admin/limpiar-reportes-prueba', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'No autorizado' });
    }

    try {
        const result = await withAdminContext((client) => client.query(
            `DELETE FROM reportes_activos
       WHERE curp = $1`,
            ['GOCJ900115HDFNRL08']
        ));
        return res.status(200).json({
            message: `${result.rowCount} reportes de prueba eliminados`
        });
    } catch (err) {
        return res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * POST /admin/hoteles/:id/gov-clave
 * Guarda la clave gubernamental (Punto 4 del portal PUI) para un hotel.
 */
router.post('/admin/hoteles/:id/gov-clave', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'No autorizado' });
    }

    const { id } = req.params;
    const { gov_pui_clave } = req.body;

    if (!gov_pui_clave) {
        return res.status(400).json({ error: 'gov_pui_clave es obligatoria' });
    }

    try {
        const result = await pool.query(
            `UPDATE hoteles SET gov_pui_clave = $1 WHERE id = $2 RETURNING id, nombre`,
            [gov_pui_clave, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Hotel no encontrado' });
        }

        logger.info('Clave gubernamental actualizada', { hotel_id: id });
        return res.status(200).json({ message: 'Clave guardada correctamente', hotel: result.rows[0] });

    } catch (err) {
        logger.error('Error guardando clave gubernamental', { error: err.message });
        return res.status(500).json({ error: 'Error interno' });
    }
});

module.exports = router;