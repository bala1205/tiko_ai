-- Storage bucket for chat images

-- Create bucket chat-images (private)
insert into storage.buckets (id, name, public)
values ('chat-images', 'chat-images', false)
on conflict (id) do nothing;

-- Allow authenticated to manage storage.objects via policies
-- Enable RLS is already enabled on storage.objects

-- Policy: Users can upload to own folder: {userId}/{conversationId}/{filename}
drop policy if exists "Users can upload own chat images" on storage.objects;
create policy "Users can upload own chat images"
on storage.objects for insert
with check (
  bucket_id = 'chat-images'
  and auth.role() = 'authenticated'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users can view own chat images" on storage.objects;
create policy "Users can view own chat images"
on storage.objects for select
using (
  bucket_id = 'chat-images'
  and auth.role() = 'authenticated'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users can update own chat images" on storage.objects;
create policy "Users can update own chat images"
on storage.objects for update
using (
  bucket_id = 'chat-images'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'chat-images'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users can delete own chat images" on storage.objects;
create policy "Users can delete own chat images"
on storage.objects for delete
using (
  bucket_id = 'chat-images'
  and (storage.foldername(name))[1] = auth.uid()::text
);
