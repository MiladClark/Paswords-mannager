import {
  useLayoutEffect,
  useEffect,
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
import type { PinInfo } from "./api";
export function normalizePin(value: string) {
  return value
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 1632))
    .replace(/\D/g, "")
    .slice(0, 4);
}
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
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-heading">
        <h2 id={id}>{title}</h2>
        <IconButton label="Close / بستن" onClick={onClose} disabled={busy}>
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
  pin = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (s: string) => void;
  t: Translate;
  autoFocus?: boolean;
  minLength?: number;
  pin?: boolean;
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
          onChange={(e) =>
            onChange(pin ? normalizePin(e.target.value) : e.target.value)
          }
          required
          minLength={pin ? 4 : minLength}
          maxLength={pin ? 4 : 1024}
          inputMode={pin ? "numeric" : undefined}
          pattern={pin ? "[0-9]{4}" : undefined}
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          autoFocus={autoFocus}
        />
        <IconButton
          label={t(
            pin ? (visible ? "hidePin" : "showPin") : visible ? "hide" : "show",
          )}
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
  pin,
}: {
  exists: boolean;
  onUnlock: (password: string, method: "master" | "pin") => void;
  t: Translate;
  error: string;
  busy: boolean;
  pin: PinInfo;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const [method, setMethod] = useState<"master" | "pin">(
    exists && pin.enabled && pin.available && !pin.blocked ? "pin" : "master",
  );
  useEffect(() => {
    if (pin.blocked || !pin.available) {
      setMethod("master");
      setPassword("");
    }
  }, [pin.blocked, pin.available]);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!exists && password !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    onUnlock(password, method);
  }
  return (
    <main className="auth-page">
      <section className="auth-content">
        <div className="auth-emblem">
          <LockSimple size={28} weight="light" />
        </div>
        <h1>{t(exists ? "unlockTitle" : "createTitle")}</h1>
        <p className="auth-subtitle">
          {t(exists ? "unlockSubtitle" : "createSubtitle")}
        </p>
        <form onSubmit={submit} className="auth-form">
          {exists && pin.enabled && (
            <div className="auth-method" role="group" aria-label={t("unlock")}>
              <button
                type="button"
                aria-pressed={method === "pin"}
                disabled={!pin.available || pin.blocked || busy}
                onClick={() => {
                  setMethod("pin");
                  setPassword("");
                }}
              >
                {t("pin")}
              </button>
              <button
                type="button"
                aria-pressed={method === "master"}
                disabled={busy}
                onClick={() => {
                  setMethod("master");
                  setPassword("");
                }}
              >
                {t("useMaster")}
              </button>
            </div>
          )}
          <SecretInput
            id="master-password"
            label={t(method === "pin" ? "pin" : "master")}
            value={password}
            onChange={setPassword}
            t={t}
            minLength={exists ? undefined : 12}
            autoFocus
            pin={method === "pin"}
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
        {!exists && <p className="recovery-note">{t("noRecovery")}</p>}
        <div className="auth-reassurance">
          <ShieldCheck size={15} />
          <span>{t("encrypted")}</span>
          <span className="small-dot" />
          <span>{t("offline")}</span>
        </div>
      </section>
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
