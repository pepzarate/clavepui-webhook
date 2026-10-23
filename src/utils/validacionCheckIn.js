/**
 * Validación de los campos de texto libre de un check-in (tareas 4b y 4c).
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
 * - Folio PMS y habitación: letras ASCII, dígitos y los símbolos de
 *   SIMBOLOS_FOLIO / SIMBOLOS_HABITACION. Máx. 40 / 20.
 *   Para permitir otro símbolo (p. ej. "/", "." o "#" si aparecen en datos
 *   reales de algún PMS) basta agregarlo a la lista: el patrón y el mensaje
 *   se arman solos. Los de PROHIBIDOS (< > " ' ` = & : ;) no se pueden
 *   agregar: sirven para inyectar HTML o JS y el módulo no carga.
 *
 * Habitación: además admite coma y espacio para varias habitaciones
 * ("101, 102"); normalizarHabitacion() deja siempre "101, 102" al guardar
 * (decisión del 2026-10-22, con los datos reales de producción).
 *
 * Un "|" en cualquiera de estos campos es casi siempre el contenido del QR
 * de la INE que el lector USB tecleó en el campo equivocado: se rechaza con
 * un mensaje que lo dice (MENSAJE_QR_CAMPO_EQUIVOCADO).
 *
 * Vacío, null o ausente sigue siendo válido (checkin.astro solo exige la
 * CURP). No recorta ni cambia mayúsculas: se valida el valor tal como se
 * guardará.
 */
const SIMBOLOS_FOLIO = ['-'];
const SIMBOLOS_HABITACION = ['-', ',', ' '];

const MENSAJE_QR_CAMPO_EQUIVOCADO =
    'Parece una lectura del QR en el campo equivocado; colócate en el campo CURP y vuelve a escanear';

const PROHIBIDOS = new Set(['<', '>', '"', "'", '`', '=', '&', ':', ';']);
const NOMBRES_SIMBOLOS = { '-': 'guion', ',': 'coma', '/': 'diagonal', '.': 'punto', '#': 'gato (#)', '_': 'guion bajo', ' ': 'espacio' };

/** Regla para folio/habitación: [A-Za-z0-9] + los símbolos dados. */
function reglaCodigo(simbolos, max) {
    for (const c of simbolos) {
        if (typeof c !== 'string' || [...c].length !== 1 || PROHIBIDOS.has(c)) {
            throw new Error(`Símbolo no permitido en la regla de validación: ${JSON.stringify(c)}`);
        }
    }
    // Dentro de [...] solo \ ] [ ^ y - tienen significado: se escapan
    const clase = simbolos.map((c) => c.replace(/[\\\]\[^-]/g, '\\$&')).join('');
    const nombres = simbolos.map((c) => NOMBRES_SIMBOLOS[c] ?? `"${c}"`);
    return {
        max,
        patron: new RegExp(`^[A-Za-z0-9${clase}]+$`),
        permitido: `letras sin acento, números${nombres.length ? ` y ${nombres.join(', ')}` : ''}`,
    };
}

const REGLA_NOMBRE = {
    max: 50,
    patron: /^[\p{L}\p{M}' ’.-]+$/u,
    permitido: 'letras, espacios, guion, apóstrofo y punto',
};

const REGLAS = {
    nombre: REGLA_NOMBRE,
    primer_apellido: REGLA_NOMBRE,
    segundo_apellido: REGLA_NOMBRE,
    folio_pms: reglaCodigo(SIMBOLOS_FOLIO, 40),
    numero_habitacion: reglaCodigo(SIMBOLOS_HABITACION, 20),
};

const ETIQUETAS = {
    nombre: 'El nombre',
    primer_apellido: 'El primer apellido',
    segundo_apellido: 'El segundo apellido',
    folio_pms: 'El folio',
    numero_habitacion: 'La habitación',
};

/** { campo, error } del primer campo inválido, o null si todos cumplen. */
function validarCamposTexto(body, campos = Object.keys(REGLAS)) {
    for (const campo of campos) {
        const valor = body?.[campo];
        if (valor === undefined || valor === null || valor === '') continue;
        const regla = REGLAS[campo];
        if (typeof valor !== 'string') return { campo, error: `${ETIQUETAS[campo]} debe ser texto` };
        if (valor.includes('|')) return { campo, error: MENSAJE_QR_CAMPO_EQUIVOCADO };
        if ([...valor].length > regla.max) {
            return { campo, error: `${ETIQUETAS[campo]} admite máximo ${regla.max} caracteres` };
        }
        if (!regla.patron.test(valor)) {
            return { campo, error: `${ETIQUETAS[campo]} solo admite ${regla.permitido}` };
        }
    }
    return null;
}

/**
 * "101 , 102" / "101,102" / " 101  ,102 " → "101, 102". Espacios internos de
 * una habitación se reducen a uno ("SUITE  2" → "SUITE 2"). Otros valores
 * (vacío, null, no texto) se devuelven igual.
 */
function normalizarHabitacion(valor) {
    if (typeof valor !== 'string') return valor;
    return valor
        .split(',')
        .map((h) => h.trim().replace(/\s+/g, ' '))
        .filter(Boolean)
        .join(', ');
}

module.exports = {
    validarCamposTexto, normalizarHabitacion, reglaCodigo, REGLAS,
    SIMBOLOS_FOLIO, SIMBOLOS_HABITACION, MENSAJE_QR_CAMPO_EQUIVOCADO,
};
