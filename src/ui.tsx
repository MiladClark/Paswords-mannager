import {
  useContext,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Eye, EyeSlash, X } from "@phosphor-icons/react";
import type { Key } from "./i18n";
import { ExitingContext } from "./MotionPresence";
export type Translate = (key: Key) => string;
export function IconButton({
  label,
  children,
  onClick,
  disabled,
  pressed,
  className = "",
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function Dialog({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const exiting = useContext(ExitingContext);
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const el = ref.current!;
    el.showModal();
    el.querySelector<HTMLElement>("[data-dialog-autofocus]")?.focus();
    return () => el.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      data-exiting={exiting || undefined}
      inert={exiting}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-heading">
        <h2 id={id}>{title}</h2>
        <IconButton label="Close" onClick={onClose} disabled={busy}>
          <X />
        </IconButton>
      </div>
      {children}
    </dialog>
  );
}
export function SecretInput({
  id,
  label,
  value,
  onChange,
  t,
  autoFocus = false,
  minLength,
  disabled = false,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (s: string) => void;
  t: Translate;
  autoFocus?: boolean;
  minLength?: number;
  disabled?: boolean;
  hint?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <div className="input-action">
        <input
          id={id}
          name={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          minLength={minLength}
          maxLength={1024}
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          autoFocus={autoFocus}
          data-dialog-autofocus={autoFocus || undefined}
          disabled={disabled}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        <IconButton
          label={t(visible ? "hide" : "show")}
          disabled={disabled}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeSlash /> : <Eye />}
        </IconButton>
      </div>
      {hint && (
        <p id={`${id}-hint`} className="field-help">
          {hint}
        </p>
      )}
    </div>
  );
}
export function CloudSwitch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="cloud-switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
export function initials(title: string) {
  return Array.from(title.trim())[0]?.toLocaleUpperCase() || "·";
}
export function SiteIcon({
  title,
  favicon,
  large = false,
}: {
  title: string;
  favicon?: string;
  large?: boolean;
}) {
  const [failed, setFailed] = useState("");
  const safe =
    !!favicon &&
    favicon.length <= 12_288 &&
    /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(favicon);
  return (
    <span className={`monogram${large ? " large" : ""}`} aria-hidden="true">
      {safe && failed !== favicon ? (
        <img
          src={favicon}
          alt=""
          draggable={false}
          onError={() => setFailed(favicon)}
        />
      ) : (
        initials(title)
      )}
    </span>
  );
}
