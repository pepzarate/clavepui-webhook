/**
 * PDF de GET /historial/exportar (tarea 5), con el vocabulario nuevo de
 * estados. Es aparte de GET /reportes/pdf (que siguen usando las páginas
 * actuales y no cambia), pero con las mismas lecciones del incidente del
 * 2026-09-27: bufferPages + rango real de páginas para el pie, margen
 * inferior en 0 solo mientras se escribe el pie, y el PDF armado en memoria
 * (nunca doc.pipe(res)) con listener de 'error'.
 */
const PDFDocument = require('pdfkit');
const { fechaLocal, horaLocal, hora12 } = require('../utils/zonaHoraria');

const COLOR_ESTADO = {
    registrado: '#475069',
    sin_coincidencia: '#475069',
    en_revision: '#8a5a12',
    coincidencia: '#b42318',
    error: '#54586b',
};

function generarPdfHistorial({ hotel, desde, hasta, filas, filtrado }) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margins: { top: 40, bottom: 50, left: 40, right: 40 }, bufferPages: true });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('error', reject);
        doc.on('end', () => resolve(Buffer.concat(chunks)));

        const ancho = doc.page.width - 80;
        doc.rect(0, 0, doc.page.width, 64).fill('#1b305b');
        doc.font('Helvetica-Bold').fontSize(18).fillColor('#ffffff').text('ClavePUI', 40, 16);
        doc.font('Helvetica').fontSize(10).fillColor('#dfe4ee').text('Historial de check-ins', 40, 40);

        doc.fillColor('#1b305b').font('Helvetica-Bold').fontSize(12).text(hotel.nombre, 40, 80, { width: ancho });
        doc.font('Helvetica').fontSize(9).fillColor('#475069')
            .text(`RFC: ${hotel.rfc}   ·   Periodo: ${desde === hasta ? desde : `${desde} a ${hasta}`}   ·   Registros: ${filas.length}${filtrado ? '   ·   Con filtros aplicados' : ''}`, 40, 98, { width: ancho });
        const ahora = new Date();
        doc.text(`Generado: ${fechaLocal(ahora)} ${hora12(horaLocal(ahora))}`, 40, 111, { width: ancho });

        const cols = [
            { t: 'Fecha', w: 62 }, { t: 'Hora', w: 50 }, { t: 'Hab.', w: 60 }, { t: 'Folio', w: 70 },
            { t: 'Huésped', w: 170 }, { t: 'CURP', w: 112 }, { t: 'Estado PUI', w: 188 },
        ];
        let y = 132;
        const encabezado = () => {
            doc.rect(40, y, ancho, 18).fill('#1b305b');
            let x = 40;
            for (const c of cols) {
                doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff').text(c.t, x + 4, y + 5, { width: c.w - 6, lineBreak: false });
                x += c.w;
            }
            y += 18;
        };
        encabezado();
        filas.forEach((f, i) => {
            if (y > doc.page.height - 70) {
                doc.addPage();
                y = 40;
                encabezado();
            }
            doc.rect(40, y, ancho, 17).fill(i % 2 ? '#f7f9fd' : '#ffffff');
            // Hora en 12 h (tarea 7); el CSV la deja en 24 h
            const valores = [f.fecha, hora12(f.hora), f.habitacion || '—', f.folio || '—',
                [f.nombre, f.primer_apellido, f.segundo_apellido].filter(Boolean).join(' ') || '—', f.curp, f.estado];
            let x = 40;
            cols.forEach((c, j) => {
                const esEstado = j === cols.length - 1;
                doc.font(esEstado ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5)
                    .fillColor(esEstado ? COLOR_ESTADO[f.estado_clave] ?? '#1b305b' : '#1b305b')
                    .text(String(valores[j]), x + 4, y + 5, { width: c.w - 6, lineBreak: false, ellipsis: true });
                x += c.w;
            });
            y += 17;
        });
        if (!filas.length) {
            doc.font('Helvetica').fontSize(10).fillColor('#475069').text('Sin check-ins en este periodo.', 40, y + 12);
        }

        const rango = doc.bufferedPageRange();
        for (let i = rango.start; i < rango.start + rango.count; i++) {
            doc.switchToPage(i);
            const margen = doc.page.margins.bottom;
            doc.page.margins.bottom = 0;
            doc.font('Helvetica').fontSize(7).fillColor('#8a93ad')
                .text(`ClavePUI — ${hotel.nombre} — Página ${i - rango.start + 1} de ${rango.count}`, 40, doc.page.height - 30, { width: ancho, align: 'center' });
            doc.page.margins.bottom = margen;
        }
        doc.end();
    });
}

module.exports = { generarPdfHistorial };
