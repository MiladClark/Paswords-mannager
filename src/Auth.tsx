import {
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CaretDown,
  CircleNotch,
  Cloud,
  LockSimple,
  ShieldCheck,
} from "@phosphor-icons/react";
import { call, native } from "./api";
import { StartupReadyContext } from "./branding/StartupShell";
import { en, type Key } from "./i18n";
import { SecretInput, type Translate } from "./ui";

type Route = "welcome" | "password" | "cloud";
type Account = { email: string };
type Snapshot = { id: string; createdAt: string };
type CloudAction = "connect" | "list" | "restore";

type Props = {
  exists: boolean;
  onUnlock: (password: string, enableCloud: boolean) => void;
  onRestored: () => void;
  onClearError: () => void;
  t: Translate;
  error: string;
  busy: boolean;
  extensionInstall: ReactNode;
};

export default function Auth({
  exists,
  onUnlock,
  onRestored,
  onClearError,
  t,
  error,
  busy,
  extensionInstall,
}: Props) {
  const [route, setRoute] = useState<Route>("welcome");
  const [backward, setBackward] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const [enableCloud, setEnableCloud] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [selected, setSelected] = useState("");
  const [backupPassword, setBackupPassword] = useState("");
  const [pending, setPending] = useState<CloudAction | null>(null);
  const [cloudError, setCloudError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const surface = useRef<HTMLElement>(null);
  const ready = useContext(StartupReadyContext);
  const stage = exists ? "unlock" : route;
  const showFooter = stage === "welcome" || stage === "unlock";
  const backToCloud = stage === "password" && enableCloud;
  const BackArrow =
    document.documentElement.dir === "rtl" ? ArrowRight : ArrowLeft;

  useLayoutEffect(() => {
    if (!ready) return;
    if (surface.current) surface.current.scrollTop = 0;
    if (stage === "unlock") {
      surface.current
        ?.querySelector<HTMLInputElement>("#master-password")
        ?.focus({ preventScroll: true });
    } else {
      heading.current?.focus({ preventScroll: true });
    }
  }, [ready, stage]);

  function go(next: Route, back = false) {
    setBackward(back);
    setMismatch(false);
    onClearError();
    if (next !== "cloud") setBackupPassword("");
    setRoute(next);
  }

  function startPassword(withCloud: boolean) {
    if (withCloud !== enableCloud) {
      setPassword("");
      setConfirm("");
    }
    setEnableCloud(withCloud);
    go("password");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!exists && password !== confirm) {
      setMismatch(true);
      return;
    }
    onUnlock(password, !exists && enableCloud);
  }

  function reportCloudError(cause: unknown) {
    setCloudError(
      typeof cause === "string" &&
        Object.prototype.hasOwnProperty.call(en, cause)
        ? t(cause as Key)
        : t("genericError"),
    );
  }

  async function loadSnapshots() {
    setPending("list");
    const list = await call<Snapshot[]>("cloud_list");
    setSnapshots(list);
    setSelected(list[0]?.id ?? "");
  }

  async function connect(reconnect = false) {
    if (pending) return;
    setCloudError("");
    try {
      if (reconnect || !account) {
        setPending("connect");
        const next = await call<Account>("cloud_connect");
        setAccount(next);
        setSnapshots(null);
        setSelected("");
        setBackupPassword("");
      }
      await loadSnapshots();
    } catch (cause) {
      if (cause === "cloudSignInRequired") {
        setAccount(null);
        setSnapshots(null);
      }
      reportCloudError(cause);
    } finally {
      setPending(null);
    }
  }

  function openCloud() {
    go("cloud");
    if (!snapshots && !pending) void connect();
  }

  async function restore(event: FormEvent) {
    event.preventDefault();
    if (!selected || !backupPassword || pending) return;
    setPending("restore");
    setCloudError("");
    try {
      await call("cloud_restore", { id: selected, password: backupPassword });
      setBackupPassword("");
      onRestored();
    } catch (cause) {
      if (cause === "cloudSignInRequired") {
        setAccount(null);
        setSnapshots(null);
      }
      reportCloudError(cause);
    } finally {
      setPending(null);
    }
  }

  const title: Key =
    stage === "welcome"
      ? "createTitle"
      : stage === "password"
        ? "cloudMasterStep"
        : stage === "unlock"
          ? "unlockTitle"
          : snapshots?.length
            ? "cloudRestore"
            : account && snapshots?.length === 0
              ? "authAccountReady"
              : "authConnectTitle";
  const intro: Key =
    stage === "welcome"
      ? "cloudSetupIntro"
      : stage === "password"
        ? "authMasterIntro"
        : stage === "unlock"
          ? "authUnlockIntro"
          : snapshots?.length
            ? "cloudRestoreHint"
            : account && snapshots?.length === 0
              ? "cloudNoBackups"
              : "authBrowserIntro";
  const cloudStatus: Key | null =
    pending === "connect"
      ? "cloudWaitingBrowser"
      : pending === "list"
        ? "authLoadingBackups"
        : pending === "restore"
          ? "cloudRestoring"
          : null;

  return (
    <main className="auth-page" ref={surface} aria-labelledby="auth-title">
      <div className="auth-stack">
        <div
          key={stage}
          className="auth-card auth-stage auth-stage-enter"
          data-backward={backward || undefined}
        >
          {(stage === "password" || stage === "cloud") && (
            <button
              type="button"
              className="auth-back"
              disabled={busy || pending === "restore"}
              onClick={() => go(backToCloud ? "cloud" : "welcome", true)}
            >
              <BackArrow size={16} aria-hidden="true" />
              {t(backToCloud ? "authBackToDevTune" : "cloudBack")}
            </button>
          )}
          <header className="auth-heading">
            {stage === "welcome" || stage === "unlock" ? (
              <span className="auth-kicker">
                <LockSimple size={16} aria-hidden="true" />
                {t("personalVault")}
              </span>
            ) : (
              stage === "cloud" && (
                <span className="auth-kicker">
                  <Cloud size={16} aria-hidden="true" />
                  DevTune
                </span>
              )
            )}
            <h1 id="auth-title" ref={heading} tabIndex={-1}>
              {t(title)}
            </h1>
            <p>{t(intro)}</p>
          </header>

          {stage === "welcome" && (
            <div className="auth-actions">
              <button
                type="button"
                className="primary auth-button"
                disabled={busy}
                onClick={() => startPassword(false)}
              >
                {t("authCreateLocal")}
              </button>
              {native && (
                <button
                  type="button"
                  className="secondary auth-button"
                  disabled={busy}
                  onClick={openCloud}
                >
                  {t("authDevTune")}
                  <ArrowUpRight size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          {(stage === "password" || stage === "unlock") && (
            <form className="auth-form" onSubmit={submit}>
              <SecretInput
                id="master-password"
                label={t("master")}
                value={password}
                onChange={(value) => {
                  setPassword(value);
                  setMismatch(false);
                }}
                t={t}
                minLength={exists ? undefined : 12}
                hint={exists ? undefined : t("masterHint")}
                disabled={busy}
              />
              {!exists && (
                <SecretInput
                  id="confirm-password"
                  label={t("confirm")}
                  value={confirm}
                  onChange={(value) => {
                    setConfirm(value);
                    setMismatch(false);
                  }}
                  t={t}
                  disabled={busy}
                  minLength={12}
                />
              )}
              {(error || mismatch) && (
                <p className="form-error" role="alert">
                  {mismatch ? t("mismatch") : error}
                </p>
              )}
              <button
                type="submit"
                className="primary auth-button"
                disabled={busy}
              >
                {busy && <CircleNotch className="spin" aria-hidden="true" />}
                {t(exists ? "unlock" : "create")}
              </button>
            </form>
          )}

          {stage === "cloud" && (
            <div className="auth-cloud">
              {account && (
                <p className="auth-account">
                  {t("cloudAccount")} <bdi>{account.email}</bdi>
                </p>
              )}
              {cloudStatus && (
                <p className="auth-status" role="status">
                  <CircleNotch className="spin" size={16} aria-hidden="true" />
                  {t(cloudStatus)}
                </p>
              )}
              {cloudError && (
                <p className="form-error" role="alert">
                  {cloudError}
                </p>
              )}
              {!!snapshots?.length && (
                <form className="auth-form" onSubmit={restore}>
                  <div className="form-field">
                    <label htmlFor="cloud-snapshot">{t("cloudVersion")}</label>
                    <div className="auth-select">
                      <select
                        id="cloud-snapshot"
                        name="cloud-snapshot"
                        value={selected}
                        disabled={!!pending}
                        onChange={(event) => {
                          setSelected(event.target.value);
                          setBackupPassword("");
                        }}
                      >
                        {snapshots.map((item) => (
                          <option key={item.id} value={item.id}>
                            {new Date(item.createdAt).toLocaleString()}
                          </option>
                        ))}
                      </select>
                      <CaretDown size={16} aria-hidden="true" />
                    </div>
                  </div>
                  <SecretInput
                    id="cloud-restore-password"
                    label={t("cloudBackupPassword")}
                    value={backupPassword}
                    onChange={setBackupPassword}
                    t={t}
                    disabled={!!pending}
                  />
                  <button
                    className="primary auth-button"
                    type="submit"
                    disabled={!selected || !backupPassword || !!pending}
                  >
                    {t("cloudRestore")}
                  </button>
                </form>
              )}
              {!pending && snapshots?.length === 0 && (
                <button
                  type="button"
                  className="primary auth-button"
                  onClick={() => startPassword(true)}
                >
                  {t("authCreateConnected")}
                </button>
              )}
              {!pending &&
                (snapshots ? (
                  <button
                    type="button"
                    className="auth-back"
                    onClick={() => void connect(true)}
                  >
                    {t("cloudSwitchAccount")}
                    <ArrowUpRight size={16} aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="secondary auth-button"
                    onClick={() => void connect()}
                  >
                    {t(account ? "authRetryBackups" : "authDevTune")}
                    {!account && <ArrowUpRight size={16} aria-hidden="true" />}
                  </button>
                ))}
            </div>
          )}

          <p className="auth-reassurance">
            <ShieldCheck size={16} aria-hidden="true" />
            {t("encrypted")}
          </p>
        </div>
        {showFooter && (
          <footer className="auth-footer">
            {extensionInstall}
            <p className="early-note">{t("securityNote")}</p>
          </footer>
        )}
      </div>
    </main>
  );
}
