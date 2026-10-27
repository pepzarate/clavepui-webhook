/**
 * Llena el hotel de prueba con datos FICTICIOS para probar y diseñar la
 * interfaz: check-ins de los últimos días, huéspedes frecuentes, folios, una
 * CURP duplicada hoy, estados PUI variados y (con --con-alertas) reportes de
 * búsqueda inventados. Nombres inventados; CURP generadas con estructura y
 * dígito verificador válidos, pero sin relación con personas reales.
 *
 * Idempotente: antes de insertar borra los datos que ya tuviera el hotel de
 * prueba (solo ese hotel, y solo si tiene es_prueba = TRUE). Los check-ins se
 * insertan directo en la BD: no se encolan ni van a la PUI.
 *
 * Alertas (tarea 6), con --alertas=<escenario>:
 *   sin-reportes          ningún reporte de búsqueda
 *   sin-coincidencia      2 reportes activos que no coinciden + 2 cerrados
 *   enviado | pendiente | error | rechazado | multiple
 *                         una coincidencia con el aviso en ese estado
 *                         (+ 1 reporte sin coincidencia y 2 cerrados)
 *   todas                 una coincidencia por cada estado del aviso, 1
 *                         reporte sin coincidencia, 1 con el aviso de fin de
 *                         búsqueda en error y 2 cerrados
 * --con-alertas equivale a --alertas=todas. Los avisos se escriben directo
 * en pui_notificaciones: nunca se llama al API del gobierno.
 *
 * --enlace-simulado marca el hotel con enlace_simulado = TRUE (sin él, lo
 * deja en FALSE): el backend lo muestra como enlazado SOLO fuera de
 * producción, sin ninguna clave real (ver utils/estadoPui.js). Sin enlace,
 * Alertas muestra "Hotel aún no enlazado".
 *
 * Local:       node src/scripts/datos-hotel-prueba.js [--alertas=todas] [--enlace-simulado] [--dias=7]
 * Producción:  railway run -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" node src/scripts/datos-hotel-prueba.js'
 */
const { conectar, buscarHotelPrueba, conContextoDelHotel } = require('./lib/hotelPrueba');
const { borrarDatos } = require('./borrar-datos-hotel-prueba');

const ZONA = 'America/Mexico_City';
const ESCENARIOS_ALERTAS = ['sin-reportes', 'sin-coincidencia', 'enviado', 'pendiente', 'error', 'rechazado', 'multiple', 'todas'];
const ESCENARIO = process.argv.includes('--con-alertas')
    ? 'todas'
    : (process.argv.find((a) => a.startsWith('--alertas=')) || '').split('=')[1] || null;
const ENLACE_SIMULADO = process.argv.includes('--enlace-simulado');

// Estado del aviso en la pantalla → cómo lo deja el backend en pui_notificaciones y check_ins
const AVISOS = {
    enviado: { estado: 'enviada', http: 200, intentos: 1, estadoPui: 'enviado', fase: 3 },
    pendiente: { estado: 'enviando', http: null, intentos: 0, estadoPui: 'pendiente', fase: 3 },
    error: { estado: 'error', http: 503, intentos: 3, estadoPui: 'error', fase: 3 },
    rechazado: { estado: 'rechazada', http: 400, intentos: 1, estadoPui: 'error', fase: 3 },
    multiple: { estado: 'multiple', http: 300, intentos: 1, estadoPui: 'enviado', fase: 2 },
};
const REGISTRADORES = ['Recepción Prueba', 'Turno Noche Prueba', 'Gerencia Prueba'];
const DIAS = Number.parseInt((process.argv.find((a) => a.startsWith('--dias=')) || '--dias=7').split('=')[1], 10);

// Generador reproducible (siempre los mismos datos)
let semilla = 20261022;
const azar = () => ((semilla = (semilla * 1103515245 + 12345) % 2147483648) / 2147483648);
const elegir = (lista) => lista[Math.floor(azar() * lista.length)];

