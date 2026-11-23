import { languages, setLocale, useLocale, type Locale } from "./i18n";
import "./language-selector.css";
export function LanguageSelector() {
  const locale = useLocale();
  return (
    <label className="language-selector">
      <span aria-hidden="true">🌐</span>
      <select
        aria-label="Language / 언어"
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
      >
        {Object.entries(languages).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}
