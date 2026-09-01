# Deploy kharab nikla — 2 minute me wapsi (rollback runbook)

> Bana: 1 Sep 2026 (audit B6 — "rollback ka tareeka kahin likha nahi tha").
> Cloud Monitoring ka "ResellerOS down" alert isi file ka naam leta hai.

## Kab use karna hai

Deploy ke baad app 500 de raha hai / page khali hai / `npm run verify:deploy`
`NAHI PADH SAKA` bol raha hai — aur wajah 2 minute me samajh nahi aa rahi.
**Pehle wapas jao, phir aaram se debug karo.** Purana revision Cloud Run par
rakha hi hota hai.

## Kadam (copy-paste)

1. Revisions dekho — sabse upar wala abhi traffic le raha hai:

```bash
gcloud run revisions list --service=resellersos --region=asia-south1 --limit=5
```

2. Pichhle (theek chal rahe) revision ka naam lo — list me doosri row — aur
   100% traffic use de do (NAAM badal kar):

```bash
gcloud run services update-traffic resellersos --region=asia-south1 --to-revisions=resellersos-00123-abc=100
```

3. 30 second baad tasdeeq — sha PURANA dikhna chahiye:

```bash
curl -s https://resellersos-njvk4nxhdq-el.a.run.app/api/version
```

4. Theek hone par wapas latest par aane ke liye:

```bash
gcloud run services update-traffic resellersos --region=asia-south1 --to-latest
```

## Do cheezein jo yaad rahen

- **Env vars revision ke saath jam jaate hain** — rollback purane env ke saath
  aata hai. Agar beech me koi var badla tha to wo bhi purana ho jayega.
- **Migrations wapas nahi hote.** Naye deploy ne DB badla tha to purana code
  naye schema par chalega — zyadatar theek, par money-RPC badla ho to pehle
  `supabase/tests` chala kar dekho (`npm run test:sql`).

## Rehearsal ka log

| Tareekh | Kisne | Nateeja |
|---|---|---|
| 1 Sep 2026 | Claude (audit B6) | ✅ 00460→00458→latest, dono taraf /api/version zinda; poora chakkar ~1 min. Bonus: usi din ek kharab startup-probe wali revision (00459) READY hi nahi bani aur traffic purani par tika raha — health-gate ka live saboot. |
