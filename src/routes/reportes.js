const express = require('express');
const PDFDocument = require('pdfkit');
const { pool } = require('../db');
const { logger } = require('../middleware/logger');

const router = express.Router();

async function requireHotel(req, res, next) {
    const apiKey = req.headers['x-hotel-key'];
    if (!apiKey) return res.status(401).json({ error: 'API key requerida' });

    try {
        const result = await pool.query(
            `SELECT id, nombre, rfc FROM hoteles
       WHERE pui_clave = $1 AND activo = TRUE`,
            [apiKey]
        );
        if (result.rowCount === 0)
            return res.status(401).json({ error: 'Hotel no autorizado' });
        req.hotel = result.rows[0];
        next();
    } catch (err) {
        return res.status(500).json({ error: 'Error interno' });
    }
}

/**
 * GET /reportes/pdf
 * Genera reporte PDF de check-ins para evidencia de cumplimiento.
 * Parámetros: ?fecha_inicio=YYYY-MM-DD&fecha_fin=YYYY-MM-DD
 */
router.get('/reportes/pdf', requireHotel, async (req, res) => {
    const {
        fecha_inicio,
        fecha_fin,
    } = req.query;

    try {
        let query = `
      SELECT
        id, curp, nombre, primer_apellido, segundo_apellido,
        fecha_nacimiento, lugar_nacimiento, sexo_asignado,
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

        const result = await pool.query(query, params);
        const checkins = result.rows;

        // ── Generar PDF ───────────────────────────────────────
        const doc = new PDFDocument({
            size: 'LETTER',
            margins: { top: 50, bottom: 50, left: 50, right: 50 },
        });

        const filename = `reporte_pui_${req.hotel.nombre.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.pdf`;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        doc.pipe(res);

        // ── Encabezado ────────────────────────────────────────
        doc.rect(0, 0, doc.page.width, 80).fill('#1b305b');

        doc.fontSize(20)
            .fillColor('#ffffff')
            .font('Helvetica-Bold')
            .text('ClavePUI', 50, 20);

        doc.fontSize(10)
            .fillColor('rgba(255,255,255,0.7)')
            .font('Helvetica')
            .text('Reporte de cumplimiento PUI', 50, 45);

        doc.fontSize(10)
            .fillColor('#f8823a')
            .text('Plataforma Única de Identidad', 50, 58);

        // ── Datos del hotel ───────────────────────────────────
        doc.rect(0, 80, doc.page.width, 60).fill('#f4f6f8');

        doc.fontSize(12)
            .fillColor('#1b305b')
            .font('Helvetica-Bold')
            .text(req.hotel.nombre, 50, 95);

        doc.fontSize(9)
            .fillColor('#6b7280')
            .font('Helvetica')
            .text(`RFC: ${req.hotel.rfc}`, 50, 112);

        const fechaGeneracion = new Date().toLocaleDateString('es-MX', {
            day: 'numeric', month: 'long', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });

        doc.text(`Generado: ${fechaGeneracion}`, 50, 124);

        // Período del reporte
        if (fecha_inicio || fecha_fin) {
            const periodo = [
                fecha_inicio ? `Del ${fecha_inicio}` : '',
                fecha_fin ? `al ${fecha_fin}` : '',
            ].filter(Boolean).join(' ');

            doc.fontSize(9)
                .fillColor('#1b305b')
                .text(`Período: ${periodo}`, 350, 112);
        }

        doc.text(`Total registros: ${checkins.length}`, 350, 124);

        // ── Marco legal ───────────────────────────────────────
        doc.moveDown(4);
        doc.fontSize(8)
            .fillColor('#6b7280')
            .font('Helvetica')
            .text(
                'Este reporte es evidencia de cumplimiento con la Ley General en Materia de Desaparición Forzada de Personas, ' +
                'Desaparición Cometida por Particulares y del Sistema Nacional de Búsqueda de Personas.',
                50, 155, { width: 515, align: 'justify' }
            );

        // ── Estadísticas ──────────────────────────────────────
        doc.y = 185;

        const enviados = checkins.filter(c => c.estado_pui === 'enviado').length;
        const sinReporte = checkins.filter(c => c.estado_pui === 'sin_reporte').length;
        const errores = checkins.filter(c => c.estado_pui === 'error').length;
        const pendientes = checkins.filter(c => c.estado_pui === 'pendiente').length;

        const statW = 120;
        const statH = 50;
        const statY = doc.y;

        // Total
        doc.rect(50, statY, statW, statH).fillAndStroke('#e8edf5', '#d1d5db');
        doc.fontSize(22).fillColor('#1b305b').font('Helvetica-Bold')
            .text(String(checkins.length), 50, statY + 8, { width: statW, align: 'center' });
        doc.fontSize(8).fillColor('#6b7280').font('Helvetica')
            .text('Total check-ins', 50, statY + 34, { width: statW, align: 'center' });

        // Enviados
        doc.rect(182, statY, statW, statH).fillAndStroke('#ecfdf5', '#a7f3d0');
        doc.fontSize(22).fillColor('#065f46').font('Helvetica-Bold')
            .text(String(enviados), 182, statY + 8, { width: statW, align: 'center' });
        doc.fontSize(8).fillColor('#065f46').font('Helvetica')
            .text('Notificados PUI', 182, statY + 34, { width: statW, align: 'center' });

        // Sin reporte
        doc.rect(314, statY, statW, statH).fillAndStroke('#eff6ff', '#bfdbfe');
        doc.fontSize(22).fillColor('#1e40af').font('Helvetica-Bold')
            .text(String(sinReporte), 314, statY + 8, { width: statW, align: 'center' });
        doc.fontSize(8).fillColor('#1e40af').font('Helvetica')
            .text('Sin reporte activo', 314, statY + 34, { width: statW, align: 'center' });

        // Errores
        doc.rect(446, statY, statW, statH).fillAndStroke('#fef2f2', '#fecaca');
        doc.fontSize(22).fillColor('#991b1b').font('Helvetica-Bold')
            .text(String(errores + pendientes), 446, statY + 8, { width: statW, align: 'center' });
        doc.fontSize(8).fillColor('#991b1b').font('Helvetica')
            .text('Pendientes/Error', 446, statY + 34, { width: statW, align: 'center' });

        // ── Tabla de check-ins ────────────────────────────────
        doc.y = statY + statH + 20;

        // Encabezado de tabla
        const tableTop = doc.y;
        const colWidths = [25, 120, 120, 70, 65, 55, 55];
        const colX = [50, 75, 195, 315, 385, 440, 500];
        const headers = ['#', 'CURP', 'Nombre', 'Fecha', 'Hab.', 'Estado', 'Hora'];

        doc.rect(50, tableTop, 515, 20).fill('#1b305b');

        headers.forEach((h, i) => {
            doc.fontSize(8)
                .fillColor('#ffffff')
                .font('Helvetica-Bold')
                .text(h, colX[i], tableTop + 6, { width: colWidths[i], align: 'left' });
        });

        // Filas
        let rowY = tableTop + 20;

        checkins.forEach((ci, idx) => {
            if (rowY > doc.page.height - 80) {
                doc.addPage();
                rowY = 50;
            }

            const bgColor = idx % 2 === 0 ? '#ffffff' : '#f9fafb';
            doc.rect(50, rowY, 515, 18).fill(bgColor);

            const nombre = [ci.nombre, ci.primer_apellido, ci.segundo_apellido]
                .filter(Boolean).join(' ') || '—';

            const fecha = new Date(ci.fecha_checkin).toLocaleDateString('es-MX');
            const hora = new Date(ci.fecha_checkin).toLocaleTimeString('es-MX', {
                hour: '2-digit', minute: '2-digit',
            });

            const estadoColors = {
                enviado: '#065f46',
                sin_reporte: '#1e40af',
                pendiente: '#92400e',
                error: '#991b1b',
            };

            const estadoTextos = {
                enviado: 'Enviado',
                sin_reporte: 'Sin reporte',
                pendiente: 'Pendiente',
                error: 'Error',
            };

            const color = estadoColors[ci.estado_pui] ?? '#374151';

            doc.fontSize(7.5).fillColor('#374151').font('Helvetica')
                .text(String(idx + 1), colX[0], rowY + 5, { width: colWidths[0] });

            doc.fontSize(7).fillColor('#374151').font('Helvetica-Oblique')
                .text(ci.curp, colX[1], rowY + 5, { width: colWidths[1] });

            doc.fontSize(7.5).fillColor('#374151').font('Helvetica')
                .text(nombre.substring(0, 22), colX[2], rowY + 5, { width: colWidths[2] });

            doc.fontSize(7.5).fillColor('#374151')
                .text(fecha, colX[3], rowY + 5, { width: colWidths[3] });

            doc.fontSize(7.5).fillColor('#374151').font('Helvetica')
                .text(ci.numero_habitacion || '—', colX[4], rowY + 5, { width: colWidths[4] });

            doc.fontSize(7.5).fillColor(color).font('Helvetica-Bold')
                .text(estadoTextos[ci.estado_pui] ?? ci.estado_pui, colX[5], rowY + 5, { width: colWidths[5] });

            doc.fontSize(7.5).fillColor('#374151').font('Helvetica')
                .text(hora, colX[6], rowY + 5, { width: colWidths[6] });

            rowY += 18;
        });

        // ── Pie de página ─────────────────────────────────────
        const pageCount = doc.bufferedPageRange().count;
        for (let i = 0; i < pageCount; i++) {
            doc.switchToPage(i);
            doc.fontSize(7)
                .fillColor('#9ca3af')
                .font('Helvetica')
                .text(
                    `ClavePUI — ${req.hotel.nombre} — Página ${i + 1} de ${pageCount}`,
                    50,
                    doc.page.height - 35,
                    { align: 'center', width: 515 }
                );
        }

        doc.end();

        logger.info('PDF generado', {
            type: 'reporte_pdf',
            hotel_id: req.hotel.id,
            total: checkins.length,
        });

    } catch (err) {
        logger.error('Error generando PDF', { error: err.message });
        if (!res.headersSent) {
            return res.status(500).json({ error: 'Error generando el reporte' });
        }
    }
});

module.exports = router;