-- Remote kill-switch for PACS CHX licenses, reusing the revocation-check
-- mechanism already implemented in server/src/license.js (checkRevocation).
-- No payment gateway involved: revoke a clinic manually here (or via any
-- future admin tool) and its server deactivates itself on the next check.

create table if not exists public.license_revocations (
  license_hash text primary key,
  revoked boolean not null default false,
  clinic_name text,
  reason text,
  updated_at timestamptz not null default now()
);

alter table public.license_revocations enable row level security;

-- Every PACS CHX install polls this with the publishable/anon key, so read
-- access has to stay public. Nothing sensitive is exposed: license_hash is a
-- one-way sha256 of the license key, not the key itself.
drop policy if exists "license_revocations_select_all" on public.license_revocations;
create policy "license_revocations_select_all"
  on public.license_revocations
  for select
  to anon, authenticated
  using (true);

-- No insert/update/delete policy for anon/authenticated on purpose: rows are
-- only ever changed from the Supabase dashboard (Table Editor / SQL editor)
-- using your own project-owner session, which bypasses RLS entirely.

create or replace function public.set_license_revocations_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_license_revocations_updated_at on public.license_revocations;
create trigger set_license_revocations_updated_at
  before update on public.license_revocations
  for each row
  execute function public.set_license_revocations_updated_at();

-- RPC used by checkRevocation() in license.js. Marked STABLE so PostgREST
-- also accepts it as a plain GET with a query-string argument, matching the
-- existing fetch() call there (no request body needed).
create or replace function public.check_license_revoked(p_hash text)
returns boolean
language sql
stable
as $$
  select coalesce(
    (select revoked from public.license_revocations where license_hash = p_hash),
    false
  );
$$;

grant execute on function public.check_license_revoked(text) to anon, authenticated;