// Nombres y apellidos inventados para combinar (ninguna persona en particular)
const NOMBRES_H = ['JULIO', 'ARMANDO', 'RODRIGO', 'EMILIO', 'TADEO', 'OSVALDO', 'LEANDRO', 'BRUNO'];
const NOMBRES_M = ['RENATA', 'XIMENA', 'DAFNE', 'ABRIL', 'NAYELI', 'LORENA', 'IRENE', 'SOFIA'];
const APELLIDOS = ['ROBLEDO', 'QUINTERO', 'BALDERAS', 'VILLARREAL', 'OCAMPO', 'ZAMUDIO', 'ARREOLA', 'PEDRAZA', 'LANDEROS', 'MONTIEL', 'ESCOBEDO', 'TREVIÑO'];
const ENTIDADES = ['DF', 'JC', 'NL', 'PL', 'GT', 'QR', 'SR', 'BC', 'YN', 'MC'];
const HABITACIONES = ['101', '102', '108', '112', '204', '205', '210', '305', '312', '401'];
const DIC = '0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ';
const VOCALES = 'AEIOU';

const primeraVocalInterna = (s) => [...s.slice(1)].find((c) => VOCALES.includes(c)) || 'X';
const primeraConsonanteInterna = (s) => [...s.slice(1)].find((c) => /[B-DF-HJ-NP-TV-Z]/.test(c)) || 'X';
const limpia = (s) => s.replace(/Ñ/g, 'X');

/** CURP con estructura y verificador válidos a partir de datos inventados. */
function curpDe({ nombre, paterno, materno, nacimiento, sexo, entidad }) {
    const p = limpia(paterno), m = limpia(materno), n = limpia(nombre.split(' ')[0]);
    const [a, mes, d] = nacimiento.split('-');
    const homoclave = Number(a) < 2000 ? String(Math.floor(azar() * 10)) : 'A';
    const base = p[0] + primeraVocalInterna(p) + m[0] + n[0] + a.slice(2) + mes + d + sexo + entidad
        + primeraConsonanteInterna(p) + primeraConsonanteInterna(m) + primeraConsonanteInterna(n) + homoclave;
    let suma = 0;
    for (let i = 0; i < 17; i++) suma += DIC.indexOf(base[i]) * (18 - i);
    return base + ((10 - (suma % 10)) % 10);
}

function personaInventada() {
    const sexo = azar() < 0.5 ? 'H' : 'M';
    const nombre = elegir(sexo === 'H' ? NOMBRES_H : NOMBRES_M);
    const paterno = elegir(APELLIDOS);
    let materno = elegir(APELLIDOS);
    if (materno === paterno) materno = elegir(APELLIDOS);
    const anio = 1960 + Math.floor(azar() * 45);
    const nacimiento = `${anio}-${String(1 + Math.floor(azar() * 12)).padStart(2, '0')}-${String(1 + Math.floor(azar() * 28)).padStart(2, '0')}`;
    const entidad = elegir(ENTIDADES);
    const sexoAsignado = sexo;
    return { nombre, paterno, materno, nacimiento, sexo, entidad, sexoAsignado, curp: curpDe({ nombre, paterno, materno, nacimiento, sexo, entidad }) };
}

/** Reporte de búsqueda inventado. El worker ignora hoteles de prueba: nunca se notifica nada. */
async function insertarReporte(db, hotel, id, p, { activo = true, dias = 1, busqueda = 'finalizada', cerradoHaceDias = null }) {
    await db.query(
        `INSERT INTO reportes_activos (id, curp, nombre, primer_apellido, segundo_apellido, fecha_nacimiento,
            lugar_nacimiento, sexo_asignado, hotel_id, activo, raw_payload, recibido_en, busqueda_estado, desactivado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{"prueba": true}', NOW() - make_interval(days => $11), $12,
                 CASE WHEN $13::int IS NULL THEN NULL ELSE NOW() - make_interval(days => $13::int) END)`,
        [id, p.curp, p.nombre, p.paterno, p.materno, p.nacimiento, p.entidad, p.sexoAsignado, hotel.id, activo, dias,
            busqueda, cerradoHaceDias]
    );
}

/** Check-in de hoy de la persona p con un aviso en el estado dado (como lo dejaría el backend). */
async function insertarCoincidencia(db, hotel, reporteId, p, aviso, { habitacion, minuto, registradoPor }) {
    const a = AVISOS[aviso];
    const ci = await db.query(
        `INSERT INTO check_ins (hotel_id, curp, nombre, primer_apellido, segundo_apellido, fecha_nacimiento,
            lugar_nacimiento, sexo_asignado, numero_habitacion, estado_pui, intentos_pui, registrado_por,
            encolado_pui, metodo_captura, fecha_checkin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE,'ocr',
                 (date_trunc('day', NOW() AT TIME ZONE '${ZONA}') + make_interval(mins => $13)) AT TIME ZONE '${ZONA}')
         RETURNING id, fecha_checkin`,
        [hotel.id, p.curp, p.nombre, p.paterno, p.materno, p.nacimiento, p.entidad, p.sexoAsignado, habitacion,
            a.estadoPui, a.intentos, registradoPor, minuto]
    );
    const { id, fecha_checkin: fecha } = ci.rows[0];
    await db.query(
        `INSERT INTO pui_notificaciones (hotel_id, reporte_id, fase, check_in_id, huella, estado, http_status,
            intentos, ultimo_error, creado_en, actualizado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, $10::timestamptz + interval '1 minute', $10::timestamptz + interval '1 minute')`,
        [hotel.id, reporteId, a.fase, id, a.fase === 3 ? `prueba-${id}` : '', a.estado, a.http, a.intentos,
            a.estado === 'error' ? 'Error de prueba (ficticio)' : null, fecha]
    );
}

