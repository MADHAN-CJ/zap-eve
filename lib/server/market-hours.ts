const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/** NSE cash-market hours: 09:15–15:30 IST, Mon–Fri (holidays not modeled). */
export function isNseMarketOpen(now: Date = new Date()): boolean {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}
