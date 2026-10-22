-- Conteo de SOLO LECTURA de valores sospechosos de inyección de HTML/JS en
-- check_ins y huespedes_frecuentes (tarea 4b). Solo devuelve conteos e ids,
-- NUNCA el contenido de los campos.
--
-- Producción (desde clavepui-webhook/):
--   railway run -- sh -c 'psql "$DATABASE_PUBLIC_URL" -X -q -f src/scripts/sql/contar-posibles-inyecciones.sql'
--
-- La transacción es READ ONLY: cualquier escritura fallaría. El bypass de
-- RLS es necesario para ver todos los hoteles (sin él, FORCE RLS devuelve 0
-- filas) y es LOCAL a esta transacción, que termina en ROLLBACK.
--
-- Bloque 1 (sospechosos): < > " ` , "script", "javascript:", "vbscript:",
--   on<evento>=, entidades &#, "data:", "expression(", {{ y ${.
-- Bloque 2 (no pasarían la validación nueva del backend; sirve para saber si
--   la regla rechazaría datos reales antes de desplegarla). Nombres: letras,
--   espacio, guion, apóstrofo y punto, máx. 50. Folio: [A-Za-z0-9-] máx. 40.
--   Habitación: [A-Za-z0-9-] máx. 20. [[:alpha:]] depende del locale de la
--   base (UTF-8 en Railway: incluye acentos y Ñ).

BEGIN READ ONLY;
SET LOCAL app.bypass_tenant_rls = 'on';

\echo '== 1. Sospechosos de inyección (por hotel) =='
WITH patron AS (
    SELECT '[<>"`]|script|javascript:|vbscript:|on[a-z]+[[:space:]]*=|&#|data:|expression[[:space:]]*\(|\{\{|\$\{'::text AS re
),
ci AS (
    SELECT c.hotel_id, c.id,
           ARRAY_REMOVE(ARRAY[
               CASE WHEN c.nombre            ~* p.re THEN 'nombre' END,
               CASE WHEN c.primer_apellido   ~* p.re THEN 'primer_apellido' END,
               CASE WHEN c.segundo_apellido  ~* p.re THEN 'segundo_apellido' END,
               CASE WHEN c.folio_pms         ~* p.re THEN 'folio_pms' END,
               CASE WHEN c.numero_habitacion ~* p.re THEN 'numero_habitacion' END
           ], NULL) AS campos
    FROM check_ins c, patron p
),
hf AS (
    SELECT f.hotel_id, f.id,
           ARRAY_REMOVE(ARRAY[
               CASE WHEN f.nombre           ~* p.re THEN 'nombre' END,
               CASE WHEN f.primer_apellido  ~* p.re THEN 'primer_apellido' END,
               CASE WHEN f.segundo_apellido ~* p.re THEN 'segundo_apellido' END
           ], NULL) AS campos
    FROM huespedes_frecuentes f, patron p
)
SELECT 'check_ins' AS tabla, hotel_id, COUNT(DISTINCT id) AS filas,
       (ARRAY_AGG(DISTINCT id))[1:50] AS ids,
       ARRAY(SELECT DISTINCT UNNEST(ARRAY_AGG(campo))) AS campos
FROM ci, UNNEST(campos) AS campo
WHERE CARDINALITY(campos) > 0
GROUP BY hotel_id
UNION ALL
SELECT 'huespedes_frecuentes', hotel_id, COUNT(DISTINCT id),
       (ARRAY_AGG(DISTINCT id))[1:50],
       ARRAY(SELECT DISTINCT UNNEST(ARRAY_AGG(campo)))
FROM hf, UNNEST(campos) AS campo
WHERE CARDINALITY(campos) > 0
GROUP BY hotel_id
ORDER BY 1, 2;

\echo '== 2. Valores que la validacion nueva rechazaria (por hotel y campo) =='
WITH valores AS (
    SELECT 'check_ins' AS tabla, hotel_id, id, 'nombre' AS campo, nombre AS v FROM check_ins
    UNION ALL SELECT 'check_ins', hotel_id, id, 'primer_apellido', primer_apellido FROM check_ins
    UNION ALL SELECT 'check_ins', hotel_id, id, 'segundo_apellido', segundo_apellido FROM check_ins
    UNION ALL SELECT 'check_ins', hotel_id, id, 'folio_pms', folio_pms FROM check_ins
    UNION ALL SELECT 'check_ins', hotel_id, id, 'numero_habitacion', numero_habitacion FROM check_ins
    UNION ALL SELECT 'huespedes_frecuentes', hotel_id, id, 'nombre', nombre FROM huespedes_frecuentes
    UNION ALL SELECT 'huespedes_frecuentes', hotel_id, id, 'primer_apellido', primer_apellido FROM huespedes_frecuentes
    UNION ALL SELECT 'huespedes_frecuentes', hotel_id, id, 'segundo_apellido', segundo_apellido FROM huespedes_frecuentes
)
SELECT tabla, hotel_id, campo, COUNT(*) AS filas,
       COUNT(*) FILTER (WHERE CHAR_LENGTH(v) > CASE campo WHEN 'folio_pms' THEN 40 WHEN 'numero_habitacion' THEN 20 ELSE 50 END) AS por_longitud,
       COUNT(*) FILTER (WHERE v ~ '[[:space:]]' AND campo IN ('folio_pms', 'numero_habitacion')) AS con_espacios,
       COUNT(*) FILTER (WHERE v ~ '[0-9]' AND campo NOT IN ('folio_pms', 'numero_habitacion')) AS nombres_con_digitos,
       (ARRAY_AGG(id ORDER BY id))[1:20] AS ids
FROM valores
WHERE v IS NOT NULL AND v <> '' AND (
    CHAR_LENGTH(v) > CASE campo WHEN 'folio_pms' THEN 40 WHEN 'numero_habitacion' THEN 20 ELSE 50 END
    OR (campo IN ('folio_pms', 'numero_habitacion') AND v !~ '^[A-Za-z0-9-]+$')
    OR (campo NOT IN ('folio_pms', 'numero_habitacion') AND v !~ '^[[:alpha:]'' ’.-]+$')
)
GROUP BY tabla, hotel_id, campo
ORDER BY 1, 2, 3;

ROLLBACK;
