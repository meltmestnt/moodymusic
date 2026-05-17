"use client";

import { Card, Flex, Heading, Text } from "@radix-ui/themes";
import { formatCountdown } from "@/lib/format";

// ─── ThrottleCard ─────────────────────────────────────────────────────────
//
// Big circular progress ring around a live-ticking second counter. The
// ring's stroke-dashoffset is a CSS transition keyed by remaining seconds
// so it visibly drains over the wait. The number itself re-mounts on
// every tick (React `key={remainingSec}`), letting CSS replay a tiny
// pop-in animation each second so the digit reads as alive instead of a
// static label.
//
// Originally lived inline on the discover page; lifted here so the mood
// page (and any future surface that needs to surface a "wait N seconds"
// state) can render the same polished card.

const RING_RADIUS = 44;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

interface Props {
  remainingSec: number;
  totalSec: number;
  title: string;
  body: string;
}

export function ThrottleCard({ remainingSec, totalSec, title, body }: Props) {
  // Progress = how much of the wait is LEFT (1 → full ring, 0 → empty).
  const progress = totalSec > 0 ? remainingSec / totalSec : 0;
  const dashOffset = RING_CIRCUMFERENCE * (1 - progress);

  return (
    <Card size="3" className="discover-throttle-card">
      <Flex direction="column" align="center" gap="4" py="5" px="4">
        <div className="discover-throttle-ring" aria-hidden>
          {/* Larger SVG so a 5-character MM:SS readout (e.g. "59:59") has
            * breathing room inside the ring. The viewBox stays 0..100;
            * width/height drives the rendered size. */}
          <svg viewBox="0 0 100 100" width="180" height="180">
            <circle
              cx="50"
              cy="50"
              r={RING_RADIUS}
              fill="none"
              stroke="var(--gray-5)"
              strokeWidth="5"
            />
            <circle
              cx="50"
              cy="50"
              r={RING_RADIUS}
              fill="none"
              stroke="var(--accent-9)"
              strokeWidth="5"
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
              transform="rotate(-90 50 50)"
              style={{ transition: "stroke-dashoffset 1000ms linear" }}
            />
          </svg>
          <div
            className="discover-throttle-num-wrap"
            data-wide={remainingSec >= 60 || undefined}
          >
            {/* key={remainingSec} re-mounts the span on each tick so the
              * CSS pop-in animation replays. The aria-live handle goes on
              * the wrap so screen-readers announce "12, 11, 10…" once.
              * formatCountdown switches to MM:SS once we cross a minute,
              * keeping the readout legible during a 30-min wait. */}
            <span
              className="discover-throttle-num"
              key={remainingSec}
              aria-live="polite"
              aria-atomic="true"
            >
              {formatCountdown(remainingSec)}
            </span>
          </div>
        </div>
        <Flex direction="column" align="center" gap="1">
          <Heading size="5" weight="bold">
            {title}
          </Heading>
          <Text size="2" color="gray" align="center" style={{ maxWidth: 380 }}>
            {body}
          </Text>
        </Flex>
      </Flex>
    </Card>
  );
}
