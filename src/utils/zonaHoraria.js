/**
 * Hora y fecha locales del hotel, calculadas en el servidor.
 *
 * Todos los hoteles usan America/Mexico_City por ahora: `hoteles` no guarda
 * zona horaria. Si se agrega (p. ej. hoteles.zona_horaria para Quintana Roo
 * = America/Cancun, Sonora = America/Hermosillo, Baja California =
 * America/Tijuana), basta con que zonaDelHotel() la lea y que las consultas
 * por día usen la misma zona.
 */
const ZONA_HORARIA_DEFAULT = 'America/Mexico_City';

function zonaDelHotel(hotel) {
    return hotel?.zona_horaria || ZONA_HORARIA_DEFAULT;
}

/** 'YYYY-MM-DD' en la zona dada. */
function fechaLocal(fecha, zona = ZONA_HORARIA_DEFAULT) {
    return new Date(fecha).toLocaleDateString('en-CA', { timeZone: zona });
}

/** 'HH:MM' (00-23) en la zona dada. */
function horaLocal(fecha, zona = ZONA_HORARIA_DEFAULT) {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: zona, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(fecha));
}

/** Agrega fecha_local y hora_local a un objeto con fecha_checkin (no cambia lo demás). */
function conHoraLocal(fila, zona = ZONA_HORARIA_DEFAULT) {
    if (!fila?.fecha_checkin) return fila;
    return { ...fila, fecha_local: fechaLocal(fila.fecha_checkin, zona), hora_local: horaLocal(fila.fecha_checkin, zona) };
}

module.exports = { ZONA_HORARIA_DEFAULT, zonaDelHotel, fechaLocal, horaLocal, conHoraLocal };
