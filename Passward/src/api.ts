import { invoke, isTauri } from "@tauri-apps/api/core";

export interface ExtraField {
  label: string;
  value: string;
  hidden: boolean;
}
export interface Entry {
  id: string;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  folder: string;
  tags: string[];
  favorite: boolean;
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
  fields: ExtraField[];
  history: string[];
}
export type Summary = Omit<
  Entry,
  "password" | "notes" | "fields" | "history" | "createdAt"
>;
export interface Page {
  items: Summary[];
  total: number;
  allCount: number;
  favoriteCount: number;
  trashCount: number;
  folders: string[];
}
export interface Status {
  exists: boolean;
  unlocked: boolean;
  idleSeconds: number;
  pin: PinInfo;
}
export interface PinInfo {
  enabled: boolean;
  available: boolean;
  blocked: boolean;
  attemptsRemaining: number;
  cooldownSeconds: number;
}
export interface EntryView extends Entry {
  protected: boolean;
  hasPassword: boolean;
  hasNotes: boolean;
  grantExpiresAt: number;
}
export const noPin: PinInfo = {
  enabled: false,
  available: false,
  blocked: false,
  attemptsRemaining: 10,
  cooldownSeconds: 0,
};
export function editable(view: EntryView): Entry {
  const {
    protected: _p,
    hasPassword: _h,
    hasNotes: _n,
    grantExpiresAt: _g,
    ...entry
  } = view;
  return entry;
}
export function redact(view: EntryView): EntryView {
  return {
    ...view,
    protected: true,
    password: "",
    notes: "",
    history: [],
    fields: view.fields.map((f) => ({ ...f, value: "" })),
    grantExpiresAt: 0,
  };
}
export const native = isTauri();
export const preview =
  import.meta.env.DEV &&
  !native &&
  new URLSearchParams(location.search).get("preview") === "1";
export async function call<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (preview)
    return (await import("./preview")).request(command, args) as Promise<T>;
  if (!native) throw "desktopOnly";
  return invoke<T>(command, args);
}
export function blankEntry(): Entry {
  return {
    id: "",
    title: "",
    username: "",
    password: "",
    url: "",
    notes: "",
    folder: "",
    tags: [],
    favorite: false,
    deleted: false,
    createdAt: 0,
    updatedAt: 0,
    fields: [],
    history: [],
  };
}
