/**
 * Utilidades para validación y parsing de CURP
 * Basado en el Anexo 5 del Manual Técnico PUI
 */

// Mapa de códigos de estado según Anexo 5 del Manual PUI
const ESTADOS_CURP = {
    AS: 'AGUASCALIENTES',
    BC: 'BAJA CALIFORNIA',
    BS: 'BAJA CALIFORNIA SUR',
    CC: 'CAMPECHE',
    CS: 'CHIAPAS',
    CH: 'CHIHUAHUA',
    DF: 'CDMX',
    CL: 'COAHUILA',
    CM: 'COLIMA',
    DG: 'DURANGO',
    GT: 'GUANAJUATO',
    GR: 'GUERRERO',
    HG: 'HIDALGO',
    JC: 'JALISCO',
    MC: 'MEXICO',
    MN: 'MICHOACAN',
    MS: 'MORELOS',
    NT: 'NAYARIT',
    NL: 'NUEVO LEON',
    OC: 'OAXACA',
    PL: 'PUEBLA',
    QO: 'QUERETARO',
    QR: 'QUINTANA ROO',
    SP: 'SAN LUIS POTOSI',
    SL: 'SINALOA',
    SR: 'SONORA',
    TC: 'TABASCO',
    TS: 'TAMAULIPAS',
    TL: 'TLAXCALA',
    VZ: 'VERACRUZ',
    YN: 'YUCATAN',
    ZS: 'ZACATECAS',
    NE: 'FORANEO',
    XX: 'DESCONOCIDO',
};

/**
 * Valida el formato de una CURP.
 * Regex según especificación del Manual PUI: ^[A-Z0-9]{18}$
 */
function validarFormatoCURP(curp) {
    if (!curp) return false;
    return /^[A-Z0-9]{18}$/.test(curp);
}

/**
 * Extrae datos básicos de una CURP válida.
 * Estructura CURP: AAAA YYMMDD H/M CCCC XX D
 * Posiciones 12-13 = código de estado de nacimiento
 */
function parsearCURP(curp) {
    if (!validarFormatoCURP(curp)) return null;

    const codigoEstado = curp.substring(11, 13);
    const sexo = curp.charAt(10);
    const anio = curp.substring(4, 6);
    const mes = curp.substring(6, 8);
    const dia = curp.substring(8, 10);

    // Determinar siglo — si año > 25 asumimos 1900s, si no 2000s
    const anioCompleto = Number.parseInt(anio) > 25
        ? `19${anio}`
        : `20${anio}`;

    return {
        fechaNacimiento: `${anioCompleto}-${mes}-${dia}`,
        sexoAsignado: sexo === 'H' ? 'H' : sexo === 'M' ? 'M' : 'X',
        lugarNacimiento: ESTADOS_CURP[codigoEstado] || 'DESCONOCIDO',
        codigoEstado,
    };
}

/**
 * Enmascara una CURP para logs — muestra solo los primeros 4 chars
 */
function enmascararCURP(curp) {
    if (!curp || curp.length < 4) return '***';
    return curp.substring(0, 4) + '*'.repeat(14);
}

module.exports = { validarFormatoCURP, parsearCURP, enmascararCURP };