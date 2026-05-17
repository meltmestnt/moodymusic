import Script from "next/script";

export default function TgLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Telegram's Mini App SDK. beforeInteractive so window.Telegram is
       * already populated by the time the client component reads it on
       * mount, avoiding the polling fallback in useTelegramWebApp on
       * fast networks. */}
      <Script
        src="https://telegram.org/js/telegram-web-app.js"
        strategy="beforeInteractive"
      />
      {children}
    </>
  );
}
