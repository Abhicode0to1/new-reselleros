/**
 * POST /api/push/test — send a test notification to the caller's own devices.
 *
 * Only ever to the caller. There is no `userId` in the body and there will not be one: a
 * "send a test" endpoint that accepts a target is a way to buzz a colleague's phone.
 *
 * It also reports what actually happened rather than a bare ok, because the interesting
 * outcomes are the quiet ones — VAPID keys missing, or the device never consented to this
 * category. "Sent 0" with no explanation is how somebody concludes push is broken when
 * they simply have not enabled it on this device.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendPushToUsers } from "@/lib/push/send";

export async function POST() {
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const result = await sendPushToUsers([auth.user.id], { kind: "test" });

  if (result.problem === "not-configured") {
    return NextResponse.json(
      {
        error: "Push is not configured on this server.",
        nextStep: "Set NEXT_PUBLIC_VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, then restart.",
      },
      { status: 503 },
    );
  }
  if (result.problem?.startsWith("vapid-rejected")) {
    return NextResponse.json(
      {
        error: "The push service rejected our signing key.",
        nextStep: "VAPID_PRIVATE_KEY does not match NEXT_PUBLIC_VAPID_PUBLIC_KEY — regenerate the pair.",
      },
      { status: 502 },
    );
  }
  /* Attempts were made and every one failed. This route said "no device is registered"
     here until a deliberately dead endpoint proved otherwise — which sends the operator to
     switch on something that is already on. "Nothing was sent" and "nothing is registered"
     are different facts, and the second one is the only one worth acting on. */
  if (result.sent === 0 && result.failed > 0) {
    return NextResponse.json(
      {
        error: `Could not deliver to ${result.failed} registered device${result.failed === 1 ? "" : "s"}.`,
        nextStep: result.pruned > 0
          ? "Some were dead and have been removed — turn notifications on again on that device."
          : "The push service refused the message. The server log has the status it returned.",
        ...result,
      },
      { status: 502 },
    );
  }

  if (result.sent === 0 && result.skippedByConsent > 0) {
    return NextResponse.json(
      {
        error: "This device has notifications off for work alerts.",
        nextStep: "Turn on notifications for this device and try again.",
      },
      { status: 409 },
    );
  }
  if (result.sent === 0) {
    return NextResponse.json(
      {
        error: "No device is registered for notifications yet.",
        nextStep: "Turn notifications on for this device first.",
      },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, ...result });
}
