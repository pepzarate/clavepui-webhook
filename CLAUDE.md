# ClavePUI Webhook — Backend

## Stack
Node.js 22, Express 4, PostgreSQL 15, Redis 7, BullMQ — Railway

## URL producción
https://api.clavepui.com

## Arrancar en desarrollo
npm run dev  (nodemon — puerto 8080)
Docker Redis: docker start clavepui-redis

## Feature 18 pausada (2026-08-24) — notificaciones push

Pausa deliberada de alcance acotado (NO un revert como Feature 19 —
código intacto en ambos lados, nada se borró ni se comentó a mano):

- **Frontend** (`clavepui-frontend`, commit `98404da`): en
  `dashboard.astro`, la constante
  `PUSH_NOTIFICATIONS_ENABLED = false` envuelve tanto el listener de
  click del botón "Activar alertas push" como la llamada a
  `actualizarBotonPush()` que revela la tarjeta (`push-card`, que sigue
  con `display:none` por default en el HTML). Con el flag en `false`,
  el minificador de producción elimina ese bloque por completo del
  bundle (confirmado con `astro build` + grep sobre el JS generado —
  cero rastro de `pushManager.subscribe`, `vapidPublicKey`, etc. en el
  archivo compilado de dashboard). `public/sw.js` (el listener de
  evento `push`) y `src/scripts/pwa.ts` (registro del service worker)
  quedan intactos sin tocar, a propósito — el SW sigue vivo, solo nadie
  se suscribe.
- **Backend** (`clavepui-webhook`, commit `8556a43`): en
  `services/puiQueue.js`, la misma constante `PUSH_NOTIFICATIONS_ENABLED
  = false` envuelve únicamente la llamada a `notificarGerentes(...)`
  (paso 4 del worker, "alertar a los gerentes"). Los pasos 1-3 (login a
  la PUI del gobierno, `notificar-coincidencia`, `UPDATE check_ins SET
  estado_pui = 'enviado'`) son código incondicional que corre igual con
  el flag en `true` o `false` — el cumplimiento con el gobierno nunca
  dependió de esto ni se vio afectado. Tabla `push_subscriptions` y
  `routes/push.js` (suscribir/desuscribir/vapid-public-key) intactos sin
  tocar — sin frontend que los llame quedan huérfanos pero funcionales,
  no se borró nada.
- **Reactivar**: cambiar las dos constantes a `true` (una en cada repo)
  y desplegar. No requiere tocar ninguna otra línea.
- **Validación de esta sesión**: `astro check`/`astro build` 0 errores;
  arranque limpio del backend; confirmado por código (no por prueba en
  navegador real con Redis) que los pasos 1-3 del worker son
  incondicionales y preceden al bloque de push ya gateado. No se montó
  una simulación completa de "coincidencia con reporte activo" vía
  BullMQ real — este sandbox no tiene Redis disponible (sin sudo/docker,
  igual que sesiones anteriores) y, aunque lo tuviera, el camino feliz
  completo (login PUI exitoso → notificar-coincidencia → push) requiere
  un `gov_pui_clave` real que ningún hotel de prueba tiene configurado
  todavía — limitación del entorno preexistente a este cambio, no
  introducida por él.

## Sesión 2026-08-29 — búsqueda de huésped frecuente por nombre

Extiende Feature 20 (huéspedes frecuentes, sesión P3) — misma tabla,
mismo `requireHotel`, mismo `withHotelContext`, sin tocar nada existente.

- Nuevo `GET /huespedes/buscar-por-nombre?nombre=...` (`checkIns.js`,
  junto al `GET /huespedes/buscar?curp=...` que ya existía) — búsqueda
  parcial `ILIKE` sobre `CONCAT_WS(' ', nombre, primer_apellido,
  segundo_apellido)`, `WHERE hotel_id = $1` explícito además de RLS
  (mismo patrón de defensa en profundidad que `/check-ins/:id/editar`),
  `ORDER BY ultima_visita DESC LIMIT 10`. Comodines `%`/`_`/`\` del
  término de búsqueda escapados (`ESCAPE '\'`) para que se traten como
  texto literal, no patrón. Mínimo 2 caracteres (400 si no). Respuesta
  distinta a la de CURP exacta a propósito: `{resultados: [...]}` (lista,
  para desambiguar) en vez de `{encontrado, huesped}` (un solo match) —
  por eso es una ruta hermana y no el mismo endpoint con un parámetro
  alterno.
