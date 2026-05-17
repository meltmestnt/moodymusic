// Minimal typings for the YouTube IFrame Player API. Loaded at runtime
// from https://www.youtube.com/iframe_api — at module load it installs
// a global `YT.Player` and triggers `window.onYouTubeIframeAPIReady`.
//
// Full reference:
// https://developers.google.com/youtube/iframe_api_reference

declare namespace YT {
  // Player state codes from PlayerState enum.
  // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued.
  enum PlayerState {
    UNSTARTED = -1,
    ENDED = 0,
    PLAYING = 1,
    PAUSED = 2,
    BUFFERING = 3,
    CUED = 5,
  }

  interface PlayerStateChangeEvent {
    data: number;
    target: Player;
  }

  interface PlayerErrorEvent {
    data: number;
    target: Player;
  }

  interface PlayerEventHandlers {
    onReady?: (event: { target: Player }) => void;
    onStateChange?: (event: PlayerStateChangeEvent) => void;
    onError?: (event: PlayerErrorEvent) => void;
  }

  interface PlayerOptions {
    height?: string | number;
    width?: string | number;
    videoId?: string;
    playerVars?: {
      autoplay?: 0 | 1;
      controls?: 0 | 1;
      modestbranding?: 0 | 1;
      rel?: 0 | 1;
      iv_load_policy?: 1 | 3;
      playsinline?: 0 | 1;
      origin?: string;
    };
    events?: PlayerEventHandlers;
  }

  interface Player {
    playVideo(): void;
    pauseVideo(): void;
    stopVideo(): void;
    seekTo(seconds: number, allowSeekAhead: boolean): void;
    loadVideoById(videoId: string): void;
    cueVideoById(videoId: string): void;
    setVolume(percent: number): void; // 0..100
    getVolume(): number;
    mute(): void;
    unMute(): void;
    isMuted(): boolean;
    getDuration(): number; // seconds
    getCurrentTime(): number; // seconds
    getPlayerState(): number;
    getVideoLoadedFraction(): number;
    destroy(): void;
    addEventListener(event: string, listener: string): void;
  }

  interface PlayerConstructor {
    new (
      hostElement: string | HTMLElement,
      options: PlayerOptions,
    ): Player;
  }
}

interface Window {
  YT?: { Player: YT.PlayerConstructor; PlayerState: typeof YT.PlayerState };
  onYouTubeIframeAPIReady?: () => void;
}
