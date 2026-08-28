# Inbound email → ERP (Gmail Apps Script forwarder)

**Goal:** Jab koi `pardeep@anutech.in` (ya kisi bhi connected Gmail/Workspace inbox)
par email kare, wo email ResellerOS ERP me pahunche → **Enquiries** inbox me dikhe →
genuine enquiry ho to apne-aap **Lead** ban jaye.

Ye tareeka Gmail ko **jaise-ka-taisa** rehne deta hai (koi MX/DNS badalna nahi padta).
Ek chhota Google Apps Script har kuch minute me nayi mail padh ke ERP ke webhook par
bhej deta hai, aur bheji hui mail ko ek label laga deta hai taaki dubara na jaye.

> **Secret kahin hardcode nahi hai.** Tum `INBOUND_EMAIL_SECRET` ko Apps Script ke
> **Script Properties** me paste karoge (main uski value kabhi handle nahi karta).

---

## Step 1 — Naya Apps Script project banao

1. [script.google.com](https://script.google.com) kholo (usi Google account se jisme inbox hai — `pardeep@anutech.in`).
2. **New project** → naam do: `ResellerOS Inbound Forwarder`.
3. Neeche wala poora code `Code.gs` me paste kar do (jo pehle se hai wo hata do):

```javascript
/**
 * ResellerOS — Gmail → ERP inbound-email forwarder.
 * Time-trigger par chalti hai: nayi inbox mail ERP webhook par POST karti hai,
 * phir thread par "ERP-Forwarded" label laga deti hai (dubara na bheje).
 * Secret Script Properties se aata hai — code me kabhi mat likhna.
 */
var WEBHOOK_URL     = 'https://resellersos-1005662057478.asia-south1.run.app/api/webhooks/inbound-email';
var PROCESSED_LABEL = 'ERP-Forwarded';

function forwardNewEmailsToERP() {
  var secret = PropertiesService.getScriptProperties().getProperty('INBOUND_EMAIL_SECRET');
  if (!secret) {
    throw new Error('Pehle Script Properties me INBOUND_EMAIL_SECRET set karo.');
  }

  var label = GmailApp.getUserLabelByName(PROCESSED_LABEL) || GmailApp.createLabel(PROCESSED_LABEL);

  // Pichhle 2 din ki inbox mail jo abhi tak forward nahi hui. (Zaroorat ho to badlo.)
  var threads = GmailApp.search('in:inbox -label:' + PROCESSED_LABEL + ' newer_than:2d', 0, 25);

  threads.forEach(function (thread) {
    var messages = thread.getMessages();
    var msg = messages[messages.length - 1]; // thread ka sabse naya message

    try {
      var payload = {
        from:      msg.getFrom(),
        subject:   msg.getSubject(),
        text:      msg.getPlainBody(),
        html:      msg.getBody(),
        messageId: msg.getId()
      };

      var res = UrlFetchApp.fetch(WEBHOOK_URL + '?key=' + encodeURIComponent(secret), {
        method:             'post',
        contentType:        'application/json',
        payload:            JSON.stringify(payload),
        muteHttpExceptions: true
      });

      var code = res.getResponseCode();
      if (code === 200) {
        thread.addLabel(label);            // safalta → dubara mat bhejo
      } else {
        Logger.log('Webhook ne ' + code + ' diya: ' + res.getContentText());
      }
    } catch (e) {
      Logger.log('Forward error: ' + e);
    }
  });
}
```

---

## Step 2 — Secret daalo (Script Properties)

1. Cloud Run console → service **resellersos** → **Edit & deploy new revision** →
   **Variables & Secrets** tab → `INBOUND_EMAIL_SECRET` ki value **copy** karo.
2. Apps Script me: baayein **⚙ Project Settings** → neeche **Script Properties** →
   **Add script property**:
   - **Property**: `INBOUND_EMAIL_SECRET`
   - **Value**: (jo abhi copy kiya) → **Save**.

---

## Step 3 — Ek baar chalao + authorize karo

1. Upar function dropdown me `forwardNewEmailsToERP` chuno → **Run**.
2. Google authorize maangega → apna account chuno → "Advanced" → allow
   (Gmail padhne + bahar fetch karne ki permission). Ye ek hi baar hota hai.
3. **Execution log** me error nahi aana chahiye.

---

## Step 4 — Har 5 minute ka auto-trigger lagao

1. Baayein **⏰ Triggers** → **Add Trigger**.
2. Settings:
   - Function: `forwardNewEmailsToERP`
   - Event source: **Time-driven**
   - Type: **Minutes timer** → **Every 5 minutes**
3. **Save**. Bas — ab ye apne aap chalti rahegi.

---

## Step 5 — Test

1. Kisi doosre account se `pardeep@anutech.in` par ek test email bhejo
   (subject: "Need Google Workspace for 10 users").
2. 5 min ke andar ERP → **Enquiries** me wo email dikhni chahiye.
3. Genuine enquiry hai → apne aap **Lead** ban jayegi (badge me bhi count aayega).
   Newsletter/notification jaisa kuch → "Not an enquiry" me dikhega, tum chaaho to
   **Convert to lead** kar sakte ho.

---

## Notes / limits (v1)

- **Ek thread = ek baar**: label thread par lagta hai, to usi thread ke baad wale
  reply skip ho sakte hain. Lekin webhook messageId se dedup karta hai aur reply ko
  usi lead me note ke roop me jod deta hai — is liye lead-level pe koi nuksan nahi.
- **Sab inbox mail jaati hai**: filter sirf date ka hai. Kachra (newsletters etc.)
  ERP me Gemini "Not an enquiry" me chhaant deta hai — ye inbox ka pura maqsad hai.
- Volume badhe to `newer_than:2d` / `25` limit adjust kar sakte ho.
- Secret rotate karo to Cloud Run **aur** Script Property dono jagah update karna.
