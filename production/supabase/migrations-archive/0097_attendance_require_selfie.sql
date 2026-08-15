-- 0097: Require a selfie to mark attendance (anti buddy-punching).
--
-- PIN alone is shareable — a colleague who knows your PIN could mark you
-- present. Requiring a selfie means every mark carries a photo of who actually
-- did it, so buddy-punching is deterred (the photo would show the wrong face).
-- Enforced server-side in /api/attendance/mark. Default ON; owner can toggle.
-- On a shared office kiosk the camera is granted once, so it stays seamless.

alter table public.attendance_settings
  add column if not exists require_selfie boolean not null default true;
