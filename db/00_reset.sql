-- =====================================================================
-- 00_reset.sql — clear the public schema before installing V1.
--
-- Nothing is deleted: every existing table and view in `public` is MOVED
-- into a schema called backup_20260924, data included. The public schema
-- is then empty and 01_schema.sql can create the V1 tables cleanly.
--
-- To look at old data later:   select * from backup_20260924.intents;
-- To delete the backup for good (only once you're sure):
--   drop schema backup_20260924 cascade;
-- =====================================================================
create schema if not exists backup_20260924;

do $$
declare r record;
begin
  -- views first, then tables (tables carry their indexes, triggers and sequences with them)
  for r in
    select c.relname, c.relkind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('v','m','r','p')
      and not exists (select 1 from pg_depend d            -- skip objects owned by extensions
                      where d.objid = c.oid and d.deptype = 'e')
    order by case c.relkind when 'v' then 1 when 'm' then 2 else 3 end, c.relname
  loop
    if r.relkind = 'v' then
      execute format('alter view public.%I set schema backup_20260924', r.relname);
    elsif r.relkind = 'm' then
      execute format('alter materialized view public.%I set schema backup_20260924', r.relname);
    else
      execute format('alter table public.%I set schema backup_20260924', r.relname);
    end if;
    raise notice 'moved %', r.relname;
  end loop;
end $$;

-- check: this should return no rows
select table_name, table_type from information_schema.tables where table_schema = 'public';
