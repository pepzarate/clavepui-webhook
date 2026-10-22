/**
 * Cuenta (sin mostrarlas) las líneas del log de solicitudes que traen datos
 * personales SIN enmascarar. Hasta la tarea 2b (commit 3acfe11, 2026-10-19)
 * el auditLogger registraba completos nombre, apellidos, teléfono y correo
 * del body, y la URL completa (curp= de /check-ins/curp-activa y
 * /huespedes/buscar, nombre= de /huespedes/buscar-por-nombre).
 *
 * Ese log NO está en la base de datos (la tabla logs_auditoria no la llena
 * nadie): es la salida estándar del servicio, guardada por Railway.
 *
 * Lee de la entrada estándar las líneas JSON de `railway logs --json` y solo
 * imprime conteos y el rango de fechas. Ejemplo (desde clavepui-webhook/):
 *   railway deployment list                       # ids y fechas de los despliegues
 *   railway logs <DEPLOYMENT_ID> --json --lines 100000 --filter "Solicitud" | node src/scripts/contar-logs-personales.js
 */
const readline = require('node:readline');

const CAMPOS = ['nombre', 'primer_apellido', 'segundo_apellido', 'telefono', 'correo'];
const conteo = { lineas: 0, solicitudes: 0, con_datos_personales: 0, url_curp: 0, url_nombre: 0 };
for (const c of CAMPOS) conteo[`body_${c}`] = 0;
let primera = null;
let ultima = null;

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (linea) => {
    conteo.lineas++;
    let texto = linea;
    let fecha = null;
    try {
        const j = JSON.parse(linea);
        texto = String(j.message ?? '');
        fecha = j.timestamp ?? null;
    } catch {
        // Línea que no es JSON: se revisa tal cual
    }
    if (!texto.includes('"type":"request"')) return;
    conteo.solicitudes++;
    let tiene = false;
    for (const c of CAMPOS) {
        // "campo":"valor" con valor distinto de *** y de vacío
        if (new RegExp(`"${c}":"(?!\\*\\*\\*")[^"]+"`).test(texto)) {
            conteo[`body_${c}`]++;
            tiene = true;
        }
    }
    if (/[?&]curp=[A-Za-z0-9]{18}/.test(texto)) { conteo.url_curp++; tiene = true; }
    if (/[?&]nombre=(?!\*\*\*)[^&"\s]+/.test(texto)) { conteo.url_nombre++; tiene = true; }
    if (tiene) {
        conteo.con_datos_personales++;
        if (fecha) {
            primera = primera && primera < fecha ? primera : fecha;
            ultima = ultima && ultima > fecha ? ultima : fecha;
        }
    }
});
rl.on('close', () => {
    console.log(JSON.stringify({ ...conteo, primera_con_datos: primera, ultima_con_datos: ultima }, null, 2));
});
