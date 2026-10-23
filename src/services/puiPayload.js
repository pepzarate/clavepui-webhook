/**
 * Payload de /notificar-coincidencia, campo por campo contra el Manual
 * Técnico, sección 7.2 (y Anexo 5). Fases en la sección 6, paso 4.
 *
 * Campo                    Origen en ClavePUI                     Regla del manual
 * ───────────────────────  ─────────────────────────────────────  ──────────────────────────────────────────
 * curp            (oblig.) check-in / reporte                     ^[A-Z0-9]{18}$
 * nombre_completo          nombre, primer_ y segundo_apellido      objeto; cada uno ^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ '-]{1,50}$
 * fecha_nacimiento         de la CURP (siglo por la posición 17)   YYYY-MM-DD
 * lugar_nacimiento(oblig.) de la CURP (posiciones 12-13, Anexo 5) enum; NE → FORÁNEO, inválido → DESCONOCIDO
 * sexo_asignado            de la CURP (posición 11)                ^[MHX]$
 * telefono / correo        del check-in, si cumplen su regex       ^\+?\d{0,15}$ / regex de correo
 * domicilio, fotos,        no se capturan en el hotel: se omiten  (opcionales)
 *   huellas
 * id              (oblig.) id del reporte (<FUB>-<UUID4>)          36-75
 * institucion_id  (oblig.) RFC del hotel                           ^[A-Z0-9]{4,13}$
 * fase_busqueda   (oblig.) "1" | "2" | "3"                         ^[1-3]$
 * — solo fases 2 y 3 (la fase 1 los omite, sección 6.4.a) —
 * tipo_evento              "Check-in en hotel"                    ≤ 500, caracteres de dirección
 * fecha_evento             fecha del check-in en hora del hotel    YYYY-MM-DD (el manual pide fecha, sin hora)
 * descripcion_lugar_evento "<razón social>, habitación <n>"        ≤ 500, caracteres de dirección
 * direccion_evento         se omite: `hoteles` no guarda domicilio (opcional; pendiente de producto)
 *
 * Los nombres se normalizan a lo que acepta la regex del manual (sin punto,
 * ’ → ', acentos fuera de ÁÉÍÓÚÜÑ se quitan) y se omiten si quedan vacíos:
 * nunca se manda algo que la PUI rechazaría con 400 por un detalle de forma.
 */
const crypto = require('node:crypto');
const { fechaLocal, zonaDelHotel } = require('../utils/zonaHoraria');

// Anexo 5. Nota: la sección 7.2 escribe "FORANEO" sin acento, pero la tabla
// del Anexo 5 (a la que remite) y la sección 8.2 dicen "FORÁNEO"; se usa la
// tabla. Confirmar en el sandbox de la PUI.
const ESTADOS_ANEXO_5 = {
    AS: 'AGUASCALIENTES', BC: 'BAJA CALIFORNIA', BS: 'BAJA CALIFORNIA SUR', CC: 'CAMPECHE',
    CS: 'CHIAPAS', CH: 'CHIHUAHUA', DF: 'CDMX', CL: 'COAHUILA', CM: 'COLIMA', DG: 'DURANGO',
    GT: 'GUANAJUATO', GR: 'GUERRERO', HG: 'HIDALGO', JC: 'JALISCO', MC: 'MÉXICO',
    MN: 'MICHOACÁN', MS: 'MORELOS', NT: 'NAYARIT', NL: 'NUEVO LEÓN', OC: 'OAXACA',
    PL: 'PUEBLA', QO: 'QUERÉTARO', QR: 'QUINTANA ROO', SP: 'SAN LUIS POTOSÍ', SL: 'SINALOA',
    SR: 'SONORA', TC: 'TABASCO', TS: 'TAMAULIPAS', TL: 'TLAXCALA', VZ: 'VERACRUZ',
    YN: 'YUCATÁN', ZS: 'ZACATECAS', NE: 'FORÁNEO', XX: 'DESCONOCIDO',
};

const TIPO_EVENTO = 'Check-in en hotel';
const LETRAS_NOMBRE = /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ '-]/;
const CARACTERES_TEXTO = /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 .,#'/:()\-]/;
const RE_CURP = /^[A-Z0-9]{18}$/;

