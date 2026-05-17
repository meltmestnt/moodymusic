"use client";

import { useEffect, useRef } from "react";
import { usePlayer } from "@/lib/player-context";
import { useTrackInfo } from "@/lib/track-info-context";

interface EqualizerProps {
  bars?: number;
  // How far the inner edge of each bar sits from the wrap's vertical centre,
  // expressed as a percentage of the wrap's height. With the album art inset
  // by `--eq-inner` from the wrap edges, 36 puts the bar's inner edge right
  // at the art rim and lets bars bloom outward into the corners of the card.
  innerRadius?: number;
}

// Smoothing factor when easing bar heights toward the new analyser value.
// Lower = snappier (jittery), higher = silkier but laggier. 0.55 looks alive
// without flickering on percussive tracks.
const EASE = 0.55;

// Procedural shimmer used when no analyser is available (SDK mode, or before
// the first play). We layer three sines at different frequencies + a slow
// rotational phase so neighbouring bars look different and the whole ring
// drifts. Values look hand-picked because they are.
function proceduralAmplitude(bar: number, totalBars: number, t: number) {
  const phase = (bar / totalBars) * Math.PI * 2;
  const a = 0.45 + 0.35 * Math.sin(phase * 2 + t * 0.0024);
  const b = 0.25 * Math.sin(phase * 5 - t * 0.0041);
  const c = 0.15 * Math.sin(phase * 9 + t * 0.0075);
  // Clamp into [0.05, 1] so even the lulls have a visible bar.
  return Math.max(0.05, Math.min(1, a + b + c));
}

export function Equalizer({ bars = 64, innerRadius = 36 }: EqualizerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { analyser, isPlaying } = usePlayer();
  const { selected: trackInfoOpen } = useTrackInfo();

  useEffect(() => {
    // Pause the rAF loop while the track-info modal is open. The
    // equalizer is occluded by the modal anyway, so animating 64 DOM
    // nodes at 60fps in the background just steals frames from the
    // morph and the dialog's backdrop-filter blur. This is the single
    // biggest perf win on Library — 64 inline-style writes per frame
    // were competing with the View Transition for main-thread time.
    if (trackInfoOpen) return;
    const root = containerRef.current;
    if (!root) return;
    const elements = Array.from(
      root.querySelectorAll<HTMLElement>(".equalizer-bar"),
    );
    if (elements.length === 0) return;

    // Smoothed amplitude per bar — eased toward the live target each frame
    // so heights glide instead of snapping.
    const smoothed = new Float32Array(elements.length);

    const buffer = analyser
      ? new Uint8Array(analyser.frequencyBinCount)
      : null;

    let raf = 0;
    const start = performance.now();

    const loop = () => {
      if (analyser && buffer) {
        analyser.getByteFrequencyData(buffer);
        // Use the lower 70% of the spectrum — the upper end is mostly silent
        // for typical music and would leave half the ring flat.
        const usable = Math.floor(buffer.length * 0.7);
        for (let i = 0; i < elements.length; i++) {
          // Symmetrical mapping: bars 0..N/2 go up the spectrum, N/2..N come
          // back down. Result is a left-right mirrored ring that feels like
          // a real EQ rather than a one-sided sweep.
          const half = elements.length / 2;
          const k = i < half ? i : elements.length - 1 - i;
          const idx = Math.min(usable - 1, Math.floor((k / half) * usable));
          const target = (buffer[idx] ?? 0) / 255;
          smoothed[i] = smoothed[i]! * EASE + target * (1 - EASE);
        }
      } else {
        const t = performance.now() - start;
        for (let i = 0; i < elements.length; i++) {
          const target = isPlaying
            ? proceduralAmplitude(i, elements.length, t)
            : 0.18 + 0.05 * Math.sin(t * 0.002 + i * 0.4);
          smoothed[i] = smoothed[i]! * EASE + target * (1 - EASE);
        }
      }

      for (let i = 0; i < elements.length; i++) {
        const v = smoothed[i]!;
        const el = elements[i]!;
        // 6px floor + up to 30px peak — large enough to see, capped so the
        // longest bars don't overshoot the ring's outer edge.
        el.style.setProperty("--eq-h", `${(6 + v * 30).toFixed(1)}px`);
        el.style.setProperty("--eq-o", `${(0.4 + v * 0.6).toFixed(2)}`);
      }

      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [analyser, isPlaying, trackInfoOpen]);

  return (
    <div
      ref={containerRef}
      className="equalizer"
      aria-hidden="true"
      style={{ ["--eq-inner" as string]: `${innerRadius}%` }}
    >
      <div className="equalizer-halo" />
      {Array.from({ length: bars }).map((_, i) => {
        const angle = (360 / bars) * i;
        return (
          // Each bar lives inside a same-size square that we rotate to its
          // angular slot. The bar itself is anchored by its bottom edge at
          // (50% - --eq-inner) from the top of the wrap, so growing height
          // pushes the OUTER edge further from the centre while the inner
          // edge stays pinned to the album-art rim.
          <div
            key={i}
            className="equalizer-ray"
            style={{ transform: `rotate(${angle}deg)` }}
          >
            <span className="equalizer-bar" />
          </div>
        );
      })}
    </div>
  );
}
