import { useEffect, useState, type FormEvent } from "react";
import { Dialog, SecretInput, type Translate } from "./ui";
import type { PinInfo } from "./api";
export interface BrowserFill {
  id: string;
  origin: string;
  title: string;
  username: string;
  expiresAt: number;
}
export default function BrowserFillDialog({
  request,
  pin,
  t,
  busy,
  error,
  onDecide,
}: {
  request: BrowserFill;
  pin: PinInfo;
  t: Translate;
  busy: boolean;
  error: string;
  onDecide: (allow: boolean, secret: string, method: string) => Promise<void>;
}) {
  const [secret, setSecret] = useState("");
  const [method, setMethod] = useState<"pin" | "master">(
    pin.enabled && pin.available && !pin.blocked ? "pin" : "master",
  );
  useEffect(() => {
    if (pin.blocked || !pin.available) {
      setMethod("master");
      setSecret("");
    }
  }, [pin.blocked, pin.available]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    await onDecide(true, secret, method);
  }
  return (
    <Dialog
      title={t("approveBrowserFill")}
      busy={busy}
      onClose={() => void onDecide(false, "", method)}
    >
      <form className="dialog-form" onSubmit={(event) => void submit(event)}>
        <div className="browser-fill-target">
          <strong dir="ltr">{request.origin}</strong>
          <span dir="auto">{request.title}</span>
          <small dir="auto">{request.username}</small>
        </div>
        <p>{t("browserFillHint")}</p>
        {pin.enabled && (
          <div
            className="auth-method"
            role="group"
            aria-label={t("approveBrowserFill")}
          >
            <button
              type="button"
              disabled={busy || !pin.available || pin.blocked}
              aria-pressed={method === "pin"}
              onClick={() => {
                setMethod("pin");
                setSecret("");
              }}
            >
              {t("pin")}
            </button>
            <button
              type="button"
              disabled={busy}
              aria-pressed={method === "master"}
              onClick={() => {
                setMethod("master");
                setSecret("");
              }}
            >
              {t("master")}
            </button>
          </div>
        )}
        <SecretInput
          id="browser-fill-secret"
          label={t(method === "pin" ? "pin" : "master")}
          value={secret}
          onChange={setSecret}
          t={t}
          pin={method === "pin"}
          autoFocus
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-footer">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void onDecide(false, "", method)}
          >
            {t("cancel")}
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {t("approveFill")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
