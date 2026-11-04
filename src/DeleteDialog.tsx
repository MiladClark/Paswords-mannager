import { useState, type FormEvent } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { DELETE_CONFIRMATION, type Entry } from "./api";
import { Dialog, SecretInput, type Translate } from "./ui";

interface Props {
  entry: Entry;
  t: Translate;
  busy: boolean;
  error: string;
  onBusy: (value: boolean) => void;
  onError: (cause: unknown) => void;
  onClose: () => void;
  onDelete: (
    confirmation: string,
    confirmationRepeat: string,
    master: string,
  ) => Promise<void>;
}
export default function DeleteDialog({
  entry,
  t,
  busy,
  error,
  onBusy,
  onError,
  onClose,
  onDelete,
}: Props) {
  const [verify, setVerify] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [confirmationRepeat, setConfirmationRepeat] = useState("");
  const [master, setMaster] = useState("");
  const confirmed =
    confirmation === DELETE_CONFIRMATION &&
    confirmationRepeat === DELETE_CONFIRMATION;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !confirmed) return;
    onError("");
    if (!verify) {
      setVerify(true);
      return;
    }
    onBusy(true);
    try {
      await onDelete(confirmation, confirmationRepeat, master);
    } catch (cause) {
      setMaster("");
      onError(cause);
    } finally {
      onBusy(false);
    }
  }
  return (
    <Dialog
      title={t(verify ? "deleteMasterTitle" : "deleteTitle")}
      busy={busy}
      onClose={onClose}
    >
      <form className="dialog-form" onSubmit={submit}>
        <div className="confirmation-object" dir="auto">
          {entry.title}
        </div>
        {verify ? (
          <>
            <p>{t("deleteMasterHint")}</p>
            <SecretInput
              id="delete-master"
              label={t("master")}
              value={master}
              onChange={setMaster}
              t={t}
              autoFocus
            />
          </>
        ) : (
          <>
            <p>{t("deleteBody")}</p>
            <p>{t("deleteConfirmHint")}</p>
            <p className="delete-consent-phrase" lang="en" dir="ltr">
              {DELETE_CONFIRMATION}
            </p>
            <div className="form-field">
              <label htmlFor="delete-confirmation">
                {t("deleteConfirmation")}
              </label>
              <input
                id="delete-confirmation"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
                autoFocus
              />
            </div>
            <div className="form-field">
              <label htmlFor="delete-confirmation-repeat">
                {t("deleteConfirmationRepeat")}
              </label>
              <input
                id="delete-confirmation-repeat"
                value={confirmationRepeat}
                onChange={(e) => setConfirmationRepeat(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
              />
            </div>
          </>
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
            {t("cancel")}
          </button>
          <button
            type="submit"
            className="primary danger-fill"
            disabled={busy || !confirmed || (verify && !master)}
          >
            {busy && <CircleNotch className="spin" />}
            {t(verify ? "deleteAction" : "continueAction")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
