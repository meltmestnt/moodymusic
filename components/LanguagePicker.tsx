"use client";

import { Button, DropdownMenu } from "@radix-ui/themes";
import { GlobeIcon } from "@radix-ui/react-icons";
import { LOCALES, useI18n, type Locale } from "@/lib/i18n";

export function LanguagePicker() {
  const { locale, setLocale, t } = useI18n();
  const current = LOCALES.find((l) => l.value === locale) ?? LOCALES[0];

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <Button
          variant="ghost"
          color="gray"
          size="2"
          aria-label={t("language.label")}
        >
          <GlobeIcon />
          {current.short}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        <DropdownMenu.RadioGroup
          value={locale}
          onValueChange={(v) => setLocale(v as Locale)}
        >
          {LOCALES.map((l) => (
            <DropdownMenu.RadioItem key={l.value} value={l.value}>
              {l.label}
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
