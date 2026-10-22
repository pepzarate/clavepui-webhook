/**
 * Validación de los campos de texto libre de un check-in (tarea 4b).
 *
 * Además de escapar en el frontend, el servidor rechaza con 400 lo que no
 * puede ser un nombre, un folio o una habitación, así no se guarda HTML ni
 * nada parecido aunque el cliente no sea la app.
 *
 * - Nombres (nombre, primer_apellido, segundo_apellido): letras de cualquier
 *   alfabeto con sus acentos/diéresis (Unicode \p{L} + marcas \p{M}, incluye
 *   Ñ y Ü), espacios, guion, apóstrofo (' y ’) y punto. Máx. 50 caracteres
 *   (el límite de `nombre` en el Manual PUI, sección 8.2). Ejemplos válidos:
 *   "JOSÉ MARÍA", "D'ARTAGNAN", "MARÍA-JOSÉ", "MA. GUADALUPE", "MÜLLER".
 * - Folio PMS: letras ASCII, dígitos y guion. Máx. 40.
 * - Habitación: letras ASCII, dígitos y guion. Máx. 20.
 *
 * Vacío, null o ausente sigue siendo válido (checkin.astro solo exige la
 * CURP). No recorta ni cambia mayúsculas: se valida el valor tal como se
 * guardará.
 */
const REGLAS = {
    nombre: { max: 50, patron: /^[\p{L}\p{M}' ’.-]+$/u, permitido: 'letras, espacios, guion, apóstrofo y punto' },
    primer_apellido: { max: 50, patron: /^[\p{L}\p{M}' ’.-]+$/u, permitido: 'letras, espacios, guion, apóstrofo y punto' },
    segundo_apellido: { max: 50, patron: /^[\p{L}\p{M}' ’.-]+$/u, permitido: 'letras, espacios, guion, apóstrofo y punto' },
    folio_pms: { max: 40, patron: /^[A-Za-z0-9-]+$/, permitido: 'letras sin acento, números y guion' },
    numero_habitacion: { max: 20, patron: /^[A-Za-z0-9-]+$/, permitido: 'letras sin acento, números y guion' },
};

const ETIQUETAS = {
    nombre: 'El nombre',
    primer_apellido: 'El primer apellido',
    segundo_apellido: 'El segundo apellido',
    folio_pms: 'El folio',
    numero_habitacion: 'La habitación',
};

/** Mensaje de error del primer campo inválido, o null si todos cumplen. */
function validarCamposTexto(body, campos = Object.keys(REGLAS)) {
    for (const campo of campos) {
        const valor = body?.[campo];
        if (valor === undefined || valor === null || valor === '') continue;
        const regla = REGLAS[campo];
        if (typeof valor !== 'string') return { campo, error: `${ETIQUETAS[campo]} debe ser texto` };
        if ([...valor].length > regla.max) {
            return { campo, error: `${ETIQUETAS[campo]} admite máximo ${regla.max} caracteres` };
        }
        if (!regla.patron.test(valor)) {
            return { campo, error: `${ETIQUETAS[campo]} solo admite ${regla.permitido}` };
        }
    }
    return null;
}

module.exports = { validarCamposTexto, REGLAS };