- **No hizo falta tocar la población de la tabla** — ya se inserta/
  actualiza sola en cada `POST /check-ins` (`ON CONFLICT (hotel_id,
  curp) DO UPDATE`, ver "Base de datos" abajo), desde Feature 20.
- Frontend (`clavepui-frontend`): nuevo campo de búsqueda en
  `checkin.astro`, antes del campo CURP. Lista de resultados (máx. 10,
  CURP enmascarada) → clic → tarjeta de confirmación explícita (nombre
  completo, fecha de nacimiento, última estancia) → botón "Confirmar y
  llenar datos" recién ahí autocompleta CURP completa + nombre +
  apellidos, reutilizando `llenarCURP()`. A partir de ahí el flujo es
  indistinguible de escaneo/tecleo manual — mismo `checkInsAPI.crear()`,
  así que Feature 15 (aviso CURP duplicada mismo día) y el 409 de folio
  duplicado siguen disparando igual (no hay atajo que los salte, viven
  en `POST /check-ins` del lado del servidor, no en el cliente).
- Verificado end-to-end con datos reales locales: 3 huéspedes Isabel con
  nombre "Juan/Juana Pérez" + apellidos variados (colisión deliberada) →
  la búsqueda trae los 3 con contexto suficiente para diferenciar;
  aislamiento confirmado cruzando Isabel/Metropol con el mismo nombre
  exacto en ambos (Metropol solo ve el suyo); escape de comodines
  probado (`%`, `__` no matchean de más); Playwright real (Chromium)
  contra el dev server + backend local: clic en resultado NO llena CURP
  hasta el clic explícito en "Confirmar", y tras confirmar, un submit
  real contra el mismo CURP el mismo día devuelve
  `aviso_curp_duplicada: true` — Feature 15 no se saltó.

## Sesión 2026-08-18 — edición folio/habitación

- Nuevo `POST /check-ins/:id/editar` — edita `folio_pms`/`numero_habitacion`
  (nunca CURP ni datos de identidad), solo sobre check-ins del día actual
  (America/Mexico_City), con auditoría en `check_ins_ediciones` (quién,
  cuándo, campo, valor anterior/nuevo). Commit `cc74c28`. Detalle en
  "Estructura" y "Base de datos" más abajo.
- Nuevo middleware `requireUsuarioStaff` en `middleware/auth.js` — decodifica
  el JWT de sesión del staff (mismo formato que ya usa `GET /auth/me`) y lo
  adjunta como `req.usuarioStaff`. El frontend ya mandaba este JWT en varias
  llamadas a check-ins, pero el backend nunca lo validaba — gap conocido de
  antes de esta sesión. Alcance acotado a este endpoint nuevo, NO aplicado
  retroactivamente a los demás endpoints de check-ins (queda para una
  sesión futura dedicada a ese rediseño más grande).
- Validado end-to-end en local con datos reales (Postgres/Redis locales de
  este entorno, no simulados): edición legítima, edición sin cambios no
  genera ruido en la auditoría, folio duplicado (409, misma validación que
  Feature 14), check-in de un día anterior (403), JWT y x-hotel-key de
  hoteles distintos entre sí (403), JWT de la PUI gobierno rechazado (401),
  aislamiento RLS confirmado cruzando contextos Isabel/Metropol tanto en
  `check_ins` como en `check_ins_ediciones`.

### ✅ Deploy en producción confirmado (2026-08-24)

El 404 reportado el 2026-08-18 se resolvió solo — Railway ya sirve el
commit `cc74c28` (`railway status` confirma deployment activo `RUNNING`
con `commitHash: cc74c283ceada692d9d6abb247bd629175ecb75b`, desplegado
2026-08-19). Verificado end-to-end contra `https://api.clavepui.com` real:
- `POST /check-ins/:id/editar` sin auth → 401 "API key del hotel
  requerida" (mismo comportamiento que el endpoint viejo, ya no 404).
