require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
});

// ── Edita estos datos ─────────────────────────────────────
const USUARIO = {
    hotel_id: 1,
    nombre: 'Recepcionista Hotel Isabel',
    email: 'recepcion@hotelisabel.mx',
    password: 'HotelIsabel2026!',
    rol: 'recepcionista',
};
// ─────────────────────────────────────────────────────────

async function registrar() {
    const client = await pool.connect();
    try {
        const hash = await bcrypt.hash(USUARIO.password, 12);

        const result = await client.query(
            `INSERT INTO usuarios (hotel_id, nombre, email, password_hash, rol)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET
         nombre        = $2,
         password_hash = $4,
         activo        = TRUE
       RETURNING id, nombre, email, rol`,
            [USUARIO.hotel_id, USUARIO.nombre, USUARIO.email, hash, USUARIO.rol]
        );

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
        client.release();
        pool.end();
    }
}

registrar();