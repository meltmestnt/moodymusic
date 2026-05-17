// Minimal typings for SoundCloud's Widget JS API. Loaded at runtime
// from https://w.soundcloud.com/player/api.js — at module load it
// installs a global `SC.Widget` factory that wraps an <iframe> in a
// player-control object.
//
// Full reference: https://developers.soundcloud.com/docs/api/html5-widget

declare namespace SC {
  interface WidgetEvents {
    READY: "ready";
    PLAY: "play";
    PAUSE: "pause";
    FINISH: "finish";
    PLAY_PROGRESS: "playProgress";
    LOAD_PROGRESS: "loadProgress";
    ERROR: "error";
  }

  interface PlayProgressEvent {
    currentPosition: number; // ms
    loadedProgress: number; // 0..1
    relativePosition: number; // 0..1
  }

  interface CurrentSound {
    id: number;
    title: string;
    duration: number; // ms
    permalink_url: string;
    artwork_url: string | null;
    user?: { username: string; full_name?: string };
  }

  interface WidgetPlayer {
    bind<E extends keyof WidgetEvents>(
      event: WidgetEvents[E],
      cb: (data?: unknown) => void,
    ): void;
    unbind<E extends keyof WidgetEvents>(event: WidgetEvents[E]): void;
    load(url: string, options?: { auto_play?: boolean; show_artwork?: boolean }): void;
    play(): void;
    pause(): void;
    toggle(): void;
    seekTo(ms: number): void;
    setVolume(percent: number): void; // 0..100
    next(): void;
    prev(): void;
    getDuration(cb: (ms: number) => void): void;
    getPosition(cb: (ms: number) => void): void;
    getVolume(cb: (percent: number) => void): void;
    isPaused(cb: (paused: boolean) => void): void;
    getCurrentSound(cb: (sound: CurrentSound | null) => void): void;
  }

  interface WidgetFactory {
    (iframe: HTMLIFrameElement | string): WidgetPlayer;
    Events: WidgetEvents;
  }
}

interface Window {
  SC?: { Widget: SC.WidgetFactory };
}
