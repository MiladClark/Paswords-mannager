import { useState, type FormEvent } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { CloudSwitch, Dialog, SecretInput, type Translate } from "./ui";

interface Props {
  itemTitle?: string;
  t: Translate;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: (master: string, skipConfirmation: boolean) => Promise<void>;
}

export default function DestructiveDialog({
  itemTitle,
  t,
  busy,
  error,
  onClose,
  onConfirm,
}: Props) {
  const deleting = itemTitle !== undefined;
  const [master, setMaster] = useState("");
  const [skipConfirmation, setSkipConfirmation] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !master) return;
    void onConfirm(master, skipConfirmation);
    setMaster("");
  }

  return (
    <Dialog title={t(deleting ? "deleteTitle" : "resetTitle")} busy={busy} onClose={onClose}>
      <form className="dialog-form" onSubmit={submit}>
        {deleting ? (
          <>
            <div className="confirmation-object" dir="auto">{itemTitle}</div>
            <p>{t("deleteBody")}</p>
          </>
        ) : (
          <>
            <p>{t("resetWarning")}</p>
            <p>{t("resetBackupWarning")}</p>
          </>
        )}
        <SecretInput
          id="destructive-master"
          label={t("master")}
          value={master}
          onChange={setMaster}
          t={t}
          disabled={busy}
          autoFocus
        />
        {deleting && (
          <div className="delete-preference">
            <CloudSwitch
              label={t("deleteDontAsk")}
              checked={skipConfirmation}
              onChange={setSkipConfirmation}
              disabled={busy}
            />
            <p className="field-help">{t("deleteDontAskHint")}</p>
          </div>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-footer">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            {t("cancel")}
          </button>
          <button type="submit" className="primary reset-button" disabled={busy || !master}>
            {busy && <CircleNotch className="spin" aria-hidden="true" />}
            {t(deleting ? "deleteItem" : "resetAction")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