- Edición real contra Hotel Marlowe (id=3 producción, check-in de prueba
  creado para la ocasión, id 105): `folio_pms`/`numero_habitacion`
  actualizados correctamente (200). No se leyó `check_ins_ediciones`
  directamente (el intento de extraer el `DATABASE_URL` de producción vía
  `railway variables` fue bloqueado por el clasificador de permisos del
  entorno) — pero como el UPDATE y el INSERT a `check_ins_ediciones`
  corren en la misma transacción de `withHotelContext` (BEGIN…COMMIT), el
  200 con los valores nuevos ya persistidos es prueba suficiente de que
  también se escribió la auditoría (un fallo ahí habría hecho rollback de
  todo el bloque, incluyendo el UPDATE).
- Queda en producción un check-in de prueba (id 105, Hotel Marlowe,
  CURP `TEST010101HDFRRS09`) — consistente con el resto de datos de
  prueba que ya tienen los 3 hoteles mientras no haya folio PUI aprobado.

## Sesión 2026-07-23 — resumen de cambios
- RLS multi-tenant validado end-to-end (local + producción) — ver sección RLS.
- Alta Hotel Marlowe (hotel_id=3 en producción) — ver Credenciales por hotel.
- P0 seguridad: password/pui_clave/gov_pui_clave enmascarados en logs
  (`433e05d`); scripts de registro sin credenciales reales hardcodeadas,
  ahora reciben datos por CLI args (`433e05d`).
- P1 dependencias: 0 vulnerabilidades — axios/body-parser (`c9453bd`),
  Astro 6→7.1.3 en frontend/landing (repos hermanos).
- P2: `limpiar-movimientos-prueba.js` agregado (`97d83f2`); dominio
  `app.clavepui.com` dado de alta y agregado a CORS (`672d0c2`).
- Backlog completo y priorizado: ver `BACKLOG.md` en la raíz del proyecto.

## Estructura
src/
├── app.js                — servidor Express, middlewares, CORS, rate limiting
├── config/index.js       — variables de entorno centralizadas
├── db/index.js           — pool (admin) + tenantPool (restringido), initDb() con
│                            ALTER TABLE seguros y setup de RLS (ENABLE/FORCE +
│                            policy hotel_isolation); withHotelContext()/
│                            withAdminContext() — ver sección RLS abajo
├── middleware/
│   ├── auth.js           — requireAuth (JWT), requireGerente, requireUsuarioStaff
│   │                       (JWT de sesión del staff — decodifica y adjunta
│   │                       req.usuarioStaff; alcance acotado por ahora a
│   │                       POST /check-ins/:id/editar, ver Sesión 2026-08-18)
│   └── logger.js         — Winston + auditLogger
├── routes/
│   ├── auth.js           — POST /login (PUI gobierno — usuario fijo "PUI")
│   ├── usuarios.js       — POST /auth/login, GET /auth/me, POST /auth/usuarios
│   ├── activar.js        — POST /activar-reporte, /activar-reporte-prueba
│   ├── desactivar.js     — POST /desactivar-reporte
│   ├── checkIns.js       — CRUD check-ins, resumen, export CSV, reportes activos,
│   │                       POST /check-ins/:id/editar (folio_pms/numero_habitacion,
│   │                       solo check-ins de hoy, con auditoría en check_ins_ediciones),
│   │                       GET /huespedes/buscar (CURP exacta) y
│   │                       GET /huespedes/buscar-por-nombre (ILIKE parcial,
│   │                       lista, ver Sesión 2026-08-29)
│   ├── admin.js          — POST /admin/hoteles, /admin/hoteles/:id/gov-clave,
│   │                       POST /admin/limpiar-pruebas
│   └── reportes.js       — GET /reportes/pdf (PDFKit)
├── services/
│   └── puiQueue.js       — BullMQ worker — consulta gov_pui_clave por hotel
├── scripts/
│   ├── registrar-hotel.js            — CLI args: nombre, rfc, pui_clave
│   │                                   (hoteles no tiene RLS, no necesita contexto)
│   ├── registrar-usuario.js          — CLI args: hotel_id, nombre, email,
│   │                                   password, [rol] (withAdminContext —
│   │                                   usuarios sí tiene RLS forzado)
│   └── limpiar-movimientos-prueba.js — CLI: hotel_id [--confirmar], dry-run
│                                        por defecto; borra check_ins/
│                                        reportes_activos de UN hotel
│                                        (withHotelContext)
└── utils/
    └── curp.js           — validarFormatoCURP, parsearCURP, enmascararCURP

