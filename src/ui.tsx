import {
  useContext,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  CircleNotch,
  Eye,
  EyeSlash,
  LockSimple,
  ShieldCheck,
  X,
} from "@phosphor-icons/react";
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
}: {
  id: string;
  label: string;
  value: string;
  onChange: (s: string) => void;
  t: Translate;
  autoFocus?: boolean;
  minLength?: number;
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
        />
        <IconButton
          label={t(visible ? "hide" : "show")}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeSlash /> : <Eye />}
        </IconButton>
      </div>
    </div>
  );
}
export function Auth({
  exists,
  onUnlock,
  t,
  error,
  busy,
  extensionInstall,
}: {
  exists: boolean;
  onUnlock: (password: string) => void;
  t: Translate;
  error: string;
  busy: boolean;
  extensionInstall?: ReactNode;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!exists && password !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    onUnlock(password);
  }
  return (
    <main className="auth-page">
      <section className="auth-content">
        <h1>{t(exists ? "unlockTitle" : "createTitle")}</h1>
        <form onSubmit={submit} className="auth-form">
          <SecretInput
            id="master-password"
            label={t("master")}
            value={password}
            onChange={setPassword}
            t={t}
            minLength={exists ? undefined : 12}
            autoFocus
          />
          {!exists && (
            <>
              <p className="field-help">{t("masterHint")}</p>
              <SecretInput
                id="confirm-password"
                label={t("confirm")}
                value={confirm}
                onChange={setConfirm}
                t={t}
                minLength={12}
              />
            </>
          )}
          {(error || mismatch) && (
            <p className="form-error" role="alert">
              {mismatch ? t("mismatch") : error}
            </p>
          )}
          <button type="submit" className="primary auth-submit" disabled={busy}>
            {busy ? <CircleNotch className="spin" /> : <LockSimple />}
            {t(busy ? "working" : exists ? "unlock" : "create")}
          </button>
        </form>
        <div className="auth-reassurance">
          <ShieldCheck size={15} />
          <span>{t("encrypted")}</span>
          <span className="small-dot" />
          <span>{t("offline")}</span>
        </div>
      </section>
      {extensionInstall}
      <p className="early-note">{t("securityNote")}</p>
    </main>
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
