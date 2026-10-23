# ClavePUI Webhook — Backend

## Stack
Node.js 22, Express 5 (`package.json` ^5.2.1; este archivo decía 4 hasta
2026-10-15), PostgreSQL 15, Redis 7, BullMQ — Railway

## URL producción
https://api.clavepui.com

## Arrancar en desarrollo
npm run dev  (nodemon — puerto 8080)
Docker Redis: docker start clavepui-redis (en este WSL, `docker` a secas es el
shim roto de Docker Desktop: usar `/snap/bin/docker`)

## Sesión 2026-10-22 (tarea 4c, parte A) — ajustar la validación antes de desplegar

**Resultado en producción** del bloque 2 de `contar-posibles-inyecciones.sql`,
reportado por el usuario: 0 inyecciones. Hay 8 filas que la regla de la 4b
rechazaría:

| Tabla | Hotel | Campo | Ids |
|---|---|---|---|
| check_ins | 1 | folio | 344 |
| check_ins | 1 | nombre | 343, 1458 |
| check_ins | 2 | habitación | 565 |
| check_ins | 3 | segundo apellido | 105 |
| huespedes_frecuentes | 1 | nombre | 274, 1389 |
| huespedes_frecuentes | 3 | segundo apellido | 36 |

**El backend de la 4b todavía no se despliega.**

- **Diagnóstico de esas filas:** `src/scripts/sql/caracteres-no-permitidos.sql`.
  - Es solo lectura (transacción `READ ONLY` con ROLLBACK).
  - Las ids están en el CTE `revisar`.
  - Por fila y campo devuelve el largo y cada carácter no permitido, con
    categoría, código Unicode y cuántas veces aparece. Categorías: dígito,
    letra con acento/ñ, espacio, espacio duro, guion tipográfico, acento
    combinable, "símbolo /" (solo los símbolos ASCII se muestran tal cual)
    y otro símbolo.
  - Nunca muestra el valor.
  - "Letra" se decide por rango Unicode, no con `[[:alpha:]]`, y al final
    imprime el locale de la base.
  - Para correrla:
    `railway run -- sh -c 'psql "$DATABASE_PUBLIC_URL" -X -q -f src/scripts/sql/caracteres-no-permitidos.sql'`
- **Regla de folio y habitación ampliable** (`utils/validacionCheckIn.js`):
  - los símbolos permitidos además de `[A-Za-z0-9]` están en
    `SIMBOLOS_FOLIO` / `SIMBOLOS_HABITACION` (hoy `['-']`);
  - `reglaCodigo()` arma el patrón y el mensaje;
  - agregar `< > " ' \` = & : ;` lanza un error al cargar el módulo;
  - el frontend tiene la copia en `clavepui-frontend/src/utils/validacionCampos.ts`,
    y hay que cambiar las dos.
- **400 de validación:** sigue siendo `{ error, campo }`. El frontend
  marca ese campo.
- **Pruebas:** 84 (3 nuevas de la regla ampliable).

## Sesión 2026-10-22 (tarea 4b) — seguridad y cumplimiento antes del rediseño

- **Validación de texto libre en `POST /check-ins` y
  `POST /check-ins/:id/editar`** (`utils/validacionCheckIn.js`). Lo que no
  cumple → 400 `{ error, campo }`. Vacío o ausente sigue valiendo:
  checkin.astro solo exige la CURP.

  | Campo | Caracteres permitidos | Máximo |
  |---|---|---|
  | Nombre y apellidos | letras Unicode con sus marcas (acentos, Ñ, Ü), espacio, guion, apóstrofo `'`/`’` y punto | 50 (límite de `nombre` en el Manual PUI 8.2) |
  | `folio_pms` | `[A-Za-z0-9-]` | 40 |
  | `numero_habitacion` | `[A-Za-z0-9-]` | 20 |

  - Aceptados en las pruebas: "JOSÉ MARÍA", "D'ARTAGNAN", "MA. GUADALUPE",
    "O’BRIEN", "Nicté-Ha", "de la Cruz".
  - Rechazados: `<`, `>`, `"`, `:`, `=`, dígitos en nombres y espacios en
    folio o habitación.
  - **Antes de desplegar**, el bloque 2 de la consulta de abajo dice cuántos
    registros reales de producción no pasarían la regla (por ejemplo,
    habitaciones con espacio).
- **Consulta de solo lectura de posibles inyecciones** ya guardadas
  (`src/scripts/sql/contar-posibles-inyecciones.sql`). Devuelve conteos e
  ids por hotel, nunca contenido, en dos bloques:
  1. patrones de inyección en `check_ins` y `huespedes_frecuentes`;
  2. valores que la validación nueva rechazaría.

  Es una transacción `READ ONLY` que termina en ROLLBACK. Para correrla:
  `railway run -- sh -c 'psql "$DATABASE_PUBLIC_URL" -X -q -f src/scripts/sql/contar-posibles-inyecciones.sql'`
- **`POST /csp-report`** (`routes/csp.js`) recibe los reportes de la CSP
  del frontend (`vercel.json`, por ahora Report-Only).
  - Va montado **antes** del limitador global, con límite propio (100/15
    min por IP; al pasarlo responde 204 sin loguear), para no gastar el
    cupo de la IP del hotel.
  - Log `csp_violacion` con solo la directiva, el origen de lo bloqueado y
    la ruta de la página.
