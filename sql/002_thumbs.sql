-- Step 1 (previews): run once in Supabase > SQL Editor. Additive only: nothing existing is changed or migrated.
-- A public bucket for preview images. File names are random UUIDs; images are copies of public web previews.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('thumbs', 'thumbs', true, 10485760, array['image/jpeg','image/png','image/webp','image/gif','image/avif'])
on conflict (id) do nothing;

-- Members who can edit may upload their own images from the app (paste or pick a photo).
-- The preview function writes with the service role, so it does not need this policy.
drop policy if exists thumbs_insert on storage.objects;
create policy thumbs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'thumbs' and public.can_edit());
