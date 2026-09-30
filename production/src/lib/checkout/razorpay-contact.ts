/**
 * The mobile number as Razorpay's checkout wants it (30 Sep 2026).
 *
 * Checkout collects a 10-digit mobile and passed it to Razorpay as typed. Razorpay's window
 * then showed an empty mobile field and asked for the number again, which reads as the site
 * having lost what the customer just entered. It takes the number with the country code.
 *
 * Only the last 10 digits are kept, so "98765 43210", "+91 98765 43210" and "09876543210"
 * all become "+919876543210". Fewer than 10 digits is passed through as typed: that is not a
 * mobile number, and inventing one would put a stranger's number on the payment.
 */
export function razorpayContact(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? `+91${digits.slice(-10)}` : phone.trim();
}
