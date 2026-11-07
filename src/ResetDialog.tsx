import { useState, type FormEvent } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { RESET_CONFIRMATION } from "./api";
import { Dialog, SecretInput, type Translate } from "./ui";

export default function ResetDialog({
  t,
  busy,
  error,
  onClose,
  onReset,
}: {
  t: Translate;
  busy: boolean;
  error: string;
  onClose: () => void;
  onReset: (confirmation: string, master: string) => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [master, setMaster] = useState("");
  const [passwordStep, setPasswordStep] = useState(false);
  const confirmed = confirmation.trim() === RESET_CONFIRMATION;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !confirmed) return;
    if (!passwordStep) {
      setPasswordStep(true);
    } else if (master) {
      void onReset(confirmation, master);
      setMaster("");
    }
  }

  return (
    <Dialog title={t("resetTitle")} busy={busy} onClose={onClose}>
      <form className="dialog-form" onSubmit={submit}>
        <p>{t("resetWarning")}</p>
        <p>{t("resetBackupWarning")}</p>
        {passwordStep ? (
          <SecretInput
            key="master"
            id="reset-master"
            label={t("master")}
            value={master}
            onChange={setMaster}
            t={t}
            autoFocus
          />
        ) : (
          <div className="form-field">
            <label htmlFor="reset-confirmation">
              {t("resetConfirmationLabel")}
            </label>
            <input
              id="reset-confirmation"
              dir="auto"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              maxLength={24}
              autoFocus
              required
            />
          </div>
        )}
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
            onClick={onClose}
          >
            {t("resetBackToSettings")}
          </button>
          <button
            type="submit"
            className={passwordStep ? "primary reset-button" : "primary"}
            disabled={busy || !confirmed || (passwordStep && !master)}
          >
            {busy && <CircleNotch className="spin" />}
            {t(passwordStep ? "resetAction" : "cloudContinue")}
          </button>
        </div>
        {busy && <p role="status">{t("resetInProgress")}</p>}
      </form>
    </Dialog>
  );
}
