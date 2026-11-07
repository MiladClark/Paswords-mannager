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
  favicon?: string;
  notes: string;
  folder: string;
  tags: string[];
  favorite: boolean;
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
  folders: string[];
}
export interface Status {
  exists: boolean;
  unlocked: boolean;
  idleSeconds: number;
  legacyPinRetired?: boolean;
}
export interface EntryView extends Entry {
  protected: boolean;
  hasPassword: boolean;
  hasNotes: boolean;
  grantExpiresAt: number;
}
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
    favicon: "",
    notes: "",
    folder: "",
    tags: [],
    favorite: false,
    createdAt: 0,
    updatedAt: 0,
    fields: [],
    history: [],
  };
}
