const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logger } = require('../middleware/logger');

const router = express.Router();

/**
 * POST /desactivar-reporte
 *
 * La PUI llama aquí cuando la persona fue localizada.
 * Debemos detener toda búsqueda activa asociada al id.
 * Manual PUI sección 8.4: solo requiere el campo 'id'.
 */
router.post('/desactivar-reporte', requireAuth, async (req, res) => {
    const { id } = req.body;

    if (!id) {
        return res.status(400).json({ errores: ["'id' es obligatorio"] });
    }

    if (id.length < 36 || id.length > 75) {
        return res.status(400).json({
            errores: ["'id' debe tener entre 36 y 75 caracteres"]
        });
    }

    try {
        const result = await pool.query(
            `UPDATE reportes_activos
       SET activo = FALSE
       WHERE id = $1
       RETURNING id`,
            [id]
        );

        if (result.rowCount === 0) {
            logger.warn('Desactivar reporte no encontrado', {
                type: 'desactivar_reporte',
                id,
                ip: req.ip,
            });
        } else {
            logger.info('Reporte desactivado', {
                type: 'desactivar_reporte',
                id,
                ip: req.ip,
            });
        }

        return res.status(200).json({
            message: 'Registro de finalización de búsqueda histórica guardado correctamente'
        });

    } catch (err) {
        logger.error('Error desactivando reporte', { error: err.message, id });
        return res.status(500).json({ error: 'Error interno al procesar la solicitud' });
    }
});

module.exports = router;