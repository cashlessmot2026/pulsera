-- 1) Corrige fechas de registros SMA (JW-10) leídos con el orden de bytes invertido.
--    La pulsera manda segundos desde 2000-01-01 en big-endian y en hora local (America/Bogota).
update public.lecturas l
set recorded_at = (to_timestamp(
      (((s.r & 255) << 24) | (((s.r >> 8) & 255) << 16) | (((s.r >> 16) & 255) << 8) | ((s.r >> 24) & 255)) + 946684800
    ) at time zone 'UTC') at time zone 'America/Bogota'
from (
  select id, (extract(epoch from recorded_at)::bigint - 946684800) as r
  from public.lecturas
  where abs(extract(epoch from recorded_at - created_at)) > 172800  -- a más de 2 días de cuándo se guardó
) s
where l.id = s.id;

-- 2) Elimina duplicados exactos (mismo dispositivo, métrica, fecha y valor), conservando el primero.
delete from public.lecturas a
using public.lecturas b
where a.id > b.id
  and a.device_id = b.device_id
  and a.metric = b.metric
  and a.recorded_at = b.recorded_at
  and a.value = b.value;

-- 3) Evita duplicados futuros (la app inserta con ON CONFLICT DO NOTHING).
create unique index if not exists lecturas_unicas
  on public.lecturas (device_id, metric, recorded_at, value);

select metric, count(*) as filas, min(recorded_at) as desde, max(recorded_at) as hasta
from public.lecturas group by metric order by filas desc;
