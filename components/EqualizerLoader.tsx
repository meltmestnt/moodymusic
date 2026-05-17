"use client";

import { Text } from "@radix-ui/themes";

interface EqualizerLoaderProps {
  // active: bars pulsing.
  // exiting: data arrived, run the burst-out animation. Pair with a setTimeout
  // on the caller (~320ms) before unmounting so the keyframe finishes.
  state: "active" | "exiting";
  label: string;
}

// Glowing equalizer + halo + label. Used on /discover and /library while a
// fetch is in flight; on data arrival the parent flips state to "exiting" to
// trigger the scale-up + blur exit, then unmounts after the keyframe ends.
// Styles live in app/globals.css under the `.discover-loader*` selectors.
export function EqualizerLoader({ state, label }: EqualizerLoaderProps) {
  return (
    <div
      className="discover-loader"
      data-leaving={state === "exiting" || undefined}
      role="status"
      aria-label={label}
    >
      <div className="discover-loader-halo" aria-hidden />
      <div className="discover-loader-eq" aria-hidden>
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <Text size="2" color="gray" className="discover-loader-text">
        {label}
      </Text>
    </div>
  );
}
