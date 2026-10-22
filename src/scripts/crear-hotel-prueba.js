/**
 * Crea (o deja al día) el hotel de prueba "HOTEL PRUEBA CLAVEPUI" con un
 * usuario recepcionista y uno gerente. Idempotente: se puede correr varias
 * veces; siempre deja es_prueba = TRUE, checkin_v2 = TRUE y gov_pui_clave =
 * NULL (así nunca llega nada a la PUI; ver hoteles.es_prueba en db/index.js).
 *
 * Variables (las contraseñas NUNCA en la línea de comandos):
 *   PRUEBA_PASS_RECEPCION, PRUEBA_PASS_GERENTE  — obligatorias al crear un
 *       usuario; si el usuario ya existe y vienen, se le cambia la contraseña.
 *       Mínimo 12 caracteres.
 *   PRUEBA_EMAIL_RECEPCION  (default recepcion.prueba@clavepui.com)
 *   PRUEBA_EMAIL_GERENTE    (default gerente.prueba@clavepui.com)
 *
 * Local:       node src/scripts/crear-hotel-prueba.js
 * Producción:  railway run -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" node src/scripts/crear-hotel-prueba.js'
 */
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { HOTEL_PRUEBA, conectar, buscarHotelPrueba, conContextoDelHotel } = require('./lib/hotelPrueba');

const USUARIOS = [
    {
        rol: 'recepcionista',
        nombre: 'Recepción Prueba',
        email: (process.env.PRUEBA_EMAIL_RECEPCION || 'recepcion.prueba@clavepui.com').toLowerCase().trim(),
        password: process.env.PRUEBA_PASS_RECEPCION || '',
    },
    {
        rol: 'gerente',
        nombre: 'Gerencia Prueba',
        email: (process.env.PRUEBA_EMAIL_GERENTE || 'gerente.prueba@clavepui.com').toLowerCase().trim(),
        password: process.env.PRUEBA_PASS_GERENTE || '',
    },
];

async function main() {
    for (const u of USUARIOS) {
        if (u.password && u.password.length < 12) throw new Error(`La contraseña de ${u.rol} debe tener al menos 12 caracteres.`);
    }
    const db = conectar();
    await db.connect();
    try {
        let hotel = await buscarHotelPrueba(db);
        if (!hotel) {
            // pui_clave aleatoria: el login de staff la entrega al navegador; no
            // hace falta conocerla. No se imprime.
            const r = await db.query(
                `INSERT INTO hoteles (nombre, rfc, pui_clave, activo, es_prueba, checkin_v2, gov_pui_clave)
                 VALUES ($1, $2, $3, TRUE, TRUE, TRUE, NULL)
                 RETURNING id`,
                [HOTEL_PRUEBA.nombre, HOTEL_PRUEBA.rfc, `prueba-${crypto.randomBytes(24).toString('hex')}`]
            );
            console.log(`Hotel de prueba creado (id ${r.rows[0].id}).`);
        } else {
            await db.query(
                `UPDATE hoteles SET nombre = $2, activo = TRUE, es_prueba = TRUE, checkin_v2 = TRUE, gov_pui_clave = NULL
                 WHERE id = $1`,
                [hotel.id, HOTEL_PRUEBA.nombre]
            );
            console.log(`Hotel de prueba ya existía (id ${hotel.id}); marcas verificadas.`);
        }
        hotel = await buscarHotelPrueba(db);

        await conContextoDelHotel(db, hotel.id, async () => {
            for (const u of USUARIOS) {
                const existe = await db.query(`SELECT id, rol FROM usuarios WHERE email = $1 AND hotel_id = $2`, [u.email, hotel.id]);
                if (existe.rowCount > 0) {
                    if (u.password) {
                        await db.query(
                            `UPDATE usuarios SET password_hash = $1, rol = $2, activo = TRUE WHERE id = $3`,
                            [await bcrypt.hash(u.password, 12), u.rol, existe.rows[0].id]
                        );
                        console.log(`  ${u.rol}: ${u.email} (ya existía; contraseña actualizada)`);
                    } else {
                        console.log(`  ${u.rol}: ${u.email} (ya existía; contraseña sin cambios)`);
                    }
                    continue;
                }
                if (!u.password) throw new Error(`Falta la contraseña de ${u.rol} (variable PRUEBA_PASS_${u.rol === 'gerente' ? 'GERENTE' : 'RECEPCION'}).`);
                // ON CONFLICT DO NOTHING: si el correo ya es de un usuario de OTRO
                // hotel (invisible por RLS), no se toca y se avisa abajo.
                await db.query(
                    `INSERT INTO usuarios (hotel_id, nombre, email, password_hash, rol)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (email) DO NOTHING`,
                    [hotel.id, u.nombre, u.email, await bcrypt.hash(u.password, 12), u.rol]
                );
                const creado = await db.query(`SELECT id FROM usuarios WHERE email = $1 AND hotel_id = $2`, [u.email, hotel.id]);
                if (creado.rowCount === 0) throw new Error(`El correo ${u.email} ya pertenece a otro hotel. Usa otro (PRUEBA_EMAIL_*).`);
                console.log(`  ${u.rol}: ${u.email} (creado)`);
            }
        });

        const final = await buscarHotelPrueba(db);
        console.log('Estado:', {
            id: final.id,
            nombre: final.nombre,
            es_prueba: final.es_prueba,
            checkin_v2: final.checkin_v2,
            gov_pui_clave: final.tiene_gov_clave ? 'CONFIGURADA (revisar)' : 'sin configurar',
        });
    } finally {
        await db.end();
    }
}

main().catch((err) => {
    console.error('ERROR:', err.message);
    process.exit(1);
});