/** Reportes y avisos del escenario de Alertas elegido. Devuelve cuántos reportes insertó. */
async function cargarAlertas(db, hotel, escenario) {
    if (escenario === 'sin-reportes') return 0;
    const id = (n) => `PRUEBA-${hotel.id}-${n}`;
    let n = 0;
    // Siempre: un reporte activo sin coincidencia (CURP que no está en el hotel) y dos cerrados
    await insertarReporte(db, hotel, id(++n), personaInventada(), { dias: 6 });
    if (escenario === 'sin-coincidencia') await insertarReporte(db, hotel, id(++n), personaInventada(), { dias: 2 });
    await insertarReporte(db, hotel, id(++n), personaInventada(), { activo: false, dias: 20, cerradoHaceDias: 12 });
    await insertarReporte(db, hotel, id(++n), personaInventada(), { activo: false, dias: 40, cerradoHaceDias: null });
    if (escenario === 'sin-coincidencia') return n;

    const avisos = escenario === 'todas' ? Object.keys(AVISOS) : [escenario];
    const habitaciones = ['305', '210', '108', '401', '204'];
    for (const [i, aviso] of avisos.entries()) {
        const p = personaInventada();
        const reporte = id(++n);
        await insertarReporte(db, hotel, reporte, p, { dias: 1 + i });
        await insertarCoincidencia(db, hotel, reporte, p, aviso, {
            habitacion: habitaciones[i % habitaciones.length],
            minuto: 7 * 60 + 15 * i, // de 07:00 en adelante, antes de los demás check-ins
            registradoPor: REGISTRADORES[i % REGISTRADORES.length],
        });
    }
    if (escenario === 'todas') {
        // Reporte sin coincidencia cuyo aviso de fin de búsqueda falló (cuenta en el contador)
        await insertarReporte(db, hotel, id(++n), personaInventada(), { dias: 3, busqueda: 'error' });
    }
    return n;
}

