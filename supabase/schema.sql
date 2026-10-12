-- Tabla de lecturas de sensores BLE (una fila por métrica y momento)
create table if not exists public.lecturas (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  recorded_at timestamptz not null,
  session_id  uuid not null,
  device_id   text not null,
  device_name text,
  metric      text not null,
  value       double precision not null
);

create index if not exists lecturas_device_time_idx on public.lecturas (device_id, recorded_at desc);
create index if not exists lecturas_metric_time_idx on public.lecturas (metric, recorded_at desc);

-- RLS: sin login aún, la app (rol anon) puede insertar y leer.
-- Cuando se agregue autenticación, reemplazar por políticas por usuario.
alter table public.lecturas enable row level security;

drop policy if exists "anon puede insertar lecturas" on public.lecturas;
create policy "anon puede insertar lecturas" on public.lecturas
  for insert to anon, authenticated with check (true);

drop policy if exists "anon puede leer lecturas" on public.lecturas;
create policy "anon puede leer lecturas" on public.lecturas
  for select to anon, authenticated using (true);
