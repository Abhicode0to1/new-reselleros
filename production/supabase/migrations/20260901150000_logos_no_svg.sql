-- logos bucket ab SVG nahi leta (audit C1/C5-sec, 1 Sep 2026).
--
-- logos ek-matra PUBLIC bucket hai, aur svg+xml uske allowlist me tha — SVG
-- me <script> chal sakta hai, to public URL stored-XSS ka raasta ban jata
-- tha. Naapa: bucket me aaj sirf PNG pade hain (2 objects), isliye ye
-- kisi maujooda logo ko nahi todta. WebP list me pehle se nahi tha.

update storage.buckets
   set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
 where id = 'logos';
