-- Solo lectura (tarea 5): valores reales de estado_pui y de avisos por
-- hotel, para revisar el mapeo al vocabulario nuevo (utils/estadoPui.js)
-- antes de mostrarlo en /historial-nuevo. Sin datos personales.
--
-- Producción (desde clavepui-webhook/):
--   railway run -- sh -c 'psql "$DATABASE_PUBLIC_URL" -X -q -f src/scripts/sql/estados-pui-por-hotel.sql'
--
-- Lo que importa: con el hotel SIN enlace (gov_pui_clave vacía o de
-- prueba) todo se muestra "Registrado". Si aquí aparecen filas 'enviado' o
-- 'error' (o avisos) en un hotel sin enlace, vienen de cuando tuvo una clave
-- de prueba y quedarían escondidas bajo "Registrado".

BEGIN READ ONLY;
SET LOCAL app.bypass_tenant_rls = 'on';

\echo '== estado_pui por hotel (y enlace actual) =='
SELECT h.id AS hotel_id,
       (h.gov_pui_clave IS NOT NULL AND NOT h.es_prueba) AS enlazado,
       c.estado_pui,
       COUNT(*) AS check_ins,
       MIN(c.fecha_checkin)::date AS desde,
       MAX(c.fecha_checkin)::date AS hasta
FROM check_ins c JOIN hoteles h ON h.id = c.hotel_id
GROUP BY 1, 2, 3
ORDER BY 1, 3;

\echo '== avisos (pui_notificaciones) por hotel, fase y estado =='
SELECT n.hotel_id, n.fase, n.estado, COUNT(*) AS avisos
FROM pui_notificaciones n
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

\echo '== valores de estado_pui fuera de los cuatro conocidos (deberían ser 0) =='
SELECT estado_pui, COUNT(*) FROM check_ins
WHERE estado_pui IS NULL OR estado_pui NOT IN ('pendiente', 'sin_reporte', 'enviado', 'error')
GROUP BY 1;

ROLLBACK;
