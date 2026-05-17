// Compact human-readable wait formatter — "45s" / "5m" / "1h 5m". Used
// wherever we surface a "try again in …" duration to the user. Anything
// past 60s gets minutes (rounded up so we never tell the user they can
// retry sooner than they actually can); past an hour we add the hour.
export function formatWait(seconds: number): string {
  if (seconds <= 0) return "0s";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.ceil((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// MM:SS countdown for live-ticking displays (e.g. the discover throttle
// card's big number). Falls back to plain seconds for waits under a
// minute so a 30-second wait doesn't render as "0:30".
export function formatCountdown(seconds: number): string {
  if (seconds < 60) return String(seconds);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
