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
 * Local:       node src/scripts/datos-hotel-prueba.js [--con-alertas] [--dias=7]
 * Producción:  railway run -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" node src/scripts/datos-hotel-prueba.js'
 */
const { conectar, buscarHotelPrueba, conContextoDelHotel } = require('./lib/hotelPrueba');
const { borrarDatos } = require('./borrar-datos-hotel-prueba');

const ZONA = 'America/Mexico_City';
const CON_ALERTAS = process.argv.includes('--con-alertas');
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

async function main() {
    const db = conectar();
    await db.connect();
    try {
        const hotel = await buscarHotelPrueba(db);
        if (!hotel) throw new Error('No existe el hotel de prueba: corre antes crear-hotel-prueba.js');

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

            // Reportes de búsqueda inventados (para ver Alertas con datos). El
            // worker ignora hoteles de prueba, así que nunca se notifica nada.
            let alertas = 0;
            if (CON_ALERTAS) {
                const coincide = personas[1];
                const otra = personaInventada();
                for (const [i, p, activo] of [[1, coincide, true], [2, otra, true], [3, personaInventada(), false]]) {
                    await db.query(
                        `INSERT INTO reportes_activos (id, curp, nombre, primer_apellido, segundo_apellido, fecha_nacimiento,
                            lugar_nacimiento, sexo_asignado, hotel_id, activo, raw_payload, recibido_en)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{"prueba": true}', NOW() - make_interval(days => $11))`,
                        [`PRUEBA-${hotel.id}-${i}`, p.curp, p.nombre, p.paterno, p.materno, p.nacimiento, p.entidad,
                            p.sexoAsignado, hotel.id, activo, i]
                    );
                    alertas++;
                }
            }
            console.log(`Insertados: ${total} check-ins (${DIAS} días), ${frecuentes.length} huéspedes frecuentes, 1 edición, ${alertas} reportes de búsqueda.`);
        });
    } finally {
        await db.end();
    }
}

main().catch((err) => {
    console.error('ERROR:', err.message);
    process.exit(1);
});
