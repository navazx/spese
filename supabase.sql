-- Da incollare una volta in Supabase: SQL Editor → New query → Run.
-- Una riga per ogni documento dell'app; ognuno vede e modifica solo le proprie righe.

create table if not exists public.documenti (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  path text not null,
  data jsonb not null,
  aggiornato timestamptz not null default now(),
  primary key (user_id, path)
);

alter table public.documenti enable row level security;

drop policy if exists "leggo i miei documenti" on public.documenti;
drop policy if exists "creo i miei documenti" on public.documenti;
drop policy if exists "modifico i miei documenti" on public.documenti;
drop policy if exists "cancello i miei documenti" on public.documenti;

create policy "leggo i miei documenti" on public.documenti for select to authenticated using ((select auth.uid()) = user_id);
create policy "creo i miei documenti" on public.documenti for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "modifico i miei documenti" on public.documenti for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "cancello i miei documenti" on public.documenti for delete to authenticated using ((select auth.uid()) = user_id);

-- aggiornamenti in tempo reale tra telefono e computer
do $$ begin
  alter publication supabase_realtime add table public.documenti;
exception when duplicate_object then null;
end $$;
