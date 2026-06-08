/**
 * Pruebas manuales de todos los endpoints.
 * Ejecutar con: npm test
 * Requiere que el servidor esté corriendo (npm run dev)
 */

const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';
let token = null;

const log = (label, status, body) => {
    const icon = status >= 200 && status < 300 ? '✅' : '❌';
    console.log(`\n${icon} ${label}`);
    console.log(`   Status: ${status}`);
    console.log(`   Body:   ${JSON.stringify(body)}`);
};

async function post(path, body, authToken = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    let data;
    try { data = await res.json(); } catch { data = {}; }
    return { status: res.status, body: data };
}

async function get(path) {
    const res = await fetch(`${BASE_URL}${path}`);
    let data;
    try { data = await res.json(); } catch { data = {}; }
    return { status: res.status, body: data };
}

async function runTests() {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`ClavePUI — Pruebas de endpoints`);
    console.log(`Base URL: ${BASE_URL}`);
    console.log('─'.repeat(50));

    // Health check
    const health = await get('/health');
    log('GET /health', health.status, health.body);

    // Login exitoso
    const loginOk = await post('/login', {
        usuario: 'PUI',
        clave: process.env.PUI_CLAVE || 'ClavePUI2026!Seg',
    });
    log('POST /login — credenciales correctas (debe dar 200)',
        loginOk.status, loginOk.body);
    if (loginOk.body.token) {
        token = loginOk.body.token;
        console.log(`   Token: ${token.substring(0, 40)}...`);
    }

    // Login con clave incorrecta
    const loginFail = await post('/login', {
        usuario: 'PUI',
        clave: 'claveIncorrecta',
    });
    log('POST /login — clave incorrecta (debe dar 401)',
        loginFail.status, loginFail.body);

    // Login con usuario incorrecto
    const loginWrongUser = await post('/login', {
        usuario: 'OTRO',
        clave: 'ClavePUI2026!Seg',
    });
    log('POST /login — usuario != PUI (debe dar 401)',
        loginWrongUser.status, loginWrongUser.body);

    if (!token) {
        console.log('\n⚠️  Sin token, saltando pruebas autenticadas');
        return;
    }

    // Prueba de webhook (la que usa el portal del gobierno)
    const prueba = await post('/activar-reporte-prueba', {
        id: 'A1B2C3D4E5F6-550e8400-e29b-41d4-a716-446655440000',
        curp: 'TEST010101HDFABC01',
        nombre: 'JUAN',
        primer_apellido: 'PEREZ',
        segundo_apellido: 'LOPEZ',
        fecha_nacimiento: '1990-01-01',
        fecha_desaparicion: '2024-12-15',
        lugar_nacimiento: 'CDMX',
        sexo_asignado: 'H',
    }, token);
    log('POST /activar-reporte-prueba (debe dar 200)',
        prueba.status, prueba.body);

    // Activar reporte real
    const activar = await post('/activar-reporte', {
        id: 'TEST0001-9f4e-4a99-91a2-6d4a8a1eaf3d-550e8400-e29b-0001',
        curp: 'GOCJ900115HDFNRL08',
        nombre: 'CARLOS',
        primer_apellido: 'GONZALEZ',
        lugar_nacimiento: 'CDMX',
        sexo_asignado: 'H',
    }, token);
    log('POST /activar-reporte (debe dar 200)',
        activar.status, activar.body);

    // Activar sin token
    const sinToken = await post('/activar-reporte', {
        id: 'TEST0002-9f4e-4a99-91a2-6d4a8a1eaf3d-550e8400-e29b-0002',
        curp: 'TEST010101HDFABC01',
    });
    log('POST /activar-reporte — sin token (debe dar 401)',
        sinToken.status, sinToken.body);

    // Activar con CURP inválida
    const curpInvalida = await post('/activar-reporte', {
        id: 'TEST0003-9f4e-4a99-91a2-6d4a8a1eaf3d-550e8400-e29b-0003',
        curp: 'INVALIDA',
    }, token);
    log('POST /activar-reporte — CURP inválida (debe dar 400)',
        curpInvalida.status, curpInvalida.body);

    // Desactivar reporte
    const desactivar = await post('/desactivar-reporte', {
        id: 'TEST0001-9f4e-4a99-91a2-6d4a8a1eaf3d-550e8400-e29b-0001',
    }, token);
    log('POST /desactivar-reporte (debe dar 200)',
        desactivar.status, desactivar.body);

    // Método no permitido
    const metodoBloqueado = await get('/activar-reporte');
    log('GET /activar-reporte — método bloqueado (debe dar 405)',
        metodoBloqueado.status, metodoBloqueado.body);

    console.log('\n' + '─'.repeat(50));
    console.log('Pruebas completadas');
    console.log('─'.repeat(50) + '\n');
}

runTests().catch(err => {
    console.error('Error en pruebas:', err.message);
    process.exit(1);
});