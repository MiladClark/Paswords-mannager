import { useState, type FormEvent } from "react";
import { Dialog, SecretInput, type Translate } from "./ui";
export interface BrowserFill {
  id: string;
  origin: string;
  title: string;
  username: string;
  expiresAt: number;
}
export default function BrowserFillDialog({
  request,
  t,
  busy,
  error,
  onDecide,
}: {
  request: BrowserFill;
  t: Translate;
  busy: boolean;
  error: string;
  onDecide: (allow: boolean, secret: string) => Promise<void>;
}) {
  const [secret, setSecret] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    await onDecide(true, secret);
  }
  return (
    <Dialog
      title={t("approveBrowserFill")}
      busy={busy}
      onClose={() => void onDecide(false, "")}
    >
      <form className="dialog-form" onSubmit={(event) => void submit(event)}>
        <div className="browser-fill-target">
          <strong dir="ltr">{request.origin}</strong>
          <span dir="auto">{request.title}</span>
          <small dir="auto">{request.username}</small>
        </div>
        <p>{t("browserFillHint")}</p>
        <SecretInput
          id="browser-fill-secret"
          label={t("master")}
          value={secret}
          onChange={setSecret}
          t={t}
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
            onClick={() => void onDecide(false, "")}
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
