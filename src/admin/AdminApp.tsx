import { useEffect, useState, type FormEvent } from "react";
import { useTranslation, type Locale, type TranslationKey } from "../i18n";

type Section = "storage" | "security" | "drm" | "webhooks" | "teams" | "roles" | "audit" | "monitoring";
const sections: Section[] = ["storage", "security", "drm", "webhooks", "teams", "roles", "audit", "monitoring"];
interface Resource { id?: string; name?: string; healthy?: boolean; status?: string; [key: string]: unknown }

export default function AdminApp({ lang }: { lang: Locale }) {
  const { t } = useTranslation(lang);
  const [section, setSection] = useState<Section>("storage");
  const [records, setRecords] = useState<Resource[]>([]);
  const [message, setMessage] = useState("");
  const [token, setToken] = useState(() => localStorage.getItem("fileexpress.admin.token") ?? "");
  const load = async (target: Section): Promise<void> => {
    setSection(target); setMessage("");
    try { const response = await fetch(`/api/admin/${target}`, { headers: { Authorization: `Bearer ${token}` } }); if (!response.ok) throw new Error(`HTTP ${response.status}`); const body = await response.json() as { items?: Resource[] }; setRecords(body.items ?? []); }
    catch (error) { setRecords([]); setMessage(error instanceof Error ? error.message : "Request failed"); }
  };
  useEffect(() => { void load("storage"); }, [token]);
  return <main className="mx-auto max-w-7xl p-4 text-[var(--text-primary)]">
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-black">{t("admin.title")}</h1>
      <label className="text-xs">Admin token <input type="password" autoComplete="current-password" value={token} onChange={(event) => { setToken(event.target.value); localStorage.setItem("fileexpress.admin.token", event.target.value); }} className="ml-2 rounded border border-[var(--border-color)] bg-transparent p-2" /></label>
    </div>
    <div className="grid gap-4 md:grid-cols-[180px_1fr]">
      <nav className="flex gap-2 overflow-auto md:flex-col" aria-label="Administration">{sections.map((item) => <button key={item} onClick={() => { void load(item); }} className={`rounded-lg px-3 py-2 text-left text-sm ${section === item ? "bg-[var(--accent)] text-white" : "border border-[var(--border-color)]"}`}>{t(`admin.${item}` as TranslationKey)}</button>)}</nav>
      <section className="rounded-xl border border-[var(--border-color)] p-4">
        <h2 className="mb-4 text-lg font-bold">{t(`admin.${section}` as TranslationKey)}</h2>
        <ResourceForm section={section} token={token} submitLabel={t("admin.save")} onSaved={() => { void load(section); }} />
        {message && <p role="alert" className="mt-3 text-sm text-red-500">{message}</p>}
        <div className="mt-4 grid gap-2">{records.map((record, index) => <article key={record.id ?? index} className="rounded border border-[var(--border-color)] p-3 text-xs"><strong>{record.name ?? record.id ?? `Record ${index + 1}`}</strong>{record.healthy !== undefined && <span className={record.healthy ? "ml-2 text-green-600" : "ml-2 text-red-500"}>{record.healthy ? "healthy" : "unhealthy"}</span>}<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap opacity-60">{JSON.stringify(record, null, 2)}</pre></article>)}</div>
      </section>
    </div>
  </main>;
}

function ResourceForm({ section, token, submitLabel, onSaved }: { section: Section; token: string; submitLabel: string; onSaved: () => void }) {
  const [value, setValue] = useState("{}");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setError("");
    try {
      const payload = JSON.parse(value) as unknown;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("JSON object required");
      const response = await fetch(`/api/admin/${section}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      setValue("{}"); onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save"); }
  };
  return <form onSubmit={(event) => { void submit(event); }} className="space-y-2">
    <label className="text-xs font-bold" htmlFor={`${section}-json`}>{section} JSON</label>
    <textarea id={`${section}-json`} value={value} onChange={(event) => setValue(event.target.value)} rows={5} spellCheck={false} className="w-full rounded border border-[var(--border-color)] bg-transparent p-3 font-mono text-xs" />
    {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
    <button className="rounded bg-[var(--accent)] px-4 py-2 text-xs font-bold text-white">{submitLabel}</button>
  </form>;
}
