/**
 * Uso: node src/scripts/registrar-usuario.js <hotel_id> "<nombre>" <email> <password> [rol]
 * rol por defecto: recepcionista
 */

require('dotenv').config();
const bcrypt = require('bcrypt');
const { pool, withAdminContext } = require('../db');

const [, , hotel_id, nombre, email, password, rol = 'recepcionista'] = process.argv;

const USUARIO = { hotel_id: Number.parseInt(hotel_id), nombre, email, password, rol };

if (!USUARIO.hotel_id || !USUARIO.nombre || !USUARIO.email || !USUARIO.password) {
    console.error(
        '\n❌ Uso: node src/scripts/registrar-usuario.js <hotel_id> "<nombre>" <email> <password> [rol]\n' +
        '   rol por defecto: recepcionista (o pasa "gerente")\n'
    );
    process.exit(1);
}

async function registrar() {
    try {
        const hash = await bcrypt.hash(USUARIO.password, 12);

        // usuarios tiene RLS forzado — insertar/actualizar cualquier hotel_id
        // requiere el contexto admin, igual que POST /auth/usuarios.
        const result = await withAdminContext((client) => client.query(
            `INSERT INTO usuarios (hotel_id, nombre, email, password_hash, rol)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET
         nombre        = $2,
         password_hash = $4,
         activo        = TRUE
       RETURNING id, nombre, email, rol`,
            [USUARIO.hotel_id, USUARIO.nombre, USUARIO.email, hash, USUARIO.rol]
        ));

        const u = result.rows[0];
        console.log('\n✅ Usuario registrado:');
        console.log(`   ID:       ${u.id}`);
        console.log(`   Nombre:   ${u.nombre}`);
        console.log(`   Email:    ${u.email}`);
        console.log(`   Rol:      ${u.rol}`);
        console.log(`   Password: ${USUARIO.password}`);
        console.log('\n');

    } catch (err) {
        console.error('❌ Error:', err.message);
    } finally {
        await pool.end();
    }
}

registrar();