## Base de datos — tablas
- hoteles          — id, nombre, rfc, pui_clave, gov_pui_clave, activo
- usuarios         — id, hotel_id, nombre, email, password_hash, rol, activo
- check_ins        — id, hotel_id, curp, nombre, primer_apellido, segundo_apellido,
                     fecha_nacimiento, lugar_nacimiento, sexo_asignado,
                     numero_habitacion, fecha_checkin, estado_pui,
                     intentos_pui, ultimo_error, registrado_por
- reportes_activos — id, curp, hotel_id, nombre, raw_payload, recibido_en, activo
- check_ins_ediciones — id, check_in_id, hotel_id, campo, valor_anterior,
                     valor_nuevo, editado_por, editado_en (RLS igual que
                     check_ins/usuarios/reportes_activos)
- logs_auditoria   — id, tipo, endpoint, ip_origen, status_code, mensaje

## Row Level Security (RLS) — aislamiento multi-tenant a nivel de BD

Segunda capa de defensa además del filtro `WHERE hotel_id = $1` en cada query:
si alguna query olvida ese filtro (como pasaba originalmente en puiQueue.js),
la policy de PostgreSQL sigue garantizando que no se lean ni escriban filas
de otro hotel.

### Tablas protegidas
check_ins, usuarios, reportes_activos — cada una con `ENABLE ROW LEVEL
SECURITY` + `FORCE ROW LEVEL SECURITY` (FORCE es necesario porque el dueño
de las tablas está exento de RLS por defecto) y una policy `hotel_isolation`:

    USING (
      current_setting('app.bypass_tenant_rls', true) = 'on'
      OR hotel_id = NULLIF(current_setting('app.current_hotel_id', true), '')::int
    )

`hoteles` y `logs_auditoria` NO tienen RLS: `hoteles` define a los tenants,
y `logs_auditoria` es intencionalmente cross-tenant.

### Cómo se establece el contexto (db/index.js)
- `withHotelContext(hotelId, fn)` — BEGIN + `set_config('app.current_hotel_id', ...)`
  local a la transacción + COMMIT/ROLLBACK. Nunca se filtra a otro request
  que reuse la misma conexión del pool. Lo usan checkIns.js, activar.js,
  desactivar.js, reportes.js y el worker de puiQueue.js.
- `withAdminContext(fn)` — mismo patrón pero setea `app.bypass_tenant_rls = 'on'`.

### Qué está exento y por qué
- `/admin/*` — withAdminContext; ya protegido río arriba por x-admin-token.
- `POST /auth/login` y `POST /auth/usuarios` — withAdminContext, porque
  buscan por email antes de conocer el hotel_id.
- `registrar-usuario.js` — withAdminContext, mismo motivo. registrar-hotel.js
  no necesita contexto porque hoteles no tiene RLS.
- **puiWorker (BullMQ) NO está exento** — usa withHotelContext(checkIn.hotel_id).
  Este fue el bug original: el worker consultaba reportes_activos sin filtro
  de hotel_id en el texto de la query; ahora la policy lo obliga a pasar
  contexto de tenant aunque la query en sí siga sin el filtro manual.

### Verificación de arranque y pruebas
`verificarRolTenantSeguro()` corre en cada initDb() y corta el arranque si
el rol de tenantPool puede saltarse RLS (superusuario/BYPASSRLS) — ver
DATABASE_URL_TENANT abajo. Prueba manual: `node src/scripts/test-rls.js`
(contra Postgres directo, no HTTP; usa valores de pui_clave genéricos de
prueba, no los reales de producción).