- **`GET /hoteles/config` ya no devuelve la `pui_clave`.** Ahora manda
  `pui_clave_configurada` y `pui_clave_ultimos4`.
  - **Hallazgo abierto (BACKLOG #42):** `POST /auth/login` sigue mandando
    la `pui_clave` al navegador, porque el frontend la usa como
    `x-hotel-key` en todas las llamadas. Es la misma clave con la que la
    PUI se autentica en `POST /login`. Quitarla exige cambiar cómo se
    autentica el frontend; está pendiente de decisión.
- **"Solo hoy" para editar:** ya lo validaba el servidor para cualquier rol
  (403, desde `cc74c28`); se agregó una prueba. Ver y exportar otras
  fechas (`GET /check-ins`, export, PDF) siguen sin validarse en el
  servidor, porque solo piden `x-hotel-key` (#42).
- **Búsqueda de la PUI, fases 1 y 2: no existen.** Comparación detallada en
  BACKLOG #43; la implementación espera el Manual Técnico.
- **Pruebas:** `test-checkin-v2` sube a 81: validación, config sin clave,
  editar solo hoy y csp-report.

## Sesión 2026-10-22 (tarea 4a de check-in v2) — hotel de prueba, zona horaria, logs

### Hotel de prueba (`hoteles.es_prueba`)
- **Columna:** `hoteles.es_prueba BOOLEAN NOT NULL DEFAULT FALSE`, en
  `initDb()` con `ADD COLUMN IF NOT EXISTS`. Sin GRANT: `hoteles` no tiene
  RLS.
- **Un hotel de prueba nunca toca la PUI:**
  - `POST /check-ins` lo guarda como `sin_reporte` y `encolado_pui = TRUE`,
    y no encola nada;
  - el reencolador lo salta (`WHERE NOT es_prueba`);
  - el worker lo omite (`esHotelDePrueba()`) aunque alguien encole un job a
    mano;
  - `POST /login` (PUI gobierno) lo rechaza con 401 aunque la clave sea
    correcta.
- **Métricas:** cualquier métrica o reporte que cruce hoteles debe filtrar
  `NOT es_prueba`. Hoy no hay ninguno; los reportes son por hotel.
- **Scripts** (`src/scripts/`, comunes en `lib/hotelPrueba.js`):
  - identifican el hotel por el RFC ficticio `PRUEBA000000`, se niegan a
    tocarlo si no tiene `es_prueba = TRUE`, y trabajan con el contexto RLS
    de ESE hotel (nunca con el bypass);
  - nunca imprimen contraseñas ni la `pui_clave`.

  | Script | Qué hace |
  |---|---|
  | `crear-hotel-prueba.js` | Idempotente. Hotel "HOTEL PRUEBA CLAVEPUI" con `checkin_v2 = TRUE`, `gov_pui_clave = NULL` y una `pui_clave` aleatoria; usuarios recepcionista y gerente. Contraseñas por `PRUEBA_PASS_RECEPCION` / `PRUEBA_PASS_GERENTE` (≥ 12, nunca en la línea de comandos); emails por `PRUEBA_EMAIL_*` (default `recepcion.prueba@` / `gerente.prueba@clavepui.com`) |
  | `datos-hotel-prueba.js [--dias=7] [--con-alertas]` | Borra y vuelve a cargar datos inventados y reproducibles: nombres y CURPs inventadas con dígito verificador válido, check-ins de 08:00 a 21:00 hora MX, un `error`, un `pendiente`, folios `PRB-…`, una CURP repetida hoy (hab. 112 y 305), una edición, 8 huéspedes frecuentes y, con `--con-alertas`, 3 reportes de búsqueda (2 activos) |
  | `borrar-datos-hotel-prueba.js` | Simulacro por defecto. `--confirmar` borra check-ins, ediciones, frecuentes y reportes; con `--incluir-hotel` también usuarios, suscripciones y el hotel |

- **Pruebas** (`npm run test:checkin-v2`, ahora 61): estado y encolado al
  registrar, ningún job, el reencolador y el worker lo ignoran, y
  `POST /login` responde 401.
- **Estado en producción: NO creado todavía.** Pasos para hacerlo:
  1. Desplegar primero este backend: `initDb()` crea la columna. Sin ella,
     los scripts paran con "despliega primero el backend".
  2. Desde `clavepui-webhook/`, capturar las contraseñas sin que queden en
     el historial (`read -s` no las muestra ni las guarda; las variables
     solo viven en esa terminal):
     ```bash
     read -rs -p "Contraseña recepción: " PRUEBA_PASS_RECEPCION; echo; export PRUEBA_PASS_RECEPCION
     read -rs -p "Contraseña gerente: "   PRUEBA_PASS_GERENTE;   echo; export PRUEBA_PASS_GERENTE
     railway run -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" PGSSL=1 node src/scripts/crear-hotel-prueba.js'
     railway run -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" PGSSL=1 node src/scripts/datos-hotel-prueba.js --con-alertas'
     unset PRUEBA_PASS_RECEPCION PRUEBA_PASS_GERENTE
     ```
     Las contraseñas se pueden generar en el gestor de contraseñas y
     pegarlas en el `read`, o con `openssl rand -base64 18`.
  3. Borrar solo sus datos:
     `railway run -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" PGSSL=1 node src/scripts/borrar-datos-hotel-prueba.js --confirmar'`.

### Zona horaria
- **Reporte:** en producción, "Últimos check-ins" mostró horas
  00:22–00:25.
- **Lógica revisada:** `fecha_checkin` es `timestamptz`, y todo filtro por
  día usa `DATE(fecha_checkin AT TIME ZONE 'America/Mexico_City')`. Es
  correcta con el proceso y la sesión de BD en UTC o en MX (pruebas con
  `TZ=UTC` y `PGOPTIONS="-c TimeZone=UTC"`).
- **Lo nuevo:** el servidor ya no deja la hora al navegador.
  `utils/zonaHoraria.js` (`zonaDelHotel`, `conHoraLocal`) agrega
  `fecha_local` y `hora_local` (HH:MM, 24 h) a:
  - `GET /check-ins`;
  - la respuesta de `POST /check-ins`;
  - `curp-activa`, que devuelve `hora_local`.

  Lo demás no cambia: checkin.astro recibe los mismos campos de siempre más
  esos dos. Pruebas a las 00:01 de hoy y 23:59 de ayer (hora MX) en lista,
  resumen y curp-activa.
- **Causa del 00:22 todavía sin confirmar.** Con `timestamptz` solo puede
  venir de una columna con otro tipo en producción combinada con el `TZ`
  del proceso, o de check-ins hechos de verdad a medianoche. Para salir de
  dudas, al arrancar se loguea `Zona horaria` (`tz_env`, `sesion_bd`, tipo
  de la columna), y hay un diagnóstico de solo lectura que imprime los
  últimos 10 check-ins en UTC y en hora MX, sin datos personales:
  `railway run -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" PGSSL=1 node src/scripts/diagnostico-zona-horaria.js 1'`
  (el último argumento es el hotel_id).
- **`hoteles` no guarda zona horaria:** todo usa `America/Mexico_City`.
  **No se agregó la columna** (decisión pendiente). Hace falta para un
  hotel en Quintana Roo (UTC-5 fijo), Sonora (UTC-7 fijo) o Baja
  California (UTC-8 con horario de verano). `zonaDelHotel()` ya lee
  `hotel.zona_horaria` si existe. Faltaría:
  - la columna (`TEXT NOT NULL DEFAULT 'America/Mexico_City'`);
  - cambiar los `AT TIME ZONE` fijos por el de la columna;
  - que el frontend use la zona del hotel para calcular "hoy".

### Log de solicitudes con datos personales
- **Dónde vive:** el `auditLogger` escribe a la salida estándar, que
  guarda Railway (`railway logs`). **No está en la BD:** `logs_auditoria`
  existe, pero ningún código la llena.
- **Qué guardaba:** hasta el commit `3acfe11` (tarea 2b, 2026-10-19)
  quedaban completos nombre, apellidos, teléfono y correo del body, y la
  URL completa (`curp=` y `nombre=`). Desde entonces todo eso se
  enmascara.
- **Contarlos** (solo lectura, imprime conteos y rango de fechas, nunca
  los datos):
  ```bash
  railway deployment list
  railway logs <DEPLOYMENT_ID> --json --lines 100000 --filter "Solicitud" | node src/scripts/contar-logs-personales.js
  ```
- **Propuesta (sin ejecutar):** Railway no permite borrar líneas sueltas.
  Opciones:
  - esperar a que expire la retención del plan;
  - borrar los deployments anteriores a `3acfe11`, lo que se lleva sus
    logs.

  No se ha modificado nada en producción. Ver BACKLOG #35.

### Otros
- `POST /check-ins` y `GET /check-ins` no cambiaron de contrato (solo
  campos nuevos).
- Semgrep (`p/security-audit`, `p/secrets`, `p/owasp-top-ten`,
  `p/javascript`) sobre los cambios de las tareas 1 a 4a. Los 3 avisos
  de backend no requieren cambio:
  - **`cors-misconfiguration` en `app.js`:** falso positivo, el origen se
    compara contra una lista fija;
  - **`rejectUnauthorized: false` en `config/index.js`:** ya existía, es la
    conexión de Railway;
  - **`rejectUnauthorized: false` en los dos scripts nuevos:** mismo motivo
    (proxy público de Railway con certificado propio); solo se activa con
    `NODE_ENV=production` o `PGSSL`.
- **`npm test` (`tests/test-endpoints.js`) es una prueba vieja.** Apunta a
  :3000 (`TEST_URL`) y necesita `PUI_CLAVE` de un hotel local. Marca ❌ en
  5 casos que sí responden lo esperado (401/400/405): el fallo está en la
  comparación del propio script, no en el backend.

## Sesión 2026-10-19 (tarea 3 de check-in v2) — método de captura

Estadística de cómo se captura la CURP en `/checkin-nuevo` (escáner por
cámara de la tarea 3), sin datos personales.

- **Columnas** en `check_ins` (`initDb()`, `ADD COLUMN IF NOT EXISTS`):
  `metodo_captura TEXT` y `editado_tras_escaneo BOOLEAN`, NULL en los
  registros anteriores y en los de `checkin.astro` (que no las manda). CHECK
  idempotente `check_ins_metodo_captura_valido` (en un `DO $$ … $$` que
  revisa `pg_constraint`): `'ocr'`, `'qr'`, `'lector'`, `'frecuente'`,
  `'manual'`. **`'frecuente'` no estaba en lo pedido**: es la CURP llenada
  al confirmar un huésped de la búsqueda por nombre; meterlo en `'manual'`
  habría mezclado dos cosas distintas. Sin GRANT nuevo (el GRANT de tabla
  cubre columnas); RLS sin cambios.
- **`POST /check-ins`** las acepta como opcionales: valor fuera de la lista
  → 400; `editado_tras_escaneo` no booleano → 400; ausentes → NULL.
- **Pruebas** (`npm run test:checkin-v2`, ahora 49): los 5 valores se
  guardan con su `editado_tras_escaneo`, sin campos → NULL/NULL, 400 para
  valores inválidos, y el CHECK de la BD rechaza un UPDATE con un valor
  fuera de la lista (23514).
- **Ver el uso por método y hotel** (producción, solo lectura; el `SET`
  es necesario por RLS):
  ```
  railway run -- sh -c 'psql "$DATABASE_PUBLIC_URL" -c "SET app.bypass_tenant_rls = on; SELECT h.nombre AS hotel, COALESCE(c.metodo_captura, '\''(sin dato)'\'') AS metodo, COUNT(*) AS registros, COUNT(*) FILTER (WHERE c.editado_tras_escaneo) AS editados_tras_escaneo FROM check_ins c JOIN hoteles h ON h.id = c.hotel_id WHERE c.fecha_checkin >= NOW() - interval '\''30 days'\'' GROUP BY 1, 2 ORDER BY 1, 3 DESC;"'
  ```

## Sesión 2026-10-19 (tarea 2b) — POST /check-ins ya no se cuelga sin Redis

Corrige el hallazgo #32b de la tarea 2: con Redis caído, `POST /check-ins`
guardaba el check-in y nunca respondía, y el reintento del recepcionista
lo duplicaba. Ahora **la BD es la fuente de verdad**: si el INSERT funciona,
el 201 sale siempre.

- **Bandeja de salida:** columna `check_ins.encolado_pui BOOLEAN NOT NULL
  DEFAULT TRUE` (`initDb()`, `ADD COLUMN IF NOT EXISTS`; las filas viejas
  quedan en TRUE porque se encolaron en su momento) + índice parcial
  `idx_check_ins_pendientes_encolar (hotel_id, creado_en) WHERE
  encolado_pui = FALSE`. Se eligió una columna nueva y no un valor de
  `estado_pui` porque ese campo es del worker y lo leen el frontend, el
  CSV y el PDF. Sin GRANT nuevo: el GRANT de tabla de `initDb()` cubre la
  columna.
- **`POST /check-ins`** inserta con `encolado_pui = FALSE` y llama a
  `intentarEncolar()` (`services/puiQueue.js`): `Promise.race` contra
  `PUI_ENCOLAR_TIMEOUT_MS` (2000). Si entra a la cola → `encolado_pui =
  TRUE`; si falla o vence → log `cola_pui_pendiente` con solo `checkinId`,
  `hotel_id` y `motivo` (`timeout` / `redis_no_disponible` / `db_error`) y
  responde 201 igual. Nunca lanza.
- **Cola sin `enableOfflineQueue`** (solo el `Queue`; el `Worker` sigue con
  su conexión de siempre): con Redis caído, `add()` falla al instante en vez
  de esperar la reconexión y mandarse sola después. Si Redis está caído
  desde el arranque, el cliente nunca queda listo y gana el timeout de 2 s.
- **Reencolador** (`reencolarPendientes()`, arranca en `app.js` después de
  `initDb()`, cada `PUI_REENCOLAR_INTERVALO_MS` = 60000): recorre los
  hoteles y, **con `withHotelContext` por hotel** (respeta RLS como el
  worker), toma hasta 100 pendientes con más de `PUI_REENCOLAR_GRACIA_MS`
  (30000, para no pisar el intento de la propia request) y los encola. Si
  Redis sigue sin responder, para en el primer fallo hasta la siguiente
  vuelta. No corre dos veces a la vez.
- **Sin avisos duplicados:**
  - `jobId` determinista `checkin-<id>` (`jobIdDe()`): mientras el job siga
    en Redis, encolarlo otra vez no crea otro;
  - si un `add()` que venció termina después, marca el check-in en ese
    momento;
  - el worker revisa al empezar (`yaNotificado()`) y omite el check-in si
    ya está `enviado` o ya no existe, por si el job original se purgó
    (`removeOnComplete`) y se vuelve a encolar.
- **Otras rutas:** solo `POST /check-ins` encola; `POST
  /check-ins/:id/editar` y el resto no tocan Redis. `/health/estado` ya
  tenía su timeout de 3 s.
- **Logs sin datos personales (de paso):** el `auditLogger` registraba la
  URL completa, así que `GET /check-ins/curp-activa?curp=…` (de la tarea 2)
  y `/huespedes/buscar?curp=…` dejaban la CURP entera en el log, y
  `buscar-por-nombre?nombre=…` el nombre. Ahora `urlSinDatosPersonales()`
  (`middleware/logger.js`) los enmascara (`curp=ZEMR***`, `nombre=***`), y
  en el body también se enmascaran `nombre`, `primer_apellido`,
  `segundo_apellido`, `telefono` y `correo` (antes solo `curp` y claves).
  Verificado: 0 CURPs en el log de una corrida completa de la suite (antes, 5).
- **Pruebas** (`npm run test:checkin-v2`, ahora 40 verificaciones): con
  `TEST_REDIS_PARAR` / `TEST_REDIS_LEVANTAR` (comandos para apagar y
  prender Redis; sin ellas esa sección sale SKIP):
  - Redis caído → 201 en 15 ms (falla al instante sin cola offline) y
    quedan `encolado_pui = false`;
  - al volver Redis, el reencolador los encola y el worker los procesa
    (`sin_reporte`);
  - un job por check-in con jobId `checkin-<id>`, y volver a encolar no
    cambia los conteos de la cola;
  - con el job purgado y el check-in ya `enviado`, el reencolado no vuelve
    a avisar (estado e intentos sin cambios).

  A mano, además:
  - Redis caído **desde el arranque** del backend → 201 en 2.09 s (timeout)
    y se encoló 4 s después de levantar Redis; los dos `add` atrasados
    (request + primer reintento) llegaron con el mismo jobId y el worker
    procesó una sola vez;
  - con los tiempos de producción (60 s / 30 s), registrado desde
    `/checkin-nuevo` con Redis caído (54 ms) y encolado y procesado solo
    a los 32 s de levantar Redis.

  `test-rls.js` sin regresión.
- **Redis en local:** el Docker de snap sí funciona aquí
  (`/snap/bin/docker`; `docker` a secas es el shim roto de Docker
  Desktop). Para las pruebas se usó un contenedor `redis:7-alpine` creado y
  borrado en la sesión.

## Sesión 2026-10-17 (tarea 2 de check-in v2) — folio, CURP activa, acentos, estado

Correcciones de backend que pidió la página `/checkin-nuevo` (frontend).
Ninguna cambia lo que ya usa `checkin.astro`.

- **Folio duplicado en envíos simultáneos → 409, ya no 500.** La regla de
  siempre: folio único **por hotel, sin importar el día**, solo si viene
  (`idx_check_ins_folio_unico`, índice único parcial `(hotel_id,
  folio_pms) WHERE folio_pms IS NOT NULL`, que **ya existía** desde
  Feature 14). La verificación previa con `SELECT` no cubre la carrera: los
  dos envíos pasan el `SELECT` y el segundo `INSERT` choca con el índice
  (23505), que caía en el 500 genérico. Ahora `esFolioDuplicado(err)`
  (checkIns.js) lo traduce al mismo 409 en `POST /check-ins` y en
  `POST /check-ins/:id/editar`. La verificación previa se conserva.
  - Antes de tocar nada se buscaron repetidos (solo lectura): 0 en local y
    0 en producción (240 check-ins con folio de 1275; índice válido,
    `indisvalid = true`). Cómo repetirlo en producción, con
    `DATABASE_PUBLIC_URL` (ver memoria del proyecto):
    `railway run -- sh -c 'psql "$DATABASE_PUBLIC_URL" -c "SET app.bypass_tenant_rls = on; SELECT hotel_id, folio_pms, COUNT(*) FROM check_ins WHERE folio_pms IS NOT NULL GROUP BY 1, 2 HAVING COUNT(*) > 1;"'`
    (sin el `SET`, RLS devuelve 0 filas siempre; ver la sección RLS).
- **`GET /check-ins/curp-activa?curp=...`** → `{ activa, total_hoy,
  habitacion, fecha_checkin }`: si esa CURP ya tiene check-in HOY
  (America/Mexico_City) en ESTE hotel y en qué habitación (la del más
  reciente). Auth: `requireHotel` + `requireUsuarioStaff` (devuelve dónde
  está una persona, por eso pide JWT además de x-hotel-key).
  `withHotelContext` + `WHERE hotel_id`. Acepta minúsculas; 400 si no es
  CURP. El `aviso_curp_duplicada` de `POST /check-ins` no cambió.
- **Búsqueda por nombre sin acentos.** `initDb()` crea la extensión
  `unaccent` (`IF NOT EXISTS`; es "trusted" desde PG13: basta CREATE sobre
  la base; en Railway el rol es superusuario y la extensión está
  disponible, verificado en `pg_available_extensions`) y la función
  `clavepui_sin_acentos(text)` (IMMUTABLE, `CREATE OR REPLACE`), que usa
  `unaccent` o, si la extensión no se pudo crear, `translate()` (vocales
  con acento, diéresis y Ñ) sin cortar el arranque. GRANT EXECUTE
  explícito a `clavepui_tenant`. `GET /huespedes/buscar-por-nombre`
  compara `clavepui_sin_acentos(...) ILIKE clavepui_sin_acentos($2)`:
  "PEREZ" ↔ "Pérez", "munoz" ↔ "Muñoz". **Sin índice**: un `ILIKE '%x%'`
  no usa btree (haría falta `pg_trgm`) y el filtro por `hotel_id` ya usa
  el índice único `(hotel_id, curp)`.
- **`GET /health/estado` en tres niveles** (`services/estadoSistema.js`).
  Conserva `operativo`, `db` y `cola` (Layout.astro solo lee `operativo`,
  que sigue siendo `db ok && cola ok`) y agrega:
  - `ocr`: `ok` / `error` / `no_configurado`, con `GET /salud` del servicio
    por la red privada, timeout `HEALTH_OCR_TIMEOUT_MS` (1500) y resultado
    en caché `HEALTH_OCR_CACHE_MS` (15000); consultas simultáneas
    comparten la misma llamada (11 consultas → 1 llamada, medido);
  - `latencia_ms: { db, cola, ocr }`;
  - `nivel`: `error` si Postgres no responde; `degradado` si algo pasa de
    `HEALTH_UMBRAL_LENTO_MS` (1000), si Redis no responde o si el OCR está
    caído o sin configurar; si no, `operativo`;
  - `causas: [{ servicio: 'db'|'cola'|'ocr', motivo: 'lento'|'no_disponible'|'no_configurado' }]`
    y `umbral_lento_ms`. Sin datos sensibles.
  
  Ejemplo (OCR caído):
  `{"operativo":true,"db":"ok","cola":"ok","ocr":"error","nivel":"degradado","causas":[{"servicio":"ocr","motivo":"no_disponible"}],"latencia_ms":{"db":4,"cola":3,"ocr":null},"umbral_lento_ms":1000}`
- **Nombre comercial:** `hoteles` no tiene; solo `nombre` (la razón social).
  No se creó columna.
- **Pruebas:** `npm run test:checkin-v2` (`tests/test-checkin-v2.js`, con
  el servidor corriendo con Postgres y Redis): crea dos hoteles de prueba
  propios y los borra al final. 6 envíos simultáneos con el mismo folio →
  1×201 + 5×409, 0×500 (los 5 entraron por el índice, no por el `SELECT`);
  `curp-activa` (habitación, aislamiento, 400/401/403); búsqueda sin
  acentos en las dos direcciones; forma de `/health/estado` y los niveles
  con `clasificar()` (incluida base caída). `test-rls.js` sin regresión.
- **Hallazgo (corregido el 2026-10-19, ver arriba):** si Redis no
  responde, `POST /check-ins` **guardaba el check-in y nunca contestaba**
  (`puiQueue.add` espera la reconexión; medido: sin respuesta a los 15 s
  y la fila ya en la BD). El recepcionista ve "Registrando…" sin fin y
  puede reintentar → duplicado. Se resolvió con timeout del encolado +
  bandeja de salida (`encolado_pui`) + reencolador.
- **Redis en local sin Docker:** se compiló `redis-server` 7.2.5 desde el
  código fuente en el scratchpad de la sesión (`make`), sin instalar nada
  en el sistema.

## Sesión 2026-10-17 — feature flag `checkin_v2` (página /checkin-nuevo)

Para activar por hotel la página nueva de check-in del frontend
(`/checkin-nuevo`, rediseño con OCR de INE; ver
`clavepui-frontend/CLAUDE.md`, "Check-in v2").

- **Columna** `hoteles.checkin_v2 BOOLEAN NOT NULL DEFAULT FALSE`, en
  `initDb()` con `ADD COLUMN IF NOT EXISTS` (apagada para todos al
  desplegar). **Sin GRANT nuevo:** `hoteles` no tiene RLS y todas sus
  lecturas van por `pool` (rol dueño), nunca por `tenantPool`.
- **`GET /hoteles/funciones`** (`routes/hoteles.js`) → `{ checkin_v2 }`.
  Auth: `requireHotel` + `requireUsuarioStaff` (cualquier rol), igual que
  `POST /ocr/ine`. El frontend lo consulta en cada carga de la página, no
  en el login, para que un cambio aplique sin volver a iniciar sesión.
- **`POST /admin/hoteles/:id/funciones`** (`routes/admin.js`) con
  `x-admin-token` y `{ "checkin_v2": true|false }` (400 si no es
  booleano, 404 si el hotel no existe).
- Verificado en local con Postgres real: columna creada (`boolean`, not
  null, default false); 401 sin auth / sin JWT, 403 con JWT de otro
  hotel, 200 `false` por defecto, 401/400/404 del admin, activar en un
  hotel no afecta a otro; dejado en `false` al terminar.
  `test-rls.js` sin regresión.
- **Activarlo en producción** (cuando toque): `POST
  https://api.clavepui.com/admin/hoteles/<id>/funciones`.

### Columnas de nombre (revisado 2026-10-17, sin cambios)
- `check_ins` y `huespedes_frecuentes` tienen `nombre`, `primer_apellido`
  y `segundo_apellido` (TEXT, nullable). También `reportes_activos`
  (vienen del gobierno).
- `POST /check-ins` las guarda **tal como llegan**: sin `trim`, sin
  mayúsculas, sin validar que existan (el frontend hace `trim()`).
  Se mandan así a la PUI en `notificar-coincidencia` (puiQueue.js) y salen
  así en el CSV y el PDF.
- `huespedes_frecuentes` se actualiza con `COALESCE(EXCLUDED.x, x)`: un
  valor nuevo no nulo pisa al anterior. Cuando `/checkin-nuevo` mande los
  nombres en mayúsculas sin acentos (como en la INE), el registro del
  huésped frecuente cambia de "Pérez" a "PEREZ" en su siguiente visita.
- `GET /huespedes/buscar-por-nombre` ignoraba mayúsculas pero no acentos.
  **Resuelto en la tarea 2** con `unaccent` (ver la sesión de arriba).

## Sesión 2026-10-15 — POST /ocr/ine (lectura de INE para el check-in)

Endpoint nuevo para leer CURP y nombre del frente de una INE y PRELLENAR
el formulario de check-in. **Todavía no lo usa `checkin.astro`**: hoy lo
usa solo la sección "Flujo check-in" de la página de laboratorio
`poc-ocr-ine` (frontend). No crea check-ins ni toca la BD.

- **`src/routes/ocr.js`, `POST /ocr/ine`.**
  - **Auth:** la misma que `POST /check-ins/:id/editar`, o sea
    `requireHotel` (x-hotel-key) + `requireUsuarioStaff` (JWT de staff).
    `requireHotel` se reutiliza exportándolo desde `checkIns.js` (solo se
    agregó el export; el flujo de check-ins no cambió).
  - **Cuerpo:** la imagen **en binario** (`Content-Type: image/jpeg` o
    `image/png`), **no multipart**, para no agregar `multer`. Se lee con
    `express.raw({ limit: '5mb' })` montado solo en esta ruta, y se valida
    la firma real del archivo (magic bytes), no solo el Content-Type.
  - **Rate limit:** `ocrIneLimiter`, **60 / 15 min por usuario de staff**
    (llave `hotel_id:usuario`, no IP). Va montado sobre la ruta y DESPUÉS
    de la auth, igual que la lección del `loginLimiter`.
  - **Reenvío:** el mismo buffer se manda a `${OCR_SERVICE_URL}/ocr/ine`
    (servicio privado **`clavepui-ocr`**, repo hermano `clavepui/clavepui-ocr`,
    RapidOCR dockerizado; desde 2026-10-16. Antes vivía en
    `clavepui-frontend/tools/poc-paddleocr`) con el header
    `X-OCR-Token: OCR_SERVICE_TOKEN` y timeout `OCR_TIMEOUT_MS` (10 s).
  - **Respuestas:**
    - 200 `{ curp, nombre, tiempos }`;
    - 422 `sin_curp` (no se encontró un CURP válido);
    - 400 `imagen_invalida`;
    - 413 `imagen_muy_grande`;
    - 415 `tipo_no_soportado`;
    - 429 `limite_excedido`;
    - 503 `ocr_no_disponible` (servicio caído) / `ocr_no_configurado`
      (faltan variables) / `ocr_ocupado` (desde 2026-10-16: el servicio
      corre 1 lectura a la vez con 4 en espera y respondió 503 `ocupado`;
      es temporal, reintentar. Antes caía en el 502 genérico);
    - 504 `ocr_timeout`;
    - 502 `ocr_error` (el servicio respondió error, p. ej. token
      equivocado).
    
    Todas traen un `mensaje` legible para el recepcionista.
  - **Logs sin datos personales:** solo `hotel_id`, `usuario` (id),
    `ms`, `curp_valido` (sí/no) y `nombre_coincide` (sí/no/null). En
    errores, el `resultado`/`codigo`.
    - Verificado sobre los logs reales de la prueba: 0 CURPs.
    - `auditLogger` registra `requestBody: {}`, porque copia el body a
      nivel app, antes de que la ruta lea la imagen.
- **Verificado en local** con Postgres real (sin Redis: los errores de
  conexión de BullMQ al arrancar no afectan esta ruta) y el servicio de
  OCR real, con un JWT de staff de prueba firmado con el `JWT_SECRET`
  local (sin crear usuarios en la BD):
  - 401 sin auth, 403 con JWT de otro hotel;
  - 200 con frame PNG y con recorte JPEG reales (CURP válido + nombre
    que coincide);
  - 415, 400 (archivo disfrazado), 413, 422 (imagen sin CURP);
  - el usuario #61 en 15 min recibe 429 y otro usuario no se ve
    afectado;
  - 504 con `OCR_TIMEOUT_MS=50`, 502 con token equivocado, 503 sin
    variables y 503 con el servicio apagado.
- **Ojo con los tiempos medidos en WSL:** `performance.now()` de Node
  usa `CLOCK_MONOTONIC`, que en este WSL2 corre ~6% rápido (ver
  `clavepui-frontend/CLAUDE.md`), así que `backend_total_ms` sale ~6%
  alto en local. En Railway no aplica.
- **`ocr_ocupado` verificado (2026-10-16)** con un stub que responde 503
  `ocupado`: el backend contesta 503 con su mensaje y el log trae solo
  `resultado: ocupado`.
- **Pendiente para producción:** desplegar `clavepui-ocr` en Railway como
  servicio privado (sin dominio público) y configurar aquí:
  - `OCR_SERVICE_URL=http://${{clavepui-ocr.RAILWAY_PRIVATE_DOMAIN}}:${{clavepui-ocr.PORT}}`
    (= `http://clavepui-ocr.railway.internal:8080`);
  - `OCR_SERVICE_TOKEN=${{clavepui-ocr.OCR_SERVICE_TOKEN}}`.
  
  Pasos completos en el README de `clavepui-ocr`. Sin esas dos variables
  el endpoint responde 503 y el resto de la app funciona igual.
- **En local**, `clavepui-ocr` se publica en el **8001** (este backend usa
  el 8080): `OCR_SERVICE_URL=http://127.0.0.1:8001`.

## Incidente 2026-09-27 — GET /reportes/pdf tumbaba el proceso en Railway

Reportado en logs de producción: cualquier reporte de más de una
página hacía crashear el proceso completo de Node (Railway lo
reiniciaba). Diagnosticado y corregido el 2026-09-28, commits
`a454030` (causa raíz) y `bff4aa2` (blindaje de respuesta), ambos sobre
`src/routes/reportes.js`. Sin push todavía — pendiente aprobación.

**Causa raíz (`a454030`)**: el `PDFDocument` se creaba sin
`bufferPages: true`, así que PDFKit descartaba cada página del buffer
interno en cuanto se llamaba `addPage()` (solo conservaba la última).
El pie de página iteraba `for (i = 0; i < pageCount; i++)`  asumiendo
que `bufferedPageRange().start` siempre es 0 — deja de serlo apenas el
reporte pasa de una página, y `switchToPage(i)` revienta con
`"switchToPage(0) out of bounds"` en cuanto `i` apunta a una página ya
descartada. Fix: `bufferPages: true` + iterar
`bufferedPageRange().start` hasta `start + count` (nunca desde 0 fijo).

De paso apareció un segundo bug, más sutil, en el mismo pie de
página: el texto se dibuja en `page.height - 35`, dentro del margen
inferior de 50pt — eso cae por debajo del límite que PDFKit calcula
internamente (`page.height - margins.bottom`) para texto con `{
width }`, así que disparaba paginación automática (`continueOnNewPage`
vía su `LineWrapper`) y el pie terminaba en una página en blanco de
más, **incluso en reportes de una sola página** (nunca se notó porque
no tumbaba nada, solo dejaba un footer mal puesto). Fix: bajar
`doc.page.margins.bottom` a 0 momentáneamente solo mientras se escribe
cada pie, restaurarlo de inmediato después.

**Por qué tumbaba el proceso entero, no solo la request (`bff4aa2`)**:
el `PDFDocument` estaba conectado con `doc.pipe(res)` desde el inicio.
Cuando el `catch` respondía el 500 tras el crash de arriba, el `doc`
nunca se cerraba (ni `end()` ni `destroy()`) — seguía intentando
escribir en una respuesta que el catch ya daba por terminada. Esa
escritura tardía topaba con `ERR_STREAM_WRITE_AFTER_END` como evento
`'error'` sin listener, que en Node no es un error cualquiera: revienta
el proceso completo (coincide exactamente con el log de Railway).
Fix: armar el PDF completo en memoria (`doc.on('data')` +
`doc.on('end')`) y responder recién ahí, nunca con `pipe(res)` directo;
más `doc.on('error')` explícito y una bandera `responded` compartida
para que catch/`error`/`end` nunca respondan dos veces la misma
request.

**Grep de otros endpoints con el mismo patrón** (`pipe(res)`/streaming
en `src/`): ninguno. `GET /check-ins/export` (CSV) arma el string
completo en memoria y responde con un único `res.send()` — no tiene
este riesgo, no se tocó.

**Verificación**: reproducido localmente con Postgres real (hotel de
prueba dedicado, check-ins insertados y borrados en la misma sesión,
sin tocar los 3 hoteles reales) — el crash exacto de producción
("switchToPage(0) out of bounds...") se reprodujo con 30+ check-ins de
un mismo día antes del fix. Tras el fix: PDF completo con numeración
de página correcta en reportes de 1, 2, 3 y 5+ páginas (confirmado
decodificando el contenido real del PDF, no solo el código HTTP). Fallo
simulado a mitad de generación: responde 500 limpio, el proceso sigue
vivo, y una request normal inmediatamente después sigue funcionando.
`node src/scripts/test-rls.js` sigue 8/8 sin regresión. Sin cambios al
diseño visual del PDF ni dependencias nuevas.

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
│   ├── ocr.js            — POST /ocr/ine (lee CURP + nombre de una INE vía el
│   │                       servicio de OCR; requireHotel + requireUsuarioStaff,
│   │                       limitador propio por usuario, ver Sesión 2026-10-15)
│   ├── hoteles.js        — GET /hoteles/config (gerente), GET /hoteles/funciones
│   │                       (feature flags, cualquier staff)
│   ├── admin.js          — POST /admin/hoteles, /admin/hoteles/:id/gov-clave,
│   │                       /admin/hoteles/:id/funciones,
│   │                       POST /admin/limpiar-pruebas
│   └── reportes.js       — GET /reportes/pdf (PDFKit)
├── services/
│   ├── puiQueue.js       — BullMQ worker — consulta gov_pui_clave por hotel
│   └── estadoSistema.js  — GET /health/estado: db, cola, ocr, latencias y nivel
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
- hoteles          — id, nombre, rfc, pui_clave, gov_pui_clave, activo,
                     checkin_v2 (flag de /checkin-nuevo, default false)
                     es_prueba (hotel de prueba: nunca toca la PUI, ver
                     sesión 2026-10-22)
- usuarios         — id, hotel_id, nombre, email, password_hash, rol, activo
- check_ins        — id, hotel_id, curp, nombre, primer_apellido, segundo_apellido,
                     fecha_nacimiento, lugar_nacimiento, sexo_asignado,
                     numero_habitacion, fecha_checkin, estado_pui,
                     intentos_pui, ultimo_error, registrado_por,
                     encolado_pui (false = aviso a la PUI pendiente de encolar),
                     metodo_captura ('ocr'|'qr'|'lector'|'frecuente'|'manual'|NULL),
                     editado_tras_escaneo (NULL en registros sin método)
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

**Lo mismo aplica a SELECT** (nos volvió a pasar el 2026-08-29, ahora
depurando por `psql` directo): un `SELECT * FROM huespedes_frecuentes
WHERE ...` corrido a mano contra `DATABASE_URL` (el rol dueño de las
tablas) devuelve **0 filas siempre**, con datos real presentes, porque
`FORCE ROW LEVEL SECURITY` también aplica al dueño y ninguna sesión de
psql cruda tiene seteado `app.current_hotel_id`/`app.bypass_tenant_rls`
— la policy evalúa a NULL (falso) para toda fila, sin ningún error que
lo delate. Para depurar por psql a mano hace falta
`SET app.bypass_tenant_rls = 'on';` antes del SELECT, o mejor, probar
por el endpoint real (que sí pasa por withHotelContext/withAdminContext)
en vez de psql directo.

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
OCR_SERVICE_URL=...    (opcional, desde 2026-10-15 — URL del servicio privado
                        clavepui-ocr por la RED PRIVADA de Railway, nunca una
                        pública: http://clavepui-ocr.railway.internal:8080
                        (o la referencia ${{clavepui-ocr.RAILWAY_PRIVATE_DOMAIN}}).
                        Excepción documentada a la regla "nunca URLs internas
                        de Railway" del CLAUDE.md raíz: esa regla es para lo
                        público/frontend. En local: http://127.0.0.1:8001.
                        Sin ella POST /ocr/ine → 503)
OCR_SERVICE_TOKEN=...  (opcional — secreto compartido con el servicio de OCR,
                        mismo valor que su OCR_SERVICE_TOKEN; va en el header
                        X-OCR-Token. Sin ella POST /ocr/ine → 503)
OCR_TIMEOUT_MS=10000   (opcional — timeout del reenvío al servicio de OCR)
HEALTH_UMBRAL_LENTO_MS=1000 (opcional — arriba de esto un servicio cuenta como
                        lento y /health/estado da "degradado")
HEALTH_OCR_TIMEOUT_MS=1500, HEALTH_OCR_CACHE_MS=15000 (opcionales — consulta a
                        GET /salud del OCR desde /health/estado)
PUI_ENCOLAR_TIMEOUT_MS=2000, PUI_REENCOLAR_INTERVALO_MS=60000,
PUI_REENCOLAR_GRACIA_MS=30000 (opcionales, desde 2026-10-19 — espera máxima a
                        Redis en POST /check-ins y reencolador de pendientes)

Plantilla con todas las variables (sin valores): `.env.example` (desde
2026-10-16). **No leer ni mostrar `.env`**: para saber qué variables hay,
usar `.env.example`.

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
1. Check-in registrado (`encolado_pui = false`) → job encolado con hotel_id y
   jobId `checkin-<id>` (máx. 2 s; si Redis no responde queda pendiente y el
   reencolador lo reintenta cada minuto) → `encolado_pui = true`. El worker
   omite los check-ins ya `enviado`.
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
  30/15min (routes/usuarios.js), `POST /ocr/ine` 60/15min **por usuario**
  (routes/ocr.js, montado después de la auth) — cada uno con su propio limitador,
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