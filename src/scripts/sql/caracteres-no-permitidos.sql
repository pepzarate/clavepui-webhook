-- Qué caracteres hacen fallar la validación nueva (tarea 4b) en filas
-- concretas, SIN mostrar los valores. Solo lectura (tarea 4c).
--
-- Producción (desde clavepui-webhook/):
--   railway run -- sh -c 'psql "$DATABASE_PUBLIC_URL" -X -q -f src/scripts/sql/caracteres-no-permitidos.sql'
--
-- Las filas a revisar están en el CTE `revisar` (salieron del bloque 2 de
-- contar-posibles-inyecciones.sql el 2026-10-22); cámbialas ahí si hace falta.
--
-- Por cada fila y campo devuelve: largo del valor, y por cada carácter NO
-- permitido su categoría, el código Unicode y cuántas veces aparece. El
-- carácter solo se muestra si es un símbolo ASCII (/, ., #, etc.); letras y
-- dígitos nunca se muestran, solo su categoría.
--
-- Reglas que se reproducen (las de src/utils/validacionCheckIn.js):
--   nombres:            letras (cualquier alfabeto, con acentos), marcas
--                       combinables, espacio, guion, ' ’ y punto; máx. 50
--   folio / habitación: A-Z a-z 0-9 y guion; máx. 40 / 20
-- "Letra" se decide por rango Unicode (Latin-1, Latin Extended A/B y
-- similares) y no con [[:alpha:]], para no depender del locale de la base,
-- que también se imprime al final: si fuera "C", [[:alpha:]] no reconoce
-- acentos y el bloque 2 de la consulta anterior habría marcado nombres
-- válidos.

BEGIN READ ONLY;
SET LOCAL app.bypass_tenant_rls = 'on';

WITH revisar(tabla, campo, id) AS (
    VALUES
        ('check_ins', 'folio_pms', 344),
        ('check_ins', 'nombre', 343),
        ('check_ins', 'nombre', 1458),
        ('check_ins', 'numero_habitacion', 565),
        ('check_ins', 'segundo_apellido', 105),
        ('huespedes_frecuentes', 'nombre', 274),
        ('huespedes_frecuentes', 'nombre', 1389),
        ('huespedes_frecuentes', 'segundo_apellido', 36)
),
valores AS (
    SELECT r.tabla, r.campo, r.id, c.hotel_id,
           CASE r.campo
               WHEN 'folio_pms' THEN c.folio_pms
               WHEN 'numero_habitacion' THEN c.numero_habitacion
               WHEN 'nombre' THEN c.nombre
               WHEN 'primer_apellido' THEN c.primer_apellido
               WHEN 'segundo_apellido' THEN c.segundo_apellido
           END AS v
    FROM revisar r JOIN check_ins c ON r.tabla = 'check_ins' AND c.id = r.id
    UNION ALL
    SELECT r.tabla, r.campo, r.id, f.hotel_id,
           CASE r.campo
               WHEN 'nombre' THEN f.nombre
               WHEN 'primer_apellido' THEN f.primer_apellido
               WHEN 'segundo_apellido' THEN f.segundo_apellido
           END
    FROM revisar r JOIN huespedes_frecuentes f ON r.tabla = 'huespedes_frecuentes' AND f.id = r.id
),
caracteres AS (
    SELECT v.tabla, v.campo, v.id, v.hotel_id, ch, ASCII(ch) AS cp,
           v.campo IN ('folio_pms', 'numero_habitacion') AS es_codigo
    FROM valores v, REGEXP_SPLIT_TO_TABLE(v.v, '') AS ch
    WHERE v.v IS NOT NULL
),
clasificados AS (
    SELECT *,
        CASE
            WHEN cp BETWEEN 48 AND 57 THEN 'dígito'
            WHEN (cp BETWEEN 65 AND 90) OR (cp BETWEEN 97 AND 122) THEN 'letra ASCII'
            WHEN cp = 45 THEN 'guion -'
            WHEN cp = 32 THEN 'espacio'
            WHEN cp IN (39, 8217) THEN 'apóstrofo'
            WHEN cp = 46 THEN 'punto .'
            WHEN cp = 160 THEN 'espacio duro'
            WHEN cp IN (9, 10, 13) THEN 'tabulador/salto de línea'
            WHEN cp IN (8208, 8209, 8210, 8211, 8212) THEN 'guion tipográfico'
            WHEN cp BETWEEN 768 AND 879 THEN 'acento combinable'
            WHEN (cp BETWEEN 192 AND 591 AND cp NOT IN (215, 247)) OR cp BETWEEN 7680 AND 7935 THEN 'letra con acento/ñ'
            WHEN cp BETWEEN 33 AND 126 THEN 'símbolo ' || ch
            ELSE 'otro símbolo'
        END AS categoria
    FROM caracteres
),
no_permitidos AS (
    SELECT * FROM clasificados
    WHERE CASE
        WHEN es_codigo THEN categoria NOT IN ('dígito', 'letra ASCII', 'guion -')
        ELSE categoria NOT IN ('letra ASCII', 'letra con acento/ñ', 'acento combinable', 'espacio', 'guion -', 'apóstrofo', 'punto .')
    END
)
SELECT v.tabla, v.hotel_id, v.campo, v.id,
       CHAR_LENGTH(v.v) AS largo,
       COALESCE(
           (SELECT STRING_AGG(categoria || ' (U+' || LPAD(TO_HEX(cp), 4, '0') || ') ×' || n, ', ' ORDER BY categoria)
            FROM (SELECT categoria, cp, COUNT(*) AS n FROM no_permitidos p
                  WHERE p.tabla = v.tabla AND p.id = v.id AND p.campo = v.campo
                  GROUP BY categoria, cp) x),
           CASE WHEN v.v IS NULL OR v.v = '' THEN '(vacío: ya no falla)'
                ELSE '(ningún carácter fuera de la regla: revisar largo)' END
       ) AS no_permitidos
FROM valores v
ORDER BY 1, 2, 3, 4;

\echo '== Locale de la base (afecta a [[:alpha:]] de la consulta anterior) =='
SELECT datname, datcollate, datctype FROM pg_database WHERE datname = current_database();

ROLLBACK;
