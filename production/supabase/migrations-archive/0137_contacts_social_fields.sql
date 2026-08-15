-- 0137_contacts_social_fields.sql
-- Rich person-profile fields on the standalone contacts table, so the owner can
-- keep full detail for people they market to (social + email) and meet in person
-- (address). Additive + nullable — existing rows and importers are unaffected.

alter table public.contacts
  add column if not exists whatsapp  text,
  add column if not exists linkedin  text,
  add column if not exists instagram text,
  add column if not exists facebook  text,
  add column if not exists twitter   text,
  add column if not exists website   text,
  add column if not exists address   text,
  add column if not exists city      text;