/** Deja solo lo que acepta `permitido`; un acento no permitido se cambia por su letra base. */
function limpiar(texto, permitido, max) {
    if (typeof texto !== 'string') return '';
    let r = '';
    for (const c of texto.replace(/[’‘`´]/g, "'")) {
        if (permitido.test(c)) r += c;
        else {
            const base = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
            if (base.length === 1 && permitido.test(base)) r += base;
        }
    }
    return r.replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

const limpiarNombre = (t) => limpiar(t, LETRAS_NOMBRE, 50);
const limpiarTexto = (t, max = 500) => limpiar(t, CARACTERES_TEXTO, max);

/** Datos derivados de la CURP según RENAPO y el Anexo 5. */
function datosDeCurp(curp) {
    if (!RE_CURP.test(curp ?? '')) return { lugar_nacimiento: 'DESCONOCIDO' };
    const datos = { lugar_nacimiento: ESTADOS_ANEXO_5[curp.slice(11, 13)] ?? 'DESCONOCIDO' };
    const sexo = curp[10];
    if (/^[HMX]$/.test(sexo)) datos.sexo_asignado = sexo;
    // Posición 17: dígito → nacido antes de 2000, letra → 2000 en adelante
    const siglo = /\d/.test(curp[16]) ? '19' : '20';
    const fecha = `${siglo}${curp.slice(4, 6)}-${curp.slice(6, 8)}-${curp.slice(8, 10)}`;
    const d = new Date(`${fecha}T00:00:00Z`);
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === fecha) datos.fecha_nacimiento = fecha;
    return datos;
}

/**
 * Payload para una fase.
 *   persona:  { curp, nombre, primer_apellido, segundo_apellido, telefono, correo }
 *   evento:   { fecha_checkin, numero_habitacion } (fases 2 y 3)
 *   hotel:    { rfc, nombre, zona_horaria? }
 */
function construirPayload({ fase, reporteId, hotel, persona, evento }) {
    const curp = String(persona.curp ?? '').toUpperCase();
    const payload = { curp };

    const nombre_completo = {};
    for (const campo of ['nombre', 'primer_apellido', 'segundo_apellido']) {
        const v = limpiarNombre(persona[campo]);
        if (v) nombre_completo[campo] = v;
    }
    if (Object.keys(nombre_completo).length) payload.nombre_completo = nombre_completo;

    Object.assign(payload, datosDeCurp(curp));

    const telefono = String(persona.telefono ?? '').replace(/[\s()-]/g, '');
    if (telefono && /^\+?\d{1,15}$/.test(telefono)) payload.telefono = telefono;
    const correo = String(persona.correo ?? '').trim();
    if (correo && correo.length <= 50 && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,50}$/.test(correo)) {
        payload.correo = correo;
    }

    payload.id = reporteId;
    payload.institucion_id = hotel.rfc;
    payload.fase_busqueda = String(fase);

    if (fase !== 1) {
        payload.tipo_evento = TIPO_EVENTO;
        payload.fecha_evento = fechaLocal(new Date(evento.fecha_checkin), zonaDelHotel(hotel));
        const hab = limpiarTexto(String(evento.numero_habitacion ?? ''), 20);
        const lugar = limpiarTexto(`${hotel.nombre}${hab ? `, habitación ${hab}` : ''}`);
        if (lugar) payload.descripcion_lugar_evento = lugar;
    }
    return payload;
}

/** sha256 del contenido (llaves ordenadas): identifica "el mismo aviso". */
function huellaDe(payload) {
    const ordenar = (v) => (v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, ordenar(v[k])]))
        : v);
    return crypto.createHash('sha256').update(JSON.stringify(ordenar(payload))).digest('hex');
}

/** ¿Hay al menos un dato básico para completar la ficha? (fase 1, sección 6.4.a) */
function tieneDatosParaCompletar(payload) {
    return Boolean(payload.nombre_completo || payload.fecha_nacimiento || payload.sexo_asignado
        || payload.telefono || payload.correo || (payload.lugar_nacimiento && payload.lugar_nacimiento !== 'DESCONOCIDO'));
}

module.exports = { construirPayload, huellaDe, tieneDatosParaCompletar, datosDeCurp, limpiarNombre, ESTADOS_ANEXO_5, TIPO_EVENTO };
