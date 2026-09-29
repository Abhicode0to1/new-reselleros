# Deploy kharab nikla — runbook ab `docs/ROLLBACK.md` me hai

> Ye file isliye bachi hai ki Cloud Monitoring ka "ResellerOS down" alert isi naam ko leta hai.
> **Poora runbook: [`ROLLBACK.md`](ROLLBACK.md)** (S18, 28 Sep 2026).

Yahan pehle wale commands `--region=asia-south1` bolte the. Service Cloud SQL move ke saath
**`asia-southeast1`** me hai, to wo commands ab "service not found" denge. Jaldi me ho to:

```bash
gcloud run revisions list --service=resellersos --region=asia-southeast1 --limit=5
gcloud run services update-traffic resellersos --region=asia-southeast1 --to-revisions=<pichhla-READY-revision>=100
curl -s https://reselleros.anutech.in/api/version     # sha PURANA dikhna chahiye
```

Theek hone ke baad `--to-latest` karna mat bhoolna — warna agla deploy traffic nahi lega.
Migrations wapas nahi hote (forward-fix) — `ROLLBACK.md` padho.