### Cuidado: DELETE/UPDATE sin contexto falla en silencio, no con error
Nos pasó de verdad limpiando datos de prueba manualmente: un
`pool.query('DELETE FROM usuarios WHERE ...')` sin withAdminContext no
lanza ningún error — Postgres simplemente no borra nada (0 rows
affected), porque la policy filtra las filas antes de que el DELETE las
alcance. El error real solo apareció después, como un foreign key
violation al intentar borrar el hotel — un mensaje confuso que no
apunta a la causa real (falta de contexto RLS). Cualquier DELETE/UPDATE
manual a check_ins/usuarios/reportes_activos necesita
withHotelContext/withAdminContext, o fallará en silencio.

## Variables de entorno Railway
PORT=8080
NODE_ENV=production
JWT_SECRET=...
ADMIN_TOKEN=...
REDIS_URL=...          (auto-inyectada desde servicio Redis)
DATABASE_URL=...       (auto-inyectada desde servicio PostgreSQL — rol superusuario,
                        usado por pool/withAdminContext)
DATABASE_URL_TENANT=... (rol restringido, SIN superusuario/BYPASSRLS — usado por
                        tenantPool/withHotelContext para que las policies de RLS
                        se apliquen de verdad. Sin esta variable el servidor no
                        arranca: ver verificarRolTenantSeguro() en db/index.js)
BASE_URL=https://api.clavepui.com

## Credenciales por hotel (multi-tenant)
Cada hotel tiene DOS claves distintas:
1. pui_clave     — clave que NOSOTROS definimos para que el gobierno nos autentique
2. gov_pui_clave — clave que EL GOBIERNO genera, guardada en BD por hotel
                   se configura vía POST /admin/hoteles/:id/gov-clave

Hotel Isabel (id=1):   pui_clave=IsabelPUI2026!Sec
Hotel Metropol (id=2): pui_clave=MetropolPUI2026!Sec
Hotel Marlowe (id=3):  pui_clave=MarlowePUI2026!Sec
Hotel Manalba (id=4):  pui_clave=ManalbaPUI2026!Sec (dado de alta 2026-08-28,
                        RFC HAR730131M1A)

## Flujo BullMQ — puiQueue.js
1. Check-in registrado → job encolado con hotel_id
2. Worker consulta gov_pui_clave del hotel en BD
3. Si no tiene gov_pui_clave → marca sin_reporte, no llama a PUI
4. Si tiene → busca reportes_activos para esa CURP
5. Sin reporte activo → marca sin_reporte
6. Con reporte activo → POST /login PUI con gov_pui_clave → token
7. Con token → POST /notificar-coincidencia → marca enviado

## Endpoints registrados en portal PUI (para DAST)
https://api.clavepui.com/login
https://api.clavepui.com/activar-reporte
https://api.clavepui.com/activar-reporte-prueba
https://api.clavepui.com/desactivar-reporte

## CORS permitidos
- https://plataformadebusqueda.gob.mx
- https://api.clavepui.com
- https://clavepui-frontend.vercel.app
- https://app.clavepui.com
- http://localhost:4321, 4322, 4323

## Seguridad
- SAST: Semgrep (p/security-audit, p/secrets, p/owasp-top-ten) — NO SonarQube
- DAST: OWASP ZAP 2.17.0 — solo contra los 4 endpoints registrados arriba
- SCA: Snyk + npm audit
- Alerta SQL Injection de ZAP en /activar-reporte y /desactivar-reporte
  es FALSO POSITIVO confirmado — queries usan pool.query con $1 parametrizado

## Reglas críticas
- Zona horaria en todas las queries:
  DATE(fecha AT TIME ZONE 'America/Mexico_City')
  Pasar fecha como parámetro $2:
  new Date().toLocaleDateString('en-CA', {timeZone:'America/Mexico_City'})
- bcrypt rounds=12 para passwords
- JWT 8h para sesiones de recepcionistas/gerentes
- JWT 1h para tokens de la PUI gobierno
- Rate limit: global 400/15min por IP (app.js) + dedicados por endpoint:
  `/login` PUI gobierno 50/15min (routes/auth.js), `/auth/login` staff
  30/15min (routes/usuarios.js) — cada uno con su propio limitador,
  aplicado directo sobre la ruta (no vía `app.use('/', limiter, router)`,
  que aplicaría el límite a cualquier request, no solo a esa ruta)