async function main() {
    if (ESCENARIO && !ESCENARIOS_ALERTAS.includes(ESCENARIO)) {
        throw new Error(`Escenario de alertas desconocido: ${ESCENARIO} (opciones: ${ESCENARIOS_ALERTAS.join(', ')})`);
    }
    const db = conectar();
    await db.connect();
    try {
        const hotel = await buscarHotelPrueba(db);
        if (!hotel) throw new Error('No existe el hotel de prueba: corre antes crear-hotel-prueba.js');

        // hoteles no tiene RLS; el WHERE es_prueba es la salvaguarda
        await db.query(`UPDATE hoteles SET enlace_simulado = $2 WHERE id = $1 AND es_prueba = TRUE`, [hotel.id, ENLACE_SIMULADO]);
        if (ENLACE_SIMULADO && process.env.NODE_ENV === 'production') {
            console.log('Aviso: en producción el backend ignora enlace_simulado (el hotel se sigue viendo sin enlace).');
        }

        await conContextoDelHotel(db, hotel.id, async () => {
            const borrados = await borrarDatos(db, hotel.id);
            console.log('Datos anteriores borrados:', borrados);

            const personas = Array.from({ length: 14 }, personaInventada);
            const frecuentes = personas.slice(0, 8);
            let total = 0;
            let folio = 1040;

            // Check-ins de los últimos DIAS días (incluido hoy), hora local del hotel
            for (let dia = DIAS - 1; dia >= 0; dia--) {
                const cuantos = dia === 0 ? 5 : 2 + Math.floor(azar() * 4);
                for (let k = 0; k < cuantos; k++) {
                    const p = k < 2 ? elegir(frecuentes) : elegir(personas);
                    const minuto = 8 * 60 + Math.floor(azar() * 13 * 60); // 08:00 a 21:00
                    const estado = dia === 0 && k === 3 ? 'error' : dia === 0 && k === 4 ? 'pendiente' : azar() < 0.15 ? 'enviado' : 'sin_reporte';
                    const conFolio = azar() < 0.4;
                    await db.query(
                        `INSERT INTO check_ins
                           (hotel_id, curp, nombre, primer_apellido, segundo_apellido, fecha_nacimiento, lugar_nacimiento,
                            sexo_asignado, numero_habitacion, folio_pms, estado_pui, intentos_pui, ultimo_error,
                            registrado_por, encolado_pui, metodo_captura, editado_tras_escaneo, fecha_checkin)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Datos de prueba',TRUE,$14,$15,
                                 (date_trunc('day', NOW() AT TIME ZONE '${ZONA}') - make_interval(days => $16) + make_interval(mins => $17)) AT TIME ZONE '${ZONA}')`,
                        [hotel.id, p.curp, p.nombre, p.paterno, p.materno, p.nacimiento, p.entidad, p.sexoAsignado,
                            elegir(HABITACIONES), conFolio ? `PRB-${folio++}` : null, estado, estado === 'error' ? 3 : 0,
                            estado === 'error' ? 'Error de prueba (ficticio)' : null,
                            elegir(['ocr', 'qr', 'lector', 'manual', 'frecuente']), azar() < 0.2, dia, minuto]
                    );
                    total++;
                }
            }

            // CURP duplicada hoy: la misma persona en dos habitaciones
            const dup = frecuentes[0];
            for (const [hab, minuto] of [['112', 9 * 60 + 5], ['305', 9 * 60 + 40]]) {
                await db.query(
                    `INSERT INTO check_ins (hotel_id, curp, nombre, primer_apellido, segundo_apellido, numero_habitacion,
                        estado_pui, registrado_por, encolado_pui, metodo_captura, fecha_checkin)
                     VALUES ($1,$2,$3,$4,$5,$6,'sin_reporte','Datos de prueba',TRUE,'manual',
                             (date_trunc('day', NOW() AT TIME ZONE '${ZONA}') + make_interval(mins => $7)) AT TIME ZONE '${ZONA}')`,
                    [hotel.id, dup.curp, dup.nombre, dup.paterno, dup.materno, hab, minuto]
                );
                total++;
            }

            // Una edición de folio auditada (para el historial)
            const ultimo = await db.query(`SELECT id, folio_pms FROM check_ins WHERE hotel_id = $1 ORDER BY fecha_checkin DESC LIMIT 1`, [hotel.id]);
            await db.query(`UPDATE check_ins SET folio_pms = $2 WHERE id = $1`, [ultimo.rows[0].id, `PRB-${folio}`]);
            await db.query(
                `INSERT INTO check_ins_ediciones (check_in_id, hotel_id, campo, valor_anterior, valor_nuevo, editado_por)
                 VALUES ($1, $2, 'folio_pms', $3, $4, 'Recepción Prueba')`,
                [ultimo.rows[0].id, hotel.id, ultimo.rows[0].folio_pms, `PRB-${folio}`]
            );

            // Huéspedes frecuentes (como los deja POST /check-ins)
            for (const p of frecuentes) {
                await db.query(
                    `INSERT INTO huespedes_frecuentes (hotel_id, curp, nombre, primer_apellido, segundo_apellido,
                        fecha_nacimiento, lugar_nacimiento, sexo_asignado, veces_hospedado, primera_visita, ultima_visita)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW() - interval '200 days', NOW() - make_interval(days => $10))
                     ON CONFLICT (hotel_id, curp) DO NOTHING`,
                    [hotel.id, p.curp, p.nombre, p.paterno, p.materno, p.nacimiento, p.entidad, p.sexoAsignado,
                        2 + Math.floor(azar() * 6), Math.floor(azar() * DIAS)]
                );
            }

            const alertas = ESCENARIO ? await cargarAlertas(db, hotel, ESCENARIO) : 0;
            console.log(`Insertados: ${total} check-ins (${DIAS} días), ${frecuentes.length} huéspedes frecuentes, 1 edición, ${alertas} reportes de búsqueda`
                + `${ESCENARIO ? ` (escenario ${ESCENARIO})` : ''}; enlace simulado: ${ENLACE_SIMULADO ? 'sí' : 'no'}.`);
        });
    } finally {
        await db.end();
    }
}

main().catch((err) => {
    console.error('ERROR:', err.message);
    process.exit(1);
});
