"use client";

import { useEffect, useRef, useState } from "react";
import { IconButton } from "@radix-ui/themes";
import { showError } from "@/lib/toast";
import { useI18n } from "@/lib/i18n";

// Voice → text input via the Web Speech API (SpeechRecognition).
//
// Why Web Speech API instead of a Whisper-backed /api/transcribe endpoint:
//   • Zero server cost. Chrome/Edge/Safari ship a cloud recognizer that
//     supports en-US, uk-UA, ru-RU (the three the user asked for) at no
//     cost to us.
//   • Real-time interim results. As the user speaks, partial transcripts
//     update the textarea live — feels like a native dictation surface.
//   • No mic-stream plumbing. The browser handles audio capture,
//     endpointing, and silence detection; we only handle the text events.
//
// Tradeoffs:
//   • Firefox doesn't implement SpeechRecognition. We hide the button on
//     unsupported browsers rather than dangling a broken affordance.
//   • Recognition runs out of process; we don't get raw audio. That's
//     fine for a mood-input use case but rules out features like
//     "save the audio clip".

export type VoiceLang = "en-US" | "uk-UA" | "ru-RU";

const LANG_LABELS: Record<VoiceLang, string> = {
  "en-US": "EN",
  "uk-UA": "UK",
  "ru-RU": "RU",
};

const LANG_ORDER: VoiceLang[] = ["en-US", "uk-UA", "ru-RU"];

// Minimal SpeechRecognition shape — the browser globals aren't typed by
// default in lib.dom.d.ts (still a draft API), so we declare what we use.
interface SRResultAlternative {
  transcript: string;
}
interface SRResult {
  0: SRResultAlternative;
  isFinal: boolean;
}
interface SREvent {
  resultIndex: number;
  results: ArrayLike<SRResult>;
}
interface SRErrorEvent {
  error: string;
}
interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SRCtor = new () => SpeechRecognitionInstance;

function getRecognitionCtor(): SRCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SRCtor;
    webkitSpeechRecognition?: SRCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** Default is derived from the UI locale; users can override via the
   *  language pill. Persisting that choice is the parent's call. */
  defaultLang?: VoiceLang;
  disabled?: boolean;
}

export function VoiceInputButton({
  value,
  onChange,
  defaultLang,
  disabled,
}: Props) {
  const { t, locale } = useI18n();
  const [supported, setSupported] = useState(false);
  const [recording, setRecording] = useState(false);
  const [lang, setLang] = useState<VoiceLang>(
    defaultLang ?? (locale === "uk" ? "uk-UA" : "en-US"),
  );

  // Recognition instance + the textarea value at the moment recording
  // started — finalised transcripts are appended to THIS, not the live
  // value (which would feedback-loop with our own onChange writes).
  const recRef = useRef<SpeechRecognitionInstance | null>(null);
  const baseValueRef = useRef("");

  useEffect(() => {
    setSupported(getRecognitionCtor() !== null);
  }, []);

  // Stop any in-flight recognition on unmount so the mic LED doesn't stay
  // on after the user navigates away.
  useEffect(() => {
    return () => {
      recRef.current?.abort();
      recRef.current = null;
    };
  }, []);

  const stop = () => {
    recRef.current?.stop();
    // onend handler flips `recording` to false.
  };

  const start = () => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      showError(t("voice.unsupported"));
      return;
    }
    let rec: SpeechRecognitionInstance;
    try {
      rec = new Ctor();
    } catch {
      showError(t("voice.error"));
      return;
    }
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;

    baseValueRef.current = value;

    rec.onresult = (event) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]!;
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      // Final segments are committed to baseValueRef so subsequent
      // interim results don't overwrite them.
      if (final) {
        const sep =
          baseValueRef.current && !baseValueRef.current.endsWith(" ")
            ? " "
            : "";
        baseValueRef.current = (baseValueRef.current + sep + final).trimStart();
      }
      const sepInterim =
        baseValueRef.current && !baseValueRef.current.endsWith(" ") ? " " : "";
      const live = (baseValueRef.current + sepInterim + interim).trimStart();
      onChange(live);
    };
    rec.onerror = (event) => {
      // "no-speech" fires when the recognizer endpointed without hearing
      // anything — not actually an error from the user's POV. "aborted"
      // fires when we call .abort() on unmount; also silent.
      if (event.error === "no-speech" || event.error === "aborted") return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        showError(t("voice.permissionDenied"));
        return;
      }
      showError(t("voice.error"));
    };
    rec.onend = () => {
      setRecording(false);
      recRef.current = null;
    };
    try {
      rec.start();
    } catch {
      showError(t("voice.error"));
      return;
    }
    recRef.current = rec;
    setRecording(true);
  };

  const cycleLang = () => {
    const idx = LANG_ORDER.indexOf(lang);
    setLang(LANG_ORDER[(idx + 1) % LANG_ORDER.length]!);
    // If recording, restart with the new language. The browser only
    // applies `lang` at .start() time.
    if (recording) {
      recRef.current?.abort();
      // Slight async hop so onend lands before we kick off a new session
      // — otherwise Chrome rejects with InvalidStateError.
      window.setTimeout(() => start(), 50);
    }
  };

  if (!supported) return null;

  return (
    <div className="voice-input" data-recording={recording || undefined}>
      <button
        type="button"
        className="voice-input-lang"
        onClick={cycleLang}
        disabled={disabled}
        title={t("voice.langCycle")}
        aria-label={t("voice.langCycle")}
      >
        {LANG_LABELS[lang]}
      </button>
      <IconButton
        type="button"
        size="2"
        radius="full"
        variant={recording ? "solid" : "soft"}
        color={recording ? "red" : "gray"}
        onClick={recording ? stop : start}
        disabled={disabled}
        aria-pressed={recording}
        aria-label={recording ? t("voice.stop") : t("voice.start")}
        title={recording ? t("voice.stop") : t("voice.start")}
        className="voice-input-btn"
      >
        <MicSvg />
      </IconButton>
    </div>
  );
}

function MicSvg() {
  // 16×16 microphone glyph centered to match the IconButton size="2"
  // bounding box. Single path so currentColor inherits cleanly from
  // the IconButton's foreground.
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6" y="2" width="4" height="8" rx="2" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0" />
      <path d="M8 12v2.5" />
      <path d="M5.5 14.5h5" />
    </svg>
  );
}