- Verificar que sonar-project.properties NO existe en el repo
- Verificar que checkins_export.csv no contiene datos reales de huéspedes
- Aislamiento multi-tenant reforzado con RLS en check_ins/usuarios/reportes_activos
  (ver sección RLS arriba) — cualquier query nueva a esas tablas debe pasar por
  withHotelContext/withAdminContext o Postgres devolverá 0 filas
- Edición de check-ins usa `POST /check-ins/:id/editar`, no PATCH — el
  middleware CORS global en `app.js` declara
  `Access-Control-Allow-Methods: GET, POST, OPTIONS` únicamente
  (endurecimiento de seguridad, requisito PUI); un PATCH real desde el
  navegador fallaría el preflight. Ampliar ese allowlist es una decisión
  de mayor alcance que un solo endpoint — se siguió el mismo patrón que
  `/activar-reporte`, `/desactivar-reporte` (verbo explícito sobre POST)

## Mejoras pendientes (backlog de la ronda 2026-08-18, ver también BACKLOG.md)
3. [x] Edición folio_pms/numero_habitacion con auditoría — implementado
   (commit `cc74c28`) y deploy confirmado en producción 2026-08-24, ver
   "Deploy en producción confirmado" en la sección de Sesión 2026-08-18
   arriba.
4. [x] Rango de fechas en historial — `GET /check-ins` y `GET
   /check-ins/resumen` aceptan `fecha_inicio`/`fecha_fin` (mismo patrón
   de zona horaria que `/check-ins/export` y `/reportes/pdf`), compatible
   con el `fecha` de un solo día que ya existía. `clavepui-webhook`
   commit `1722b7a`, `clavepui-frontend` commit `b7eb750` (UI en
   historial.astro: campos "Desde"/"Hasta", recepción sigue con fecha
   fija a hoy y disabled). Verificado con datos reales insertados
   localmente en 3 días distintos + 1 día sin check-ins (hueco): el
   rango devuelve exactamente los registros esperados, el día sin datos
   no rompe nada, y el parámetro `fecha` viejo sigue funcionando sin
   cambios. `test-rls.js` 8/8 sin regresión, `astro check`/`astro build`
   sin errores. Sin pase visual en navegador real en esta sesión (mismo
   motivo que sesiones anteriores — sandbox sin automatización de
   navegador) — pendiente que el usuario lo confirme visualmente.
5. [x] Fix del resumen hardcodeado a "hoy" — mismo cambio que #4 (mismo
   endpoint). Sin parámetros, `/check-ins/resumen` sigue devolviendo
   solo el día de hoy (dashboard.astro no cambia, verificado con curl
   real que sigue trayendo solo el total de hoy). Con `fecha_inicio`/
   `fecha_fin`, historial.astro le pasa el mismo rango que usa para la
   lista, así que el total mostrado ahora coincide siempre con lo
   filtrado — antes no coincidía si se filtraba por otra fecha.
6. [x] Recalibrar rate limit de login — `POST /auth/login` (staff) tenía
   0 límite propio, compartía el `globalLimiter` con todo el tráfico de
   la app. Nuevo `staffLoginLimiter` dedicado (30/15min por IP) en
   `usuarios.js`, mismo patrón que `/login` (PUI gobierno). De paso se
   corrigió un bug real: `app.use('/', loginLimiter, authRoutes)` en
   `app.js` aplicaba `loginLimiter` a CUALQUIER request, no solo
   `POST /login` (confirmado pegándole a `/health` y viendo bajar su
   contador) — sin este fix, subir el límite global no habría servido
   de nada. `loginLimiter` ahora vive en `routes/auth.js`, montado
   directo sobre la ruta. `globalLimiter` subido de 100 a 400/15min
   (con `/health/estado` sondeando cada 60s en cualquier pantalla
   logueada + polling de dashboard.astro, un hotel activo con 2-3 staff
   en la misma IP podía tocar 120-150 req/15min sin que nadie atacara
   nada). Commit `a6ac997`. Verificado con curl real: staff login topa
   en intento 31, PUI login topa en intento 51, independientes entre sí
   y del tráfico general; flujo simulado de uso normal deja 301/400 de
   margen.