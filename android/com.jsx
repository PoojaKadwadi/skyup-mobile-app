// src/components/Communications.jsx
// Unified Communications Hub — WhatsApp Chat + Email History + Email Blast
// Sidebar label: "Communications"  |  Icon suggestion: ChatBubbleLeftRightIcon

import { useState, useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";
import axios from "axios";
import api from "../data/axiosConfig";

const API_URL    = import.meta.env.VITE_API_URL;
const SOCKET_URL = API_URL.replace("/api", "");

// ─────────────────────────────────────────────────────────────────────────────
// ── Shared helpers
// ─────────────────────────────────────────────────────────────────────────────
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) +
    " " +
    d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
  );
};

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const d    = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const m    = Math.floor(diff / 60000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return d.toLocaleDateString();
}

function formatTime(dateStr) {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getInitials(name = "") {
  return name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2) || "WA";
}

function sessionBanner(conv) {
  if (!conv?.sessionExpiresAt) return null;
  const remaining = new Date(conv.sessionExpiresAt) - Date.now();
  if (remaining <= 0) return { expired: true, text: "24h session expired — send a template message" };
  const hours = Math.floor(remaining / 3600000);
  const mins  = Math.floor((remaining % 3600000) / 60000);
  if (hours < 2) return { expired: false, text: `Session closes in ${hours}h ${mins}m` };
  return null;
}

const FIELD_CLS =
  "w-full px-3 py-2.5 rounded-xl border border-[#E4E7EF] dark:border-[#262A38] bg-[#F8F9FC] dark:bg-[#13161E] text-[13px] text-[#0F1117] dark:text-[#F0F2FA] placeholder:text-[#8B92A9] focus:outline-none focus:border-[#2563EB] transition";

const FIELD = "w-full px-3 py-2.5 rounded-xl border border-[#E4E7EF] dark:border-[#262A38] bg-[#F8F9FC] dark:bg-[#13161E] text-[13px] text-[#0F1117] dark:text-[#F0F2FA] placeholder:text-[#8B92A9] focus:outline-none focus:border-[#2563EB] transition";

// ─────────────────────────────────────────────────────────────────────────────
// ── INTEGRATIONS SETTINGS MODAL
// ─────────────────────────────────────────────────────────────────────────────
function IntegrationsModal({ onClose }) {
  const [activeTab, setActiveTab] = useState("whatsapp");

  const [msg91, setMsg91]             = useState(null);
  const [msg91Key, setMsg91Key]       = useState("");
  const [msg91Num, setMsg91Num]       = useState("");
  const [msg91Show, setMsg91Show]     = useState(false);
  const [msg91Saving, setMsg91Saving] = useState(false);
  const [msg91Err, setMsg91Err]       = useState("");
  const [msg91Ok, setMsg91Ok]         = useState("");
  const [msg91Disc, setMsg91Disc]     = useState(false);
  const [msg91NS,   setMsg91NS]       = useState("");

  const [brevo, setBrevo]             = useState(null);
  const [brevoKey, setBrevoKey]       = useState("");
  const [brevoEmail, setBrevoEmail]   = useState("");
  const [brevoName, setBrevoName]     = useState("");
  const [brevoShow, setBrevoShow]     = useState(false);
  const [brevoSaving, setBrevoSaving] = useState(false);
  const [brevoErr, setBrevoErr]       = useState("");
  const [brevoOk, setBrevoOk]         = useState("");
  const [brevoDisc, setBrevoDisc]     = useState(false);

  useEffect(() => {
    api.get("/admin/company/msg91-config").then(r => {
      setMsg91(r.data || {});
      setMsg91Key(r.data?.authKey ? "••••••••••••••••" : "");
      setMsg91Num(r.data?.integratedNumber || "");
      setMsg91NS(r.data?.namespace || "");
    }).catch(() => setMsg91({}));

    api.get("/admin/company/brevo-config").then(r => {
      setBrevo(r.data || {});
      setBrevoKey(r.data?.apiKey ? "••••••••••••••••" : "");
      setBrevoEmail(r.data?.senderEmail || "");
      setBrevoName(r.data?.senderName || "");
    }).catch(() => setBrevo({}));
  }, []);

  const saveMsg91 = async () => {
    if (!msg91Key.trim() || msg91Key === "••••••••••••••••") { setMsg91Err("Enter your MSG91 Auth Key"); return; }
    if (!msg91Num.trim()) { setMsg91Err("Enter your MSG91 integrated WhatsApp number"); return; }
    setMsg91Saving(true); setMsg91Err(""); setMsg91Ok("");
    try {
      const r = await api.put("/admin/company/msg91-config", { authKey: msg91Key.trim(), integratedNumber: msg91Num.trim(), namespace: msg91NS.trim() });
      setMsg91(r.data); setMsg91Key("••••••••••••••••");
      setMsg91Ok("✓ MSG91 connected! WhatsApp and SMS are now active.");
      setTimeout(() => setMsg91Ok(""), 4000);
    } catch (e) { setMsg91Err(e.response?.data?.message || "Failed to save MSG91 config"); }
    finally { setMsg91Saving(false); }
  };

  const disconnectMsg91 = async () => {
    if (!window.confirm("Disconnect MSG91? WhatsApp and SMS blasts will stop working.")) return;
    setMsg91Disc(true);
    try { await api.delete("/admin/company/msg91-config"); setMsg91({}); setMsg91Key(""); setMsg91Num(""); }
    catch { setMsg91Err("Failed to disconnect MSG91"); }
    finally { setMsg91Disc(false); }
  };

  const saveBrevo = async () => {
    if (!brevoKey.trim() || brevoKey === "••••••••••••••••") { setBrevoErr("Enter your Brevo API Key"); return; }
    if (!brevoEmail.trim()) { setBrevoErr("Enter sender email address"); return; }
    setBrevoSaving(true); setBrevoErr(""); setBrevoOk("");
    try {
      const r = await api.put("/admin/company/brevo-config", {
        apiKey: brevoKey.trim(),
        senderEmail: brevoEmail.trim(),
        senderName: brevoName.trim() || "CRM",
      });
      setBrevo(r.data); setBrevoKey("••••••••••••••••");
      setBrevoOk("✓ Brevo connected! Email blasts are now active.");
      setTimeout(() => setBrevoOk(""), 4000);
    } catch (e) { setBrevoErr(e.response?.data?.message || "Failed to save Brevo config"); }
    finally { setBrevoSaving(false); }
  };

  const disconnectBrevo = async () => {
    if (!window.confirm("Disconnect Brevo? Email blasts will stop working.")) return;
    setBrevoDisc(true);
    try { await api.delete("/admin/company/brevo-config"); setBrevo({}); setBrevoKey(""); setBrevoEmail(""); setBrevoName(""); }
    catch { setBrevoErr("Failed to disconnect Brevo"); }
    finally { setBrevoDisc(false); }
  };

  const msg91Connected = msg91?.connected === true;
  const brevoConnected = brevo?.connected === true;

  const TABS = [
    { key: "whatsapp", label: "WhatsApp", color: "#25D366", connected: msg91Connected,
      icon: <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/> },
    { key: "sms",      label: "SMS",      color: "#EA580C", connected: msg91Connected,
      icon: <path strokeLinecap="round" strokeLinejoin="round" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"/> },
    { key: "email",    label: "Email",    color: "#7C3AED", connected: brevoConnected,
      icon: <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/> },
  ];

  const currentTab = TABS.find(t => t.key === activeTab);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4" onClick={onClose}>
      <div className="bg-white dark:bg-[#1A1D27] rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-[#E4E7EF] dark:border-[#262A38] flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-[16px] font-bold text-[#0F1117] dark:text-[#F0F2FA]">Integrations</h2>
            <p className="text-[11px] text-[#8B92A9] mt-0.5">Connect your messaging and email providers</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-xl hover:bg-gray-100 dark:hover:bg-[#262A38] text-[#8B92A9] transition">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>

        <div className="flex border-b border-[#E4E7EF] dark:border-[#262A38] shrink-0">
          {TABS.map(t => (
            <button key={t.key} onClick={() => setActiveTab(t.key)}
              className={`flex-1 flex flex-col items-center gap-1 py-3 text-[12px] font-semibold transition border-b-2 ${activeTab === t.key ? "border-current" : "border-transparent text-[#8B92A9] hover:text-[#4B5168] dark:hover:text-[#9DA3BB]"}`}
              style={{ color: activeTab === t.key ? t.color : undefined }}>
              <div className="relative">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>{t.icon}</svg>
                <span className={`absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full border-2 border-white dark:border-[#1A1D27] ${t.connected ? "bg-emerald-500" : "bg-[#8B92A9]"}`}/>
              </div>
              {t.label}
            </button>
          ))}
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-4">
          <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${currentTab.connected ? "bg-emerald-50 dark:bg-emerald-900/10 border-emerald-200 dark:border-emerald-800/40" : "bg-amber-50 dark:bg-amber-900/10 border-amber-200 dark:border-amber-800/40"}`}>
            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${currentTab.connected ? "bg-emerald-500" : "bg-amber-400"}`}/>
            <p className={`text-[12px] font-semibold ${currentTab.connected ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}`}>
              {currentTab.connected ? `${currentTab.label} is connected and active` : `${currentTab.label} is not connected — fill in your credentials below to enable it`}
            </p>
            {currentTab.connected && (activeTab === "email" ? (
              <button onClick={disconnectBrevo} disabled={brevoDisc} className="ml-auto px-3 py-1 rounded-lg border border-red-200 dark:border-red-800 text-[11px] font-semibold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition disabled:opacity-50 shrink-0">
                {brevoDisc ? "…" : "Disconnect"}
              </button>
            ) : (
              <button onClick={disconnectMsg91} disabled={msg91Disc} className="ml-auto px-3 py-1 rounded-lg border border-red-200 dark:border-red-800 text-[11px] font-semibold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition disabled:opacity-50 shrink-0">
                {msg91Disc ? "…" : "Disconnect"}
              </button>
            ))}
          </div>

          {(activeTab === "whatsapp" || activeTab === "sms") && (
            <>
              <div className="bg-[#F8F9FC] dark:bg-[#13161E] rounded-xl p-4 space-y-2">
                <p className="text-[11px] font-bold text-[#4B5168] dark:text-[#9DA3BB] uppercase tracking-widest mb-2">How to get MSG91 credentials</p>
                {["Log in to msg91.com → click your profile → API","Copy your Auth Key (keep it secret — never share it)","Go to WhatsApp → Integrated Numbers to find your sender number","Paste both below and click Connect — this enables both WhatsApp and SMS"].map((s, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <span className="w-5 h-5 rounded-full bg-[#25D366]/10 text-[#25D366] text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">{i + 1}</span>
                    <p className="text-[12px] text-[#4B5168] dark:text-[#9DA3BB]">{s}</p>
                  </div>
                ))}
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">MSG91 Auth Key <span className="text-red-500">*</span></label>
                <div className="relative">
                  <input type={msg91Show ? "text" : "password"} value={msg91Key} onChange={e => setMsg91Key(e.target.value)} placeholder="Paste your MSG91 auth key here" className={FIELD + " pr-10 font-mono"} autoComplete="off"/>
                  <button type="button" onClick={() => setMsg91Show(s => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#8B92A9] hover:text-[#4B5168] transition">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      {msg91Show ? <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/> : <><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></>}
                    </svg>
                  </button>
                </div>
                <p className="text-[10px] text-[#8B92A9] mt-1">msg91.com → Profile → API → Your Auth Key</p>
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Integrated WhatsApp Number <span className="text-red-500">*</span></label>
                <input type="text" value={msg91Num} onChange={e => setMsg91Num(e.target.value)} placeholder="e.g. 919876543210 (country code, no +)" className={FIELD + " font-mono"}/>
                <p className="text-[10px] text-[#8B92A9] mt-1">msg91.com → WhatsApp → Integrated Numbers</p>
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">WhatsApp Namespace <span className="text-[10px] font-normal text-[#8B92A9]">(required for templates)</span></label>
                <input type="text" value={msg91NS} onChange={e => setMsg91NS(e.target.value)} placeholder="e.g. 68bcef67_e185_4e55_94df_52c26cb0bc37" className={FIELD + " font-mono"}/>
                <p className="text-[10px] text-[#8B92A9] mt-1">MSG91 → Templates → click any template → Code JSON → copy "namespace" value</p>
              </div>
              <div className="bg-[#F0FDF4] dark:bg-emerald-900/10 border border-emerald-200 dark:border-emerald-800/40 rounded-xl px-4 py-3">
                <p className="text-[12px] text-emerald-700 dark:text-emerald-400"><strong>One key, two services:</strong> Saving this key enables both <strong>WhatsApp</strong> and <strong>SMS</strong> blasts.</p>
              </div>
              {msg91Err && <div className="px-3 py-2 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-[12px] text-red-600 dark:text-red-400">{msg91Err}</div>}
              {msg91Ok  && <div className="px-3 py-2 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 text-[12px] text-emerald-700 dark:text-emerald-400">{msg91Ok}</div>}
              <button onClick={saveMsg91} disabled={msg91Saving} className="w-full py-2.5 rounded-xl font-semibold text-[13px] text-white transition flex items-center justify-center gap-2 disabled:opacity-60" style={{ background: "#25D366" }}>
                {msg91Saving && <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>}
                {msg91Saving ? "Connecting…" : msg91Connected ? "Update MSG91 Credentials" : "Connect MSG91"}
              </button>
            </>
          )}

          {activeTab === "email" && (
            <>
              <div className="bg-[#F8F9FC] dark:bg-[#13161E] rounded-xl p-4 space-y-2">
                <p className="text-[11px] font-bold text-[#4B5168] dark:text-[#9DA3BB] uppercase tracking-widest mb-2">How to get your Brevo API key</p>
                {["Log in to app.brevo.com (or create a free account)","Go to Settings (top-right) → API Keys → Generate a new key","Copy the key — it is shown only once, so save it safely","Enter your verified sender email below (must be verified in Brevo)","Paste the key below and click Connect"].map((s, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <span className="w-5 h-5 rounded-full bg-[#7C3AED]/10 text-[#7C3AED] text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">{i + 1}</span>
                    <p className="text-[12px] text-[#4B5168] dark:text-[#9DA3BB]">{s}</p>
                  </div>
                ))}
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Brevo API Key <span className="text-red-500">*</span></label>
                <div className="relative">
                  <input type={brevoShow ? "text" : "password"} value={brevoKey} onChange={e => setBrevoKey(e.target.value)} placeholder="xkeysib-…" className={FIELD + " pr-10 font-mono"} autoComplete="off"/>
                  <button type="button" onClick={() => setBrevoShow(s => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#8B92A9] hover:text-[#4B5168] transition">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      {brevoShow ? <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/> : <><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></>}
                    </svg>
                  </button>
                </div>
                <p className="text-[10px] text-[#8B92A9] mt-1">app.brevo.com → Settings → API Keys</p>
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Sender Email <span className="text-red-500">*</span></label>
                <input type="email" value={brevoEmail} onChange={e => setBrevoEmail(e.target.value)} placeholder="you@yourdomain.com" className={FIELD}/>
                <p className="text-[10px] text-[#8B92A9] mt-1">Must be verified in your Brevo account</p>
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Sender Name <span className="text-[#8B92A9] font-normal">(optional)</span></label>
                <input type="text" value={brevoName} onChange={e => setBrevoName(e.target.value)} placeholder="e.g. SKYUP CRM" className={FIELD}/>
              </div>
              {brevoErr && <div className="px-3 py-2 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-[12px] text-red-600 dark:text-red-400">{brevoErr}</div>}
              {brevoOk  && <div className="px-3 py-2 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 text-[12px] text-emerald-700 dark:text-emerald-400">{brevoOk}</div>}
              <button onClick={saveBrevo} disabled={brevoSaving} className="w-full py-2.5 rounded-xl font-semibold text-[13px] text-white transition flex items-center justify-center gap-2 disabled:opacity-60" style={{ background: "#7C3AED" }}>
                {brevoSaving && <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>}
                {brevoSaving ? "Connecting…" : brevoConnected ? "Update Brevo Credentials" : "Connect Brevo"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── TAB NAV
// ─────────────────────────────────────────────────────────────────────────────
function TabNav({ active, onChange }) {
  const tabs = [
    { key: "whatsapp", label: "WhatsApp",
      icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.127.558 4.121 1.531 5.845L.057 23.286a.5.5 0 0 0 .64.64l5.431-1.47A11.952 11.952 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.849 0-3.576-.498-5.066-1.367l-.363-.214-3.765 1.018 1.022-3.734-.234-.376A9.967 9.967 0 0 1 2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg>,
      activeColor: "text-[#25D366]", activeBg: "bg-[#f0fdf4] dark:bg-[#052e1c]" },
    { key: "email", label: "Email",
      icon: <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>,
      activeColor: "text-[#7C3AED]", activeBg: "bg-[#f5f3ff] dark:bg-[#1e1040]" },
    { key: "sms", label: "SMS",
      icon: <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/></svg>,
      activeColor: "text-[#EA580C]", activeBg: "bg-[#fff7ed] dark:bg-[#1c0a00]" },
  ];
  return (
    <div className="flex gap-1 p-1 bg-[#F1F5F9] dark:bg-[#13161E] rounded-2xl overflow-x-auto" style={{scrollbarWidth:"none"}}>
      {tabs.map((t) => (
        <button key={t.key} onClick={() => onChange(t.key)}
          className={`flex items-center gap-1.5 px-3 sm:px-5 py-2 sm:py-2.5 rounded-xl text-[12px] sm:text-[13px] font-semibold transition-all whitespace-nowrap shrink-0 ${active === t.key ? `${t.activeBg} ${t.activeColor} shadow-sm` : "text-[#8B92A9] hover:text-[#4B5168] dark:hover:text-[#9DA3BB]"}`}>
          {t.icon}{t.label}
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── WHATSAPP PANEL (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
function NewConversationModal({ onClose, onSuccess, authHeaders }) {
  const [phone, setPhone]               = useState("");
  const [contactName, setContactName]   = useState("");
  const [templateName, setTemplateName] = useState("crm_followup_leads");
  const [languageCode, setLanguageCode] = useState("en");
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState("");

  const handleStart = async () => {
    if (!phone.trim()) return setError("Phone number is required");
    if (!templateName.trim()) return setError("Template name is required");
    setLoading(true); setError("");
    try {
      const { data } = await axios.post(`${API_URL}/whatsapp/start-conversation`, { phone: phone.trim().replace(/\D/g, ""), contactName: contactName.trim(), templateName: templateName.trim(), languageCode: languageCode.trim() || "en" }, authHeaders);
      onSuccess(data.conversation); onClose();
    } catch (err) { setError(err.response?.data?.error || "Failed to start conversation"); }
    finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-white dark:bg-[#1A1D27] rounded-2xl border border-[#E4E7EF] dark:border-[#262A38] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-[#E4E7EF] dark:border-[#262A38] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-[#f0fdf4] dark:bg-[#052e1c] flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="#25D366"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.127.558 4.121 1.531 5.845L.057 23.286a.5.5 0 0 0 .64.64l5.431-1.47A11.952 11.952 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.849 0-3.576-.498-5.066-1.367l-.363-.214-3.765 1.018 1.022-3.734-.234-.376A9.967 9.967 0 0 1 2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg>
            </div>
            <div>
              <h2 className="text-[15px] font-bold text-[#0F1117] dark:text-[#F0F2FA] leading-none">New WhatsApp Chat</h2>
              <p className="text-[11px] text-[#8B92A9] mt-0.5">Start a conversation with any client number</p>
            </div>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg border border-[#E4E7EF] dark:border-[#262A38] flex items-center justify-center text-[#8B92A9] hover:text-[#0F1117] transition">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="flex gap-2.5 bg-[#FFFBEB] dark:bg-[#1c1600] border border-[#FDE68A] dark:border-[#78350f] rounded-xl px-4 py-3">
            <span className="text-[14px] shrink-0 mt-0.5">💡</span>
            <p className="text-[11px] text-[#92400E] dark:text-[#FCD34D] leading-relaxed">WhatsApp requires a <strong>pre-approved template</strong> to initiate a new conversation. Once the client replies, you can send free-form messages for 24 hours.</p>
          </div>
          <div>
            <label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Client WhatsApp Number <span className="text-[#DC2626]">*</span></label>
            <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="919876543210 (with country code, no +)" className={FIELD_CLS} autoFocus/>
          </div>
          <div>
            <label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Client Name <span className="text-[#8B92A9] font-normal">(optional)</span></label>
            <input type="text" value={contactName} onChange={e => setContactName(e.target.value)} placeholder="Rahul Sharma" className={FIELD_CLS}/>
          </div>
          <div>
            <label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Template Name <span className="text-[#DC2626]">*</span></label>
            <input type="text" value={templateName} onChange={e => setTemplateName(e.target.value)} placeholder="crm_followup_leads" className={FIELD_CLS}/>
          </div>
          <div>
            <label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Template Language</label>
            <select value={languageCode} onChange={e => setLanguageCode(e.target.value)} className={FIELD_CLS}>
              <option value="en">English (en)</option><option value="en_US">English (en_US)</option><option value="hi">Hindi (hi)</option><option value="mr">Marathi (mr)</option><option value="gu">Gujarati (gu)</option><option value="ta">Tamil (ta)</option><option value="te">Telugu (te)</option><option value="kn">Kannada (kn)</option>
            </select>
          </div>
          {error && <div className="bg-[#FEF2F2] dark:bg-[#2D0A0A] border border-[#FECACA] dark:border-[#7F1D1D] rounded-xl px-4 py-3 text-[12px] text-[#DC2626]">⚠ {error}</div>}
        </div>
        <div className="px-6 pb-5 pt-2 flex gap-3">
          <button onClick={onClose} className="px-4 py-2.5 rounded-xl border border-[#E4E7EF] dark:border-[#262A38] text-[13px] font-semibold text-[#4B5168] hover:bg-[#F8F9FC] dark:hover:bg-[#13161E] transition">Cancel</button>
          <button onClick={handleStart} disabled={!phone.trim() || !templateName.trim() || loading} className="flex-1 py-2.5 rounded-xl bg-[#25D366] text-white text-[13px] font-semibold hover:bg-[#1da851] disabled:opacity-40 transition flex items-center justify-center gap-2">
            {loading ? <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>Starting…</> : <>Send Template &amp; Start Chat</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReEngageModal({ conversationId, authHeaders, onSent }) {
  const [templateName, setTemplateName] = useState("crm_followup_leads");
  const [languageCode, setLanguageCode] = useState("en");
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState("");

  const handleSend = async () => {
    if (!templateName.trim()) return setError("Template name is required");
    setLoading(true); setError("");
    try {
      const { data } = await axios.post(`${API_URL}/whatsapp/send-template`, { conversationId, templateName: templateName.trim(), languageCode }, authHeaders);
      onSent(data.message); setTemplateName("");
    } catch (err) { setError(err.response?.data?.error || "Failed to send template"); }
    finally { setLoading(false); }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input type="text" value={templateName} onChange={e => setTemplateName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handleSend(); }} placeholder="crm_followup_leads" className={FIELD_CLS + " flex-1 text-[12px]"} autoFocus/>
        <select value={languageCode} onChange={e => setLanguageCode(e.target.value)} className={FIELD_CLS + " w-[130px] text-[12px]"}>
          <option value="en">en</option><option value="en_US">en_US</option><option value="hi">hi</option><option value="mr">mr</option>
        </select>
        <button onClick={handleSend} disabled={!templateName.trim() || loading} className="px-4 py-2 rounded-xl bg-[#25D366] hover:bg-[#1da851] text-white text-[12px] font-semibold disabled:opacity-40 transition shrink-0 flex items-center gap-1.5">
          {loading ? <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg> : <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>}
          Re-engage
        </button>
      </div>
      {error && <p className="text-[11px] text-[#DC2626]">⚠ {error}</p>}
    </div>
  );
}

function WhatsAppBlastModal({ onClose, authHeaders }) {
  const [mode, setMode]               = useState("campaign");
  const [campaigns, setCampaigns]     = useState([]);
  const [campaign, setCampaign]       = useState("");
  const [leadCount, setLeadCount]     = useState(null);
  const [previewing, setPreviewing]   = useState(false);
  const [singleName, setSingleName]   = useState("");
  const [singlePhone, setSinglePhone] = useState("");
  const [csvText, setCsvText]         = useState("name,phone\nRahul Sharma,919876543210");
  const [csvParsed, setCsvParsed]     = useState(null);
  const [csvError, setCsvError]       = useState("");
  const [templateName, setTemplateName] = useState("crm_followup_leads");
  const [languageCode, setLanguageCode] = useState("en");
  const [loading, setLoading]         = useState(false);
  const [result, setResult]           = useState(null);
  const [error, setError]             = useState("");
  const [blastFilter, setBlastFilter] = useState({ status: "", source: "", dateFrom: "", dateTo: "" });

  useEffect(() => { api.get("/lead/distinct-campaigns").then(r => setCampaigns(r.data.data || [])).catch(() => {}); }, []);

  const handlePreview = async () => {
    if (!campaign) return;
    setPreviewing(true); setLeadCount(null);
    try { const res = await api.get(`/email-campaign/preview?campaign=${encodeURIComponent(campaign)}`); setLeadCount(res.data.leadCount); }
    catch (err) { setError(err.response?.data?.message || "Could not fetch preview"); }
    finally { setPreviewing(false); }
  };

  const parseCSV = () => {
    setCsvError("");
    const lines = csvText.trim().split("\n").filter(Boolean);
    if (lines.length < 2) return setCsvError("Need at least a header row and one data row");
    const header = lines[0].toLowerCase().split(",").map(s => s.trim());
    const phoneIdx = header.findIndex(h => h === "phone" || h === "mobile" || h === "number");
    const nameIdx  = header.indexOf("name");
    if (phoneIdx === -1) return setCsvError("CSV must have a 'phone' column");
    const rows = lines.slice(1).map(line => { const cols = line.split(",").map(s => s.trim()); return { name: nameIdx !== -1 ? cols[nameIdx] : "Friend", phone: cols[phoneIdx]?.replace(/\D/g, "") }; }).filter(r => r.phone && r.phone.length >= 7);
    if (rows.length === 0) return setCsvError("No valid phone rows found");
    setCsvParsed(rows);
  };

  const handleSend = async () => {
    if (!templateName.trim()) return setError("Template name is required");
    setLoading(true); setError("");
    try {
      let res;
      if (mode === "campaign") {
        if (!campaign) { setLoading(false); return setError("Select a campaign"); }
        let count = leadCount;
        if (count === null) { setPreviewing(true); const r = await api.get(`/email-campaign/preview?campaign=${encodeURIComponent(campaign)}`); count = r.data.leadCount; setLeadCount(count); setPreviewing(false); }
        if (!window.confirm(`Send "${templateName}" to ${count} leads in "${campaign}"?`)) { setLoading(false); return; }
        res = await axios.post(`${API_URL}/whatsapp/bulk-send`, { campaign, templateName: templateName.trim(), languageCode }, authHeaders);
      } else if (mode === "single") {
        if (!singlePhone.trim()) { setLoading(false); return setError("Phone number is required"); }
        if (!window.confirm(`Send "${templateName}" to ${singleName || "this contact"}?`)) { setLoading(false); return; }
        await axios.post(`${API_URL}/whatsapp/start-conversation`, { phone: singlePhone.replace(/\D/g, ""), contactName: singleName.trim() || undefined, templateName: templateName.trim(), languageCode }, authHeaders);
        res = { data: { sent: 1, failed: 0, total: 1 } };
      } else {
        if (!csvParsed) { setLoading(false); return setError("Parse the CSV first"); }
        if (!window.confirm(`Send "${templateName}" to ${csvParsed.length} recipients?`)) { setLoading(false); return; }
        res = await axios.post(`${API_URL}/whatsapp/bulk-send-csv`, { recipients: csvParsed, templateName: templateName.trim(), languageCode }, authHeaders);
      }
      setResult(res.data);
    } catch (err) { setError(err.response?.data?.error || err.response?.data?.message || "Failed to send"); }
    finally { setLoading(false); }
  };

  const recipientLabel = mode === "campaign" && leadCount !== null ? `${leadCount} leads` : mode === "single" && singlePhone.trim() ? "1 recipient" : mode === "csv" && csvParsed ? `${csvParsed.length} recipients` : "recipients";
  const isValid = templateName.trim() && (mode === "campaign" ? !!campaign : mode === "single" ? !!singlePhone.trim() : !!csvParsed);

  if (result) return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-white dark:bg-[#1A1D27] rounded-2xl border border-[#E4E7EF] dark:border-[#262A38] p-8 text-center" onClick={e => e.stopPropagation()}>
        <div className="w-14 h-14 rounded-full bg-[#f0fdf4] dark:bg-[#052e1c] flex items-center justify-center mx-auto mb-4">
          <svg className="w-7 h-7 text-[#25D366]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
        </div>
        <h2 className="text-[16px] font-bold text-[#0F1117] dark:text-[#F0F2FA] mb-1">WhatsApp Blast Complete!</h2>
        <div className="grid grid-cols-3 gap-3 mb-5 mt-4">
          {[{ label: "Sent", value: result.sent ?? 1, color: "#25D366" }, { label: "Failed", value: result.failed ?? 0, color: "#DC2626" }, { label: "Total", value: result.total ?? 1, color: "#2563EB" }].map(s => (
            <div key={s.label} className="bg-[#F8F9FC] dark:bg-[#13161E] rounded-xl p-3 text-center border border-[#E4E7EF] dark:border-[#262A38]">
              <div className="text-[22px] font-bold" style={{ color: s.color }}>{s.value}</div>
              <div className="text-[10px] text-[#8B92A9] uppercase mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
        <button onClick={onClose} className="w-full py-2.5 rounded-xl bg-[#25D366] text-white text-[13px] font-semibold hover:bg-[#1da851] transition">Done</button>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl bg-white dark:bg-[#1A1D27] rounded-2xl border border-[#E4E7EF] dark:border-[#262A38] overflow-hidden flex flex-col max-h-[94vh]" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-[#E4E7EF] dark:border-[#262A38] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-[#f0fdf4] dark:bg-[#052e1c] flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="#25D366"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.127.558 4.121 1.531 5.845L.057 23.286a.5.5 0 0 0 .64.64l5.431-1.47A11.952 11.952 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.849 0-3.576-.498-5.066-1.367l-.363-.214-3.765 1.018 1.022-3.734-.234-.376A9.967 9.967 0 0 1 2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg>
            </div>
            <div>
              <h2 className="text-[15px] font-bold text-[#0F1117] dark:text-[#F0F2FA] leading-none">Send WhatsApp Blast</h2>
              <p className="text-[11px] text-[#8B92A9] mt-0.5">Personalized bulk messages via MSG91</p>
            </div>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg border border-[#E4E7EF] dark:border-[#262A38] flex items-center justify-center text-[#8B92A9] hover:text-[#0F1117] transition">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div className="px-6 pt-4 shrink-0">
          <div className="grid grid-cols-3 gap-1.5">
            {[{ key: "campaign", label: "Campaign leads" }, { key: "single", label: "Single lead" }, { key: "csv", label: "CSV import" }].map(m => (
              <button key={m.key} onClick={() => { setMode(m.key); setError(""); }} className={`py-2 rounded-xl border text-[12px] font-semibold transition ${mode === m.key ? "border-[#25D366] bg-[#f0fdf4] dark:bg-[#052e1c] text-[#25D366]" : "border-[#E4E7EF] dark:border-[#262A38] text-[#4B5168] dark:text-[#9DA3BB]"}`}>{m.label}</button>
            ))}
          </div>
        </div>
        <div className="overflow-y-auto px-6 py-4 space-y-4">
          {mode === "campaign" && (
            <div>
              <label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Target campaign</label>
              <div className="flex gap-2">
                <select value={campaign} onChange={e => { setCampaign(e.target.value); setLeadCount(null); }} className={FIELD_CLS + " flex-1"}>
                  <option value="">— Select a campaign —</option>
                  {[...new Set(campaigns.filter(Boolean))].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <button onClick={handlePreview} disabled={!campaign || previewing} className="px-4 py-2.5 rounded-xl border border-[#E4E7EF] dark:border-[#262A38] text-[12px] font-semibold text-[#25D366] disabled:opacity-40 transition shrink-0">{previewing ? "…" : "Preview"}</button>
              </div>
              {leadCount !== null && <div className="mt-2 flex items-center gap-1.5 text-[12px]"><span className="w-2 h-2 rounded-full bg-[#25D366]"/><span className="text-[#25D366] font-semibold">{leadCount} leads</span><span className="text-[#8B92A9]">will receive this</span></div>}
            </div>
          )}
          {mode === "single" && (
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Contact name</label><input type="text" value={singleName} onChange={e => setSingleName(e.target.value)} placeholder="Rahul Sharma" className={FIELD_CLS}/></div>
              <div><label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">WhatsApp number <span className="text-[#DC2626]">*</span></label><input type="tel" value={singlePhone} onChange={e => setSinglePhone(e.target.value)} placeholder="919876543210" className={FIELD_CLS}/></div>
            </div>
          )}
          {mode === "csv" && (
            <div>
              <textarea value={csvText} onChange={e => { setCsvText(e.target.value); setCsvParsed(null); setCsvError(""); }} rows={4} className={FIELD_CLS + " font-mono text-[12px] resize-y"}/>
              <div className="flex items-center gap-2 mt-2">
                <button onClick={parseCSV} className="px-4 py-2 rounded-xl bg-[#f0fdf4] dark:bg-[#052e1c] text-[#25D366] text-[12px] font-semibold border border-[#25D366]/30">Parse CSV</button>
                {csvParsed && <span className="text-[12px] text-[#25D366] font-semibold">✓ {csvParsed.length} recipients</span>}
              </div>
              {csvError && <p className="text-[11px] text-[#DC2626] mt-1">⚠ {csvError}</p>}
            </div>
          )}
          <div className="bg-[#F8F9FC] dark:bg-[#13161E] rounded-xl p-4 space-y-3">
            <p className="text-[11px] font-bold text-[#4B5168] dark:text-[#9DA3BB] uppercase tracking-widest">Target Audience</p>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="text-[11px] font-semibold text-[#8B92A9] mb-1 block">Lead Status</label><select value={blastFilter.status} onChange={e => setBlastFilter(f => ({ ...f, status: e.target.value }))} className={FIELD_CLS}><option value="">All Statuses</option><option value="New">New</option><option value="In Progress">In Progress</option><option value="Converted">Converted</option><option value="Not Interested">Not Interested</option></select></div>
              <div><label className="text-[11px] font-semibold text-[#8B92A9] mb-1 block">Lead Source</label><select value={blastFilter.source} onChange={e => setBlastFilter(f => ({ ...f, source: e.target.value }))} className={FIELD_CLS}><option value="">All Sources</option><option value="Meta">Meta</option><option value="Google">Google</option><option value="Website">Website</option><option value="Manual">Manual</option></select></div>
              <div><label className="text-[11px] font-semibold text-[#8B92A9] mb-1 block">Date From</label><input type="date" value={blastFilter.dateFrom} onChange={e => setBlastFilter(f => ({ ...f, dateFrom: e.target.value }))} className={FIELD_CLS}/></div>
              <div><label className="text-[11px] font-semibold text-[#8B92A9] mb-1 block">Date To</label><input type="date" value={blastFilter.dateTo} onChange={e => setBlastFilter(f => ({ ...f, dateTo: e.target.value }))} className={FIELD_CLS}/></div>
            </div>
          </div>
          <div className="pt-1 border-t border-[#E4E7EF] dark:border-[#262A38]">
            <p className="text-[11px] font-bold text-[#8B92A9] uppercase tracking-widest mb-3">WhatsApp Template</p>
            <div className="flex gap-2.5 bg-[#FFFBEB] dark:bg-[#1c1600] border border-[#FDE68A] dark:border-[#78350f] rounded-xl px-4 py-3 mb-4">
              <span className="text-[14px] shrink-0">💡</span>
              <p className="text-[11px] text-[#92400E] dark:text-[#FCD34D] leading-relaxed">WhatsApp requires a <strong>pre-approved template</strong> to send bulk messages.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Template name <span className="text-[#DC2626]">*</span></label><input type="text" value={templateName} onChange={e => setTemplateName(e.target.value)} placeholder="crm_followup_leads" className={FIELD_CLS}/></div>
              <div><label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Template language</label><select value={languageCode} onChange={e => setLanguageCode(e.target.value)} className={FIELD_CLS}><option value="en">English (en)</option><option value="en_US">English (en_US)</option><option value="hi">Hindi (hi)</option><option value="mr">Marathi (mr)</option></select></div>
            </div>
          </div>
          {error && <div className="bg-[#FEF2F2] dark:bg-[#2D0A0A] border border-[#FECACA] dark:border-[#7F1D1D] rounded-xl px-4 py-3 text-[12px] text-[#DC2626]">⚠ {error}</div>}
        </div>
        <div className="px-6 pb-5 pt-3 border-t border-[#E4E7EF] dark:border-[#262A38] flex gap-3 shrink-0">
          <button onClick={onClose} className="px-4 py-2.5 rounded-xl border border-[#E4E7EF] dark:border-[#262A38] text-[13px] font-semibold text-[#4B5168] hover:bg-[#F8F9FC] dark:hover:bg-[#13161E] transition">Cancel</button>
          <button onClick={handleSend} disabled={!isValid || loading} className="flex-1 py-2.5 rounded-xl bg-[#25D366] text-white text-[13px] font-semibold hover:bg-[#1da851] disabled:opacity-40 transition flex items-center justify-center gap-2">
            {loading ? <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>Sending…</> : <>Send to {recipientLabel}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function normalizeWaPhone(p) { return String(p || "").replace(/\D/g, "").replace(/^0+/, ""); }

function WhatsAppPanel({ currentUser }) {
  const socketRef = useRef(null);
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  const [conversations, setConversations] = useState([]);
  const [selected, setSelected]           = useState(null);
  const [messages, setMessages]           = useState([]);
  const [text, setText]                   = useState("");
  const [loading, setLoading]             = useState(false);
  const [sending, setSending]             = useState(false);
  const [search, setSearch]               = useState("");
  const [filter, setFilter]               = useState("all");
  const [error, setError]                 = useState("");
  const [showNewChat, setShowNewChat]     = useState(false);
  const [bulkModal, setBulkModal]         = useState(false);
  const [sideTab, setSideTab]             = useState("chats");
  const [leads, setLeads]                 = useState([]);
  const [leadsLoading, setLeadsLoading]   = useState(false);
  const [leadsSearch, setLeadsSearch]     = useState("");
  const [startModal, setStartModal]       = useState(null);
  const [tmplName, setTmplName]           = useState("crm_followup_leads");
  const [tmplLang, setTmplLang]           = useState("en");
  const [starting, setStarting]           = useState(false);
  const [startErr, setStartErr]           = useState("");

  const isAdmin     = currentUser?.role === "admin" || currentUser?.role === "super_admin" || currentUser?.role === "superadmin";
  const token       = localStorage.getItem("token");
  const authHeaders = { headers: { Authorization: `Bearer ${token}` } };

  const handleNewConversation = (conv) => {
    setConversations(prev => { const exists = prev.find(c => c._id === conv._id); if (exists) return prev; return [conv, ...prev]; });
    setMessages([]); setSelected(conv); setError("");
    axios.get(`${API_URL}/whatsapp/conversations/${conv._id}/messages`, authHeaders).then(({ data }) => {
      setMessages(data.messages || []);
      setConversations(prev => prev.map(c => c._id === conv._id ? { ...c, ...data.conversation } : c));
      setSelected(sel => sel?._id === conv._id ? { ...sel, ...data.conversation } : sel);
    }).catch(() => {});
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  const loadConversations = useCallback(async () => {
    try { const { data } = await axios.get(`${API_URL}/whatsapp/conversations`, authHeaders); setConversations(data.conversations || []); } catch {}
  }, []);

  const loadLeads = useCallback(async () => {
    setLeadsLoading(true);
    try { const { data } = await axios.get(`${API_URL}/whatsapp/leads`, authHeaders); setLeads(data.leads || []); } catch {}
    finally { setLeadsLoading(false); }
  }, []);

  const loadMessages = useCallback(async (conv) => {
    setLoading(true); setMessages([]);
    try {
      const { data } = await axios.get(`${API_URL}/whatsapp/conversations/${conv._id}/messages`, authHeaders);
      setMessages(data.messages || []);
      if (data.conversation) {
        const fresh = data.conversation;
        setSelected(prev => prev?._id === fresh._id ? { ...prev, ...fresh } : prev);
        setConversations(prev => prev.map(c => c._id === fresh._id ? { ...c, unreadCount: 0, sessionExpiresAt: fresh.sessionExpiresAt, status: fresh.status } : c));
      } else {
        setConversations(prev => prev.map(c => c._id === conv._id ? { ...c, unreadCount: 0 } : c));
      }
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const socket = io(SOCKET_URL, { auth: { token } });
    socketRef.current = socket;
    if (isAdmin) socket.emit("wa_admin_join");
    else if (currentUser?._id) socket.emit("wa_agent_join", { agentId: currentUser._id });

    socket.on("wa_message", (payload) => {
      const { conversationId, message: msg, sessionExpiresAt: newExpiry, waPhone: inboundWaPhone } = payload;
      setConversations(prev => {
        const idx = prev.findIndex(c => c._id === conversationId);
        if (idx === -1) { loadConversations(); return prev; }
        const updated = [...prev];
        const conv = { ...updated[idx] };
        conv.lastMessage = msg.body; conv.lastMessageAt = msg.waTimestamp;
        if (msg.direction === "inbound") { conv.status = "waiting"; conv.unreadCount = (conv.unreadCount || 0) + 1; if (newExpiry) conv.sessionExpiresAt = newExpiry; }
        else { conv.status = "open"; }
        updated[idx] = conv; updated.unshift(updated.splice(idx, 1)[0]); return updated;
      });
      setSelected(sel => {
        if (!sel) return sel;
        if (sel._id === conversationId) {
          if (msg.direction === "inbound" && newExpiry) sel = { ...sel, sessionExpiresAt: newExpiry, status: "waiting" };
          setMessages(prev => { if (prev.some(m => m._id === msg._id)) return prev; return [...prev, msg]; });
          setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
          return sel;
        }
        if (msg.direction === "inbound" && inboundWaPhone && sel.waPhone && normalizeWaPhone(sel.waPhone) === normalizeWaPhone(inboundWaPhone) && sel._id !== conversationId) {
          axios.get(`${API_URL}/whatsapp/conversations/${conversationId}/messages`, { headers: { Authorization: `Bearer ${localStorage.getItem("token")}` } }).then(({ data }) => {
            setMessages(data.messages || []);
            if (data.conversation) { setSelected(prev => prev?._id === sel._id ? { ...prev, ...data.conversation, _id: conversationId } : prev); setConversations(prev => prev.map(c => c._id === sel._id ? { ...c, ...data.conversation, _id: conversationId } : c)); }
            setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
          }).catch(() => {});
        }
        return sel;
      });
    });

    socket.on("wa_new_conversation", ({ conversation }) => {
      setConversations(prev => { const exists = prev.find(c => c._id === conversation._id); if (exists) return prev; return [conversation, ...prev]; });
    });
    socket.on("wa_message_status", ({ waMessageId, status }) => { setMessages(prev => prev.map(m => m.waMessageId === waMessageId ? { ...m, status } : m)); });
    socket.on("wa_status_update",  ({ waMessageId, status }) => { setMessages(prev => prev.map(m => m.waMessageId === waMessageId ? { ...m, status } : m)); });
    socket.on("wa_assigned", () => loadConversations());
    loadConversations(); loadLeads();
    return () => socket.disconnect();
  }, [currentUser]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const selectConversation = (conv) => { setSelected(conv); setError(""); loadMessages(conv); setTimeout(() => inputRef.current?.focus(), 100); };

  const sendMessage = async () => {
    if (!text.trim() || !selected || sending) return;
    const msgText = text.trim(); setText(""); setSending(true); setError("");
    const optimistic = { _id: `opt_${Date.now()}`, direction: "outbound", body: msgText, messageType: "text", waTimestamp: new Date(), status: "pending", sentBy: { name: currentUser?.name } };
    setMessages(prev => [...prev, optimistic]);
    try {
      const { data } = await axios.post(`${API_URL}/whatsapp/send`, { conversationId: selected._id, text: msgText }, authHeaders);
      setMessages(prev => prev.map(m => m._id === optimistic._id ? { ...optimistic, ...data.message } : m));
    } catch (err) {
      setMessages(prev => prev.filter(m => m._id !== optimistic._id));
      const code = err.response?.data?.code;
      setError(code === "SESSION_EXPIRED" ? "24-hour session expired. Use a template message to re-engage." : err.response?.data?.error || "Failed to send message");
    } finally { setSending(false); }
  };

  const closeConversation = async () => {
    if (!selected) return;
    try { await axios.patch(`${API_URL}/whatsapp/conversations/${selected._id}/close`, {}, authHeaders); setConversations(prev => prev.map(c => c._id === selected._id ? { ...c, status: "closed" } : c)); setSelected(prev => ({ ...prev, status: "closed" })); } catch {}
  };

  const deleteConversation = async (convId) => {
    if (!window.confirm("Delete this conversation? This cannot be undone.")) return;
    try { await axios.delete(`${API_URL}/whatsapp/conversations/${convId}`, authHeaders); setConversations(prev => prev.filter(c => c._id !== convId)); if (selected?._id === convId) { setSelected(null); setMessages([]); } }
    catch (err) { alert(err.response?.data?.error || "Failed to delete conversation"); }
  };

  const filtered = conversations.filter(c => {
    const matchSearch = !search || c.contactName?.toLowerCase().includes(search.toLowerCase()) || c.waPhone?.includes(search) || c.lead?.name?.toLowerCase().includes(search.toLowerCase());
    const matchFilter = filter === "all" || c.status === filter;
    return matchSearch && matchFilter;
  });

  const session = sessionBanner(selected);

  return (
    <div className="flex h-full overflow-hidden rounded-2xl border border-[#E4E7EF] dark:border-[#262A38]">
      <div className={`w-full sm:w-[300px] shrink-0 flex flex-col border-r border-[#E4E7EF] dark:border-[#262A38] bg-[#FAFBFE] dark:bg-[#13161E] ${selected ? "hidden sm:flex" : "flex"}`}>
        <div className="p-3 border-b border-[#E4E7EF] dark:border-[#262A38]">
          <div className="relative mb-2">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#8B92A9]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z"/></svg>
            <input type="text" placeholder="Search by name or number..." value={search} onChange={e => setSearch(e.target.value)} className="pl-8 pr-3 py-2 w-full rounded-xl border border-[#E4E7EF] dark:border-[#262A38] bg-white dark:bg-[#1A1D27] text-[12px] text-[#0F1117] dark:text-[#F0F2FA] placeholder:text-[#8B92A9] focus:outline-none focus:border-[#25D366] transition"/>
          </div>
          <div className="flex gap-1">
            {["all","open","waiting","closed"].map(f => (
              <button key={f} onClick={() => setFilter(f)} className={`flex-1 text-[10px] py-1 rounded-lg font-semibold capitalize transition ${filter === f ? "bg-[#25D366] text-white" : "bg-white dark:bg-[#1A1D27] border border-[#E4E7EF] dark:border-[#262A38] text-[#8B92A9]"}`}>{f}</button>
            ))}
          </div>
          {isAdmin && (
            <button onClick={() => setBulkModal(true)} className="w-full mt-2 flex items-center justify-center gap-2 py-2 rounded-xl bg-[#25D366] hover:bg-[#1da851] text-white text-[12px] font-semibold transition">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
              Bulk WhatsApp
            </button>
          )}
        </div>
        <div className="flex border-b border-[#E4E7EF] dark:border-[#262A38]">
          {[{key:"chats",label:"Chats"},{key:"leads",label:`Leads (${leads.length})`}].map(t => (
            <button key={t.key} onClick={() => { setSideTab(t.key); if(t.key==="leads" && leads.length===0) loadLeads(); }} className={`flex-1 py-2 text-[11px] font-semibold transition border-b-2 ${sideTab===t.key ? "border-[#25D366] text-[#25D366]" : "border-transparent text-[#8B92A9]"}`}>{t.label}</button>
          ))}
        </div>

        {sideTab === "chats" && <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 && <div className="flex flex-col items-center justify-center py-10 gap-3"><span className="text-3xl">💬</span><p className="text-[#8B92A9] text-[12px]">No conversations yet</p></div>}
          {filtered.map(conv => {
            const isActive = selected?._id === conv._id;
            const hasUnread = conv.unreadCount > 0;
            const isZombie = isAdmin && !conv.lastMessage && !conv.sessionExpiresAt;
            return (
              <div key={conv._id} onClick={() => selectConversation(conv)} className={`relative flex items-center gap-2.5 px-3 py-3 cursor-pointer border-b border-[#E4E7EF] dark:border-[#262A38] transition-colors group ${isActive ? "bg-[#f0fdf4] dark:bg-[#052e1c]" : "hover:bg-[#F8F9FC] dark:hover:bg-[#1A1D27]"}`}>
                <div className="w-9 h-9 rounded-full bg-[#dcfce7] flex items-center justify-center font-semibold text-[13px] text-[#166534] shrink-0">{getInitials(conv.contactName || conv.lead?.name || conv.waPhone)}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-baseline">
                    <span className={`text-[12px] truncate max-w-[120px] ${hasUnread ? "font-semibold text-[#0F1117] dark:text-[#F0F2FA]" : "font-medium text-[#4B5168] dark:text-[#9DA3BB]"}`}>{conv.contactName || conv.lead?.name || `+${conv.waPhone}`}</span>
                    <span className="text-[10px] text-[#8B92A9] shrink-0">{timeAgo(conv.lastMessageAt)}</span>
                  </div>
                  <div className="flex items-center justify-between mt-0.5">
                    <span className={`text-[11px] truncate max-w-[130px] ${isZombie ? "text-[#DC2626]" : "text-[#8B92A9]"}`}>{isZombie ? "⚠ Template failed — tap to delete" : conv.lastMessage || "No messages yet"}</span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: conv.status === "waiting" ? "#f59e0b" : conv.status === "open" ? "#22c55e" : "#9ca3af" }}/>
                      {hasUnread && <span className="bg-[#25D366] text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full min-w-[16px] text-center">{conv.unreadCount}</span>}
                    </div>
                  </div>
                  {isAdmin && conv.assignedAgent?.name && <div className="text-[10px] text-[#8B92A9] mt-0.5">{conv.assignedAgent.name}</div>}
                </div>
                {isZombie && (
                  <button onClick={e => { e.stopPropagation(); deleteConversation(conv._id); }} className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 w-6 h-6 rounded-lg bg-[#FEF2F2] dark:bg-[#2D0A0A] flex items-center justify-center text-[#DC2626] transition">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>}

        {sideTab === "leads" && <div className="flex-1 overflow-y-auto">
          <div className="p-2 border-b border-[#E4E7EF] dark:border-[#262A38]">
            <input type="text" placeholder="Search name or phone..." value={leadsSearch} onChange={e => setLeadsSearch(e.target.value)} className="w-full px-3 py-1.5 rounded-lg border border-[#E4E7EF] dark:border-[#262A38] bg-white dark:bg-[#1A1D27] text-[12px] placeholder:text-[#8B92A9] focus:outline-none focus:border-[#25D366] transition"/>
          </div>
          {leadsLoading && <div className="p-6 text-center text-[#8B92A9] text-[12px]">Loading leads...</div>}
          {!leadsLoading && leads.filter(l => !leadsSearch || l.name?.toLowerCase().includes(leadsSearch.toLowerCase()) || l.mobile?.includes(leadsSearch)).map(lead => {
            const hasConv = !!lead.existingConversationId;
            return (
              <div key={lead._id} className="flex items-center gap-2.5 px-3 py-3 border-b border-[#E4E7EF] dark:border-[#262A38] hover:bg-[#F8F9FC] dark:hover:bg-[#1A1D27] transition">
                <div className="w-9 h-9 rounded-full bg-[#dcfce7] flex items-center justify-center font-semibold text-[13px] text-[#166534] shrink-0">{getInitials(lead.name)}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium text-[#0F1117] dark:text-[#F0F2FA] truncate">{lead.name}</div>
                  <div className="text-[11px] text-[#8B92A9]">{lead.mobile}</div>
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{background: lead.status==="Converted"?"#dcfce7":lead.status==="In Progress"?"#fef9c3":lead.status==="Not Interested"?"#fee2e2":"#dbeafe", color: lead.status==="Converted"?"#166534":lead.status==="In Progress"?"#854d0e":lead.status==="Not Interested"?"#991b1b":"#1e40af"}}>{lead.status}</span>
                </div>
                {hasConv ? (
                  <button onClick={() => { const c = conversations.find(c=>c._id===lead.existingConversationId); if(c){selectConversation(c);setSideTab("chats");}else{loadConversations().then(()=>setSideTab("chats"));} }} title="Open existing chat" className="w-8 h-8 rounded-full bg-[#dcfce7] border border-[#bbf7d0] flex items-center justify-center text-[#166834] hover:bg-[#bbf7d0] transition shrink-0">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
                  </button>
                ) : (
                  <button onClick={() => { setStartModal(lead); setTmplName("crm_followup_leads"); setTmplLang("en"); setStartErr(""); }} title="Start WhatsApp chat" className="w-8 h-8 rounded-full bg-[#25D366] flex items-center justify-center text-white hover:bg-[#1da851] transition shrink-0">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.127.558 4.121 1.531 5.845L.057 23.286a.5.5 0 0 0 .64.64l5.431-1.47A11.952 11.952 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.849 0-3.576-.498-5.066-1.367l-.363-.214-3.765 1.018 1.022-3.734-.234-.376A9.967 9.967 0 0 1 2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg>
                  </button>
                )}
              </div>
            );
          })}
          {!leadsLoading && leads.length === 0 && <div className="p-6 text-center text-[#8B92A9] text-[12px]">No leads found</div>}
        </div>}
      </div>

      {startModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setStartModal(null)}>
          <div className="bg-white dark:bg-[#1A1D27] rounded-2xl p-6 w-full max-w-[360px] mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-[15px] font-semibold text-[#0F1117] dark:text-[#F0F2FA] mb-1">Start WhatsApp Chat</h3>
            <p className="text-[12px] text-[#8B92A9] mb-4">{startModal.name} · {startModal.mobile}</p>
            <label className="block text-[11px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1">Template Name <span className="text-[#DC2626]">*</span></label>
            <input value={tmplName} onChange={e => setTmplName(e.target.value)} placeholder="crm_followup_leads" className="w-full px-3 py-2 rounded-xl border border-[#E4E7EF] dark:border-[#262A38] bg-[#F8F9FC] dark:bg-[#13161E] text-[13px] focus:outline-none focus:border-[#25D366] mb-3 transition"/>
            <label className="block text-[11px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1">Language</label>
            <select value={tmplLang} onChange={e => setTmplLang(e.target.value)} className="w-full px-3 py-2 rounded-xl border border-[#E4E7EF] dark:border-[#262A38] bg-[#F8F9FC] dark:bg-[#13161E] text-[13px] focus:outline-none focus:border-[#25D366] mb-3 transition">
              <option value="en">English (en)</option><option value="en_US">English (en_US)</option>
            </select>
            {startErr && <p className="text-[11px] text-[#DC2626] mb-3">{startErr}</p>}
            <div className="flex gap-2 mt-2">
              <button onClick={() => setStartModal(null)} className="flex-1 py-2 rounded-xl border border-[#E4E7EF] dark:border-[#262A38] text-[12px] text-[#8B92A9] hover:bg-[#F8F9FC] transition">Cancel</button>
              <button disabled={starting || !tmplName.trim()} onClick={async () => {
                setStarting(true); setStartErr("");
                try {
                  const phone = (startModal.mobile || "").replace(/\D/g, "");
                  const { data } = await axios.post(`${API_URL}/whatsapp/start-conversation`, { phone, contactName: startModal.name, templateName: tmplName.trim(), languageCode: tmplLang || "en" }, authHeaders);
                  const conv = data.conversation;
                  setConversations(prev => [conv, ...prev.filter(c => c._id !== conv._id)]);
                  setLeads(prev => prev.map(l => l._id === startModal._id ? { ...l, existingConversationId: conv._id } : l));
                  setStartModal(null); selectConversation(conv); setSideTab("chats");
                } catch(e) { setStartErr(e.response?.data?.error || "Failed to start conversation"); }
                finally { setStarting(false); }
              }} className="flex-1 py-2 rounded-xl bg-[#25D366] hover:bg-[#1da851] disabled:opacity-50 text-white text-[12px] font-semibold transition">
                {starting ? "Sending…" : "Send Template"}
              </button>
            </div>
          </div>
        </div>
      )}

      {!selected ? (
        <div className="hidden sm:flex flex-1 flex-col items-center justify-center text-[#8B92A9] bg-white dark:bg-[#1A1D27]">
          <div className="w-14 h-14 rounded-full bg-[#f0fdf4] dark:bg-[#052e1c] flex items-center justify-center mb-4">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="#25D366"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.127.558 4.121 1.531 5.845L.057 23.286a.5.5 0 0 0 .64.64l5.431-1.47A11.952 11.952 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.849 0-3.576-.498-5.066-1.367l-.363-.214-3.765 1.018 1.022-3.734-.234-.376A9.967 9.967 0 0 1 2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg>
          </div>
          <p className="text-[15px] font-semibold text-[#4B5168] dark:text-[#9DA3BB]">Select a conversation</p>
          <p className="text-[12px] mt-1">Choose a chat from the list to view messages</p>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-w-0 bg-white dark:bg-[#1A1D27]">
          <div className="px-4 py-3 border-b border-[#E4E7EF] dark:border-[#262A38] flex items-center gap-3">
            <button onClick={() => setSelected(null)} className="sm:hidden w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-[#262A38] text-[#8B92A9] shrink-0 transition">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/></svg>
            </button>
            <div className="w-9 h-9 rounded-full bg-[#dcfce7] flex items-center justify-center font-semibold text-[13px] text-[#166534] shrink-0">{getInitials(selected.contactName || selected.lead?.name || selected.waPhone)}</div>
            <div className="flex-1">
              <div className="font-semibold text-[14px] text-[#0F1117] dark:text-[#F0F2FA]">{selected.contactName || selected.lead?.name || `+${selected.waPhone}`}</div>
              <div className="text-[11px] text-[#8B92A9]">+{selected.waPhone}{selected.lead?.status ? ` · ${selected.lead.status}` : ""}{isAdmin && selected.assignedAgent?.name ? ` · ${selected.assignedAgent.name}` : ""}</div>
            </div>
          </div>

          {session && (
            <div className={`px-4 py-2 text-[11px] border-b border-[#E4E7EF] dark:border-[#262A38] ${session.expired ? "bg-[#FEF2F2] text-[#DC2626]" : "bg-[#FFFBEB] text-[#D97706]"}`}>⚠️ {session.text}</div>
          )}

          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2" style={{ background: "linear-gradient(to bottom, #f0fdf4 0%, #fafffe 100%)" }}>
            {loading && <div className="text-center text-[#8B92A9] text-[13px] py-8">Loading messages…</div>}
            {messages.map(msg => {
              const isOut = msg.direction === "outbound";
              return (
                <div key={msg._id} className={`flex ${isOut ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[68%] px-3 py-2 rounded-2xl shadow-sm border ${isOut ? "bg-[#dcfce7] border-[#bbf7d0] rounded-br-sm" : "bg-white border-[#e5e7eb] rounded-bl-sm"}`}>
                    {isAdmin && isOut && msg.sentBy && <div className="text-[9px] text-[#166534] font-semibold mb-0.5">{msg.sentBy.name}</div>}
                    <div className="text-[13px] text-[#111827] leading-[1.5] whitespace-pre-wrap break-words">
                      {msg.messageType === "image" && "🖼️ "}{msg.messageType === "document" && "📄 "}{msg.messageType === "audio" && "🎵 "}{msg.messageType === "video" && "🎥 "}{msg.messageType === "template" && "📋 "}
                      {msg.body}
                    </div>
                    <div className="flex justify-end items-center gap-1 mt-1">
                      <span className="text-[10px] text-[#6b7280]">{formatTime(msg.waTimestamp)}</span>
                      {isOut && <span className={`text-[10px] ${msg.status === "read" ? "text-[#2563eb]" : "text-[#9ca3af]"}`}>{msg.status === "read" ? "✓✓" : msg.status === "delivered" ? "✓✓" : msg.status === "sent" ? "✓" : msg.status === "failed" ? "✗" : "⏳"}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef}/>
          </div>

          {error && (
            <div className="px-4 py-2 bg-[#FEF2F2] text-[#DC2626] text-[11px] border-t border-[#FECACA] flex items-center justify-between">
              {error}<button onClick={() => setError("")} className="ml-2 text-inherit">✕</button>
            </div>
          )}

          {session?.expired && selected.status !== "closed" ? (
            <div className="px-4 py-3 border-t border-[#E4E7EF] dark:border-[#262A38] bg-white dark:bg-[#1A1D27]">
              <p className="text-[11px] text-[#8B92A9] mb-2 text-center">24-hour session expired. Send a pre-approved template to re-open the conversation.</p>
              <ReEngageModal conversationId={selected._id} authHeaders={authHeaders} onSent={msg => {
                setMessages(prev => [...prev, msg]);
                const newExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
                setSelected(s => ({ ...s, sessionExpiresAt: newExpiry }));
                setConversations(prev => prev.map(c => c._id === selected._id ? { ...c, sessionExpiresAt: newExpiry, lastMessage: msg.body, lastMessageAt: new Date() } : c));
                setError("");
              }}/>
            </div>
          ) : (
            <div className="px-4 py-3 border-t border-[#E4E7EF] dark:border-[#262A38] flex gap-2 items-end bg-white dark:bg-[#1A1D27]">
              <textarea ref={inputRef} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                placeholder={selected.status === "closed" ? "Conversation is closed" : "Type a message… (Enter to send)"}
                disabled={selected.status === "closed" || sending} rows={1}
                className="flex-1 resize-none text-[13px] px-3 py-2.5 rounded-2xl border border-[#E4E7EF] dark:border-[#262A38] bg-[#F8F9FC] dark:bg-[#13161E] text-[#0F1117] dark:text-[#F0F2FA] placeholder:text-[#8B92A9] focus:outline-none focus:border-[#25D366] transition leading-[1.5] max-h-[120px] overflow-y-auto"/>
              <button onClick={sendMessage} disabled={!text.trim() || sending || selected.status === "closed"} className={`w-9 h-9 rounded-full flex items-center justify-center transition shrink-0 ${text.trim() && !sending ? "bg-[#25D366] hover:bg-[#1da851]" : "bg-[#E4E7EF] dark:bg-[#262A38]"}`}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill={text.trim() && !sending ? "white" : "#9ca3af"}><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
              </button>
            </div>
          )}
        </div>
      )}

      {showNewChat && <NewConversationModal onClose={() => setShowNewChat(false)} onSuccess={handleNewConversation} authHeaders={authHeaders}/>}
      {bulkModal && <WhatsAppBlastModal onClose={() => setBulkModal(false)} authHeaders={authHeaders}/>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── EMAIL PANEL
// ─────────────────────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const isSent = status === "sent";
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold ${isSent ? "bg-[#ECFDF5] dark:bg-[#052E1C] text-[#059669] dark:text-[#34D399]" : "bg-[#FEF2F2] dark:bg-[#2D0A0A] text-[#DC2626] dark:text-[#F87171]"}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${isSent ? "bg-[#059669]" : "bg-[#DC2626]"}`}/>
      {isSent ? "Sent" : "Failed"}
    </span>
  );
}

function SkeletonRow() {
  return (
    <tr className="animate-pulse">
      {[1,2,3,4,5].map(i => <td key={i} className="px-4 py-3"><div className="h-3.5 bg-[#E4E7EF] dark:bg-[#262A38] rounded-full" style={{ width: `${60 + i * 8}%` }}/></td>)}
    </tr>
  );
}

function LogDetailModal({ logId, onClose }) {
  const [log, setLog]       = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/email/history/${logId}`).then(r => setLog(r.data.data)).catch(() => setLog(null)).finally(() => setLoading(false));
  }, [logId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl bg-white dark:bg-[#1A1D27] rounded-2xl border border-[#E4E7EF] dark:border-[#262A38] overflow-hidden flex flex-col max-h-[90vh]" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-[#E4E7EF] dark:border-[#262A38] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-[#F5F3FF] dark:bg-[#1E1040] flex items-center justify-center">
              <svg className="w-4 h-4 text-[#7C3AED]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
            </div>
            <h2 className="text-[15px] font-bold text-[#0F1117] dark:text-[#F0F2FA]">Email Details</h2>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg border border-[#E4E7EF] dark:border-[#262A38] flex items-center justify-center text-[#8B92A9] hover:text-[#0F1117] transition">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-5 space-y-4">
          {loading ? <div className="flex items-center justify-center py-12 text-[#8B92A9] gap-2"><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>Loading…</div>
          : !log ? <p className="text-center text-[#8B92A9] py-8">Could not load log details.</p>
          : (
            <>
              <div className="grid grid-cols-2 gap-3">
                {[{label:"To",value:log.to},{label:"Campaign",value:log.campaignId||"—"},{label:"Status",value:<StatusBadge status={log.status}/>},{label:"Sent At",value:fmtDate(log.sentAt)}].map(({label,value}) => (
                  <div key={label} className="bg-[#F8F9FC] dark:bg-[#13161E] rounded-xl px-4 py-3">
                    <p className="text-[10px] font-semibold text-[#8B92A9] uppercase tracking-wide mb-1">{label}</p>
                    <div className="text-[13px] font-medium text-[#0F1117] dark:text-[#F0F2FA]">{value}</div>
                  </div>
                ))}
              </div>
              <div className="bg-[#F8F9FC] dark:bg-[#13161E] rounded-xl px-4 py-3">
                <p className="text-[10px] font-semibold text-[#8B92A9] uppercase tracking-wide mb-1">Subject</p>
                <p className="text-[13px] font-medium text-[#0F1117] dark:text-[#F0F2FA]">{log.subject}</p>
              </div>
              {log.errorMessage && <div className="bg-[#FEF2F2] dark:bg-[#2D0A0A] border border-[#FECACA] dark:border-[#7F1D1D] rounded-xl px-4 py-3"><p className="text-[10px] font-semibold text-[#DC2626] uppercase tracking-wide mb-1">Error</p><p className="text-[12px] text-[#DC2626]">{log.errorMessage}</p></div>}
              {log.body && <div><p className="text-[10px] font-semibold text-[#8B92A9] uppercase tracking-wide mb-2">Email Body</p><div className="border border-[#E4E7EF] dark:border-[#262A38] rounded-xl p-4 bg-white dark:bg-[#0D0F14] text-[13px] max-h-64 overflow-y-auto" dangerouslySetInnerHTML={{ __html: log.body }}/></div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function EmailBlastModal({ onClose }) {
  const [mode, setMode]           = useState("campaign");
  const [campaigns, setCampaigns] = useState([]);
  const [form, setForm]           = useState({ campaign: "" });
  const [leadCount, setLeadCount] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [singleLead, setSingleLead] = useState({ name: "", email: "" });
  const [csvText, setCsvText]     = useState("name,email\nRahul Sharma,rahul@gmail.com");
  const [csvParsed, setCsvParsed] = useState(null);
  const [csvError, setCsvError]   = useState("");
  const [subject, setSubject]     = useState("");
  const [fromName, setFromName]   = useState("");
  const [bodyTemplate, setBodyTemplate] = useState("<p>Hi {{name}},</p>\n<p>We are reaching out about our <strong>{{campaign}}</strong> campaign.</p>\n<p>Regards,<br/>The Team</p>");
  const [loading, setLoading]     = useState(false);
  const [result, setResult]       = useState(null);
  const [error, setError]         = useState("");

  useEffect(() => { api.get("/lead/distinct-campaigns").then(r => setCampaigns(r.data.data || [])).catch(() => {}); }, []);

  const MERGE_TAGS = ["{{name}}", "{{campaign}}", "{{mobile}}", "{{email}}"];

  const parseCSV = () => {
    setCsvError("");
    const lines = csvText.trim().split("\n").filter(Boolean);
    if (lines.length < 2) return setCsvError("Need at least a header row and one data row");
    const header = lines[0].toLowerCase().split(",").map(s => s.trim());
    const emailIdx = header.indexOf("email");
    const nameIdx  = header.indexOf("name");
    if (emailIdx === -1) return setCsvError("CSV must have an 'email' column");
    const rows = lines.slice(1).map(line => { const cols = line.split(",").map(s => s.trim()); return { name: nameIdx !== -1 ? cols[nameIdx] : "Friend", email: cols[emailIdx] }; }).filter(r => r.email && r.email.includes("@"));
    if (rows.length === 0) return setCsvError("No valid email rows found");
    setCsvParsed(rows);
  };

  const handlePreview = async () => {
    if (!form.campaign) return;
    setPreviewing(true); setLeadCount(null);
    try { const res = await api.get(`/email-campaign/preview?campaign=${encodeURIComponent(form.campaign)}`); setLeadCount(res.data.leadCount); }
    catch (err) { setError(err.response?.data?.message || "Could not fetch preview"); }
    finally { setPreviewing(false); }
  };

  const handleSend = async () => {
    if (!subject || !bodyTemplate) return setError("Subject and body are required");
    setLoading(true); setError("");
    try {
      let res;
      if (mode === "campaign") {
        if (!form.campaign) return setError("Select a campaign");
        let count = leadCount;
        if (count === null) { setPreviewing(true); const r = await api.get(`/email-campaign/preview?campaign=${encodeURIComponent(form.campaign)}`); count = r.data.leadCount; setLeadCount(count); setPreviewing(false); }
        if (!window.confirm(`Send emails to ${count} leads in "${form.campaign}"?`)) { setLoading(false); return; }
        res = await api.post("/email-campaign/send", { campaign: form.campaign, subject, bodyTemplate, fromName: fromName || undefined });
      } else if (mode === "single") {
        if (!singleLead.email || !singleLead.name) return setError("Name and email are required");
        if (!window.confirm(`Send email to ${singleLead.name}?`)) { setLoading(false); return; }
        res = await api.post("/email-campaign/send-single", { name: singleLead.name, email: singleLead.email, subject, bodyTemplate, fromName: fromName || undefined });
      } else {
        if (!csvParsed) return setError("Parse the CSV first");
        if (!window.confirm(`Send emails to ${csvParsed.length} recipients?`)) { setLoading(false); return; }
        res = await api.post("/email-campaign/send-csv", { recipients: csvParsed, subject, bodyTemplate, fromName: fromName || undefined });
      }
      setResult(res.data);
    } catch (err) { setError(err.response?.data?.message || err.message || "Failed to send"); }
    finally { setLoading(false); }
  };

  const insertTag = tag => setBodyTemplate(p => p + tag);
  const isValid = subject.trim() && bodyTemplate.trim() && (mode === "campaign" ? !!form.campaign : mode === "single" ? !!singleLead.email && !!singleLead.name : !!csvParsed);
  const recipientLabel = mode === "campaign" && leadCount !== null ? `${leadCount} leads` : mode === "single" && singleLead.email ? "1 recipient" : mode === "csv" && csvParsed ? `${csvParsed.length} recipients` : "recipients";

  if (result) return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-full max-w-md bg-white dark:bg-[#1A1D27] rounded-2xl border border-[#E4E7EF] dark:border-[#262A38] p-8 text-center" onClick={e => e.stopPropagation()}>
        <div className="w-14 h-14 rounded-full bg-[#ECFDF5] dark:bg-[#052E1C] flex items-center justify-center mx-auto mb-4"><svg className="w-7 h-7 text-[#059669]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg></div>
        <h2 className="text-[16px] font-bold text-[#0F1117] dark:text-[#F0F2FA] mb-2">Campaign Sent!</h2>
        <div className="grid grid-cols-3 gap-3 my-5">
          {[{label:"Sent",value:result.sent??1,color:"#059669"},{label:"Failed",value:result.failed??0,color:"#DC2626"},{label:"Total",value:result.total??1,color:"#2563EB"}].map(s => (
            <div key={s.label} className="bg-[#F8F9FC] dark:bg-[#13161E] rounded-xl p-3 text-center border border-[#E4E7EF] dark:border-[#262A38]"><div className="text-[22px] font-bold" style={{color:s.color}}>{s.value}</div><div className="text-[10px] text-[#8B92A9] uppercase mt-0.5">{s.label}</div></div>
          ))}
        </div>
        <button onClick={onClose} className="w-full py-2.5 rounded-xl bg-[#7C3AED] text-white text-[13px] font-semibold hover:bg-purple-700 transition">Done</button>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl bg-white dark:bg-[#1A1D27] rounded-2xl border border-[#E4E7EF] dark:border-[#262A38] overflow-hidden flex flex-col max-h-[94vh]" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-[#E4E7EF] dark:border-[#262A38] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-[#F5F3FF] dark:bg-[#1E1040] flex items-center justify-center"><svg className="w-4 h-4 text-[#7C3AED]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg></div>
            <div><h2 className="text-[15px] font-bold text-[#0F1117] dark:text-[#F0F2FA] leading-none">Send Email Blast</h2><p className="text-[11px] text-[#8B92A9] mt-0.5">Personalized bulk emails via Brevo</p></div>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg border border-[#E4E7EF] dark:border-[#262A38] flex items-center justify-center text-[#8B92A9] hover:text-[#0F1117] transition"><svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg></button>
        </div>
        <div className="px-6 pt-4 shrink-0">
          <div className="grid grid-cols-3 gap-2">
            {[{key:"campaign",label:"Campaign leads"},{key:"single",label:"Single lead"},{key:"csv",label:"CSV import"}].map(m => (
              <button key={m.key} onClick={() => { setMode(m.key); setError(""); }} className={`py-2 rounded-xl border text-[12px] font-semibold transition ${mode===m.key?"border-[#7C3AED] bg-[#F5F3FF] dark:bg-[#1E1040] text-[#7C3AED]":"border-[#E4E7EF] dark:border-[#262A38] text-[#4B5168] dark:text-[#9DA3BB]"}`}>{m.label}</button>
            ))}
          </div>
        </div>
        <div className="overflow-y-auto px-6 py-4 space-y-4">
          {mode === "campaign" && (
            <div>
              <label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Target campaign</label>
              <div className="flex gap-2">
                <select value={form.campaign} onChange={e => { setForm(p => ({ ...p, campaign: e.target.value })); setLeadCount(null); }} className={FIELD_CLS + " flex-1"}>
                  <option value="">— Select a campaign —</option>
                  {[...new Set(campaigns.filter(Boolean))].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <button onClick={handlePreview} disabled={!form.campaign||previewing} className="px-4 py-2.5 rounded-xl border border-[#E4E7EF] dark:border-[#262A38] text-[12px] font-semibold text-[#7C3AED] disabled:opacity-40 transition shrink-0">{previewing?"…":"Preview"}</button>
              </div>
              {leadCount !== null && <div className="mt-2 flex items-center gap-1.5 text-[12px]"><span className="w-2 h-2 rounded-full bg-[#7C3AED]"/><span className="text-[#7C3AED] font-semibold">{leadCount} leads</span><span className="text-[#8B92A9]">with email addresses will receive this</span></div>}
            </div>
          )}
          {mode === "single" && (
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Full name *</label><input type="text" value={singleLead.name} onChange={e => setSingleLead(p => ({...p,name:e.target.value}))} placeholder="Rahul Sharma" className={FIELD_CLS}/></div>
              <div><label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Email address *</label><input type="email" value={singleLead.email} onChange={e => setSingleLead(p => ({...p,email:e.target.value}))} placeholder="rahul@gmail.com" className={FIELD_CLS}/></div>
            </div>
          )}
          {mode === "csv" && (
            <div>
              <textarea value={csvText} onChange={e => { setCsvText(e.target.value); setCsvParsed(null); setCsvError(""); }} rows={4} className={FIELD_CLS + " font-mono text-[12px] resize-y"}/>
              <div className="flex items-center gap-2 mt-2">
                <button onClick={parseCSV} className="px-4 py-2 rounded-xl bg-[#EEF3FF] dark:bg-[#1A2540] text-[#2563EB] text-[12px] font-semibold">Parse CSV</button>
                {csvParsed && <span className="text-[12px] text-[#059669] font-semibold">✓ {csvParsed.length} recipients</span>}
              </div>
              {csvError && <p className="text-[11px] text-[#DC2626] mt-1">⚠ {csvError}</p>}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Subject *</label><input type="text" value={subject} onChange={e => setSubject(e.target.value)} placeholder="Special offer for {{name}}!" className={FIELD_CLS}/></div>
            <div><label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">From name (optional)</label><input type="text" value={fromName} onChange={e => setFromName(e.target.value)} placeholder="SkyUp CRM Team" className={FIELD_CLS}/></div>
          </div>
          <div>
            <p className="text-[11px] font-bold text-[#8B92A9] uppercase tracking-widest mb-2">Merge tags</p>
            <div className="flex flex-wrap gap-1.5">{MERGE_TAGS.map(tag => <button key={tag} onClick={() => insertTag(tag)} className="px-2.5 py-1 rounded-lg bg-[#F5F3FF] dark:bg-[#1E1040] text-[#7C3AED] text-[11px] font-mono font-semibold hover:bg-[#ede9fe] transition">{tag}</button>)}</div>
          </div>
          <div><label className="block text-[12px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Email body (HTML) *</label><textarea value={bodyTemplate} onChange={e => setBodyTemplate(e.target.value)} rows={8} className={FIELD_CLS + " font-mono text-[12px] resize-y"}/></div>
          {bodyTemplate && <div><p className="text-[11px] font-bold text-[#8B92A9] uppercase tracking-widest mb-2">Preview</p><div className="border border-[#E4E7EF] dark:border-[#262A38] rounded-xl p-4 bg-white dark:bg-[#0D0F14] text-[13px] max-h-44 overflow-y-auto" dangerouslySetInnerHTML={{ __html: bodyTemplate.replace(/{{name}}/g,"<strong>Rahul Sharma</strong>").replace(/{{campaign}}/g,form.campaign||"Summer Sale").replace(/{{mobile}}/g,"9876543210").replace(/{{email}}/g,"rahul@example.com") }}/></div>}
          {error && <div className="bg-[#FEF2F2] dark:bg-[#2D0A0A] border border-[#FECACA] dark:border-[#7F1D1D] rounded-xl px-4 py-3 text-[12px] text-[#DC2626]">⚠ {error}</div>}
        </div>
        <div className="px-6 pb-5 pt-3 border-t border-[#E4E7EF] dark:border-[#262A38] flex gap-3 shrink-0">
          <button onClick={onClose} className="px-4 py-2.5 rounded-xl border border-[#E4E7EF] dark:border-[#262A38] text-[13px] font-semibold text-[#4B5168] hover:bg-[#F8F9FC] transition">Cancel</button>
          <button onClick={handleSend} disabled={!isValid||loading} className="flex-1 py-2.5 rounded-xl bg-[#7C3AED] text-white text-[13px] font-semibold hover:bg-purple-700 disabled:opacity-40 transition flex items-center justify-center gap-2">
            {loading?<><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>Sending…</>:<>Send to {recipientLabel}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function EmailPanel() {
  const [logs, setLogs]               = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState("");
  const [pagination, setPagination]   = useState({ page: 1, limit: 10, total: 0, totalPages: 1 });
  const [search, setSearch]           = useState("");
  const [campaignFilter, setCampaignFilter] = useState("");
  const [sortOrder, setSortOrder]     = useState("desc");
  const [campaigns, setCampaigns]     = useState([]);
  const [selectedLogId, setSelectedLogId] = useState(null);
  const [deletingId, setDeletingId]   = useState(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [dateFrom, setDateFrom]       = useState("");
  const [dateTo, setDateTo]           = useState("");
  const [showBlast, setShowBlast]     = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => { api.get("/email/history/campaigns").then(r => setCampaigns(r.data.data || [])).catch(() => {}); }, []);

  const fetchLogs = useCallback(async (page = 1, searchVal = search, campaign = campaignFilter, sort = sortOrder, from = dateFrom, to = dateTo) => {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ page, limit: pagination.limit, search: searchVal, campaignId: campaign, sortOrder: sort });
      if (from) params.set("dateFrom", from);
      if (to)   params.set("dateTo", to);
      const res = await api.get(`/email/history?${params}`);
      setLogs(res.data.data || []);
      setPagination(p => ({ ...p, ...res.data.pagination, page }));
    } catch (err) { setError(err.response?.data?.message || "Failed to load email history"); }
    finally { setLoading(false); }
  }, [search, campaignFilter, sortOrder, dateFrom, dateTo, pagination.limit]);

  useEffect(() => { fetchLogs(1); }, []);

  const handleSearchChange = val => {
    setSearch(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchLogs(1, val, campaignFilter, sortOrder), 400);
  };

  const handleExportCSV = async () => {
    setExportLoading(true);
    try {
      const params = new URLSearchParams({ page: 1, limit: 5000, search, campaignId: campaignFilter, sortOrder });
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo)   params.set("dateTo", dateTo);
      const res  = await api.get(`/email/history?${params}`);
      const data = res.data.data || [];
      if (data.length === 0) { alert("No records to export"); return; }
      const headers = ["Recipient","Subject","Campaign","Status","Sent At","Error"];
      const rows    = data.map(l => [`"${l.to}"`,`"${l.subject.replace(/"/g,'""')}"`,`"${l.campaignId||""}"`,l.status,fmtDate(l.sentAt),`"${l.errorMessage||""}"`]);
      const csv     = [headers,...rows].map(r => r.join(",")).join("\n");
      const blob    = new Blob([csv], { type: "text/csv" });
      const url     = URL.createObjectURL(blob);
      const a       = document.createElement("a"); a.href = url; a.download = `email-history-${Date.now()}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch { alert("Export failed"); }
    finally { setExportLoading(false); }
  };

  const handleDelete = async id => {
    if (!window.confirm("Delete this log entry?")) return;
    setDeletingId(id);
    try { await api.delete(`/email/history/${id}`); fetchLogs(pagination.page); }
    catch { alert("Failed to delete log"); }
    finally { setDeletingId(null); }
  };

  const sentCount   = logs.filter(l => l.status === "sent").length;
  const failedCount = logs.filter(l => l.status === "failed").length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center sm:justify-between gap-2 sm:gap-3 mb-4 shrink-0">
        <p className="text-[13px] text-[#8B92A9]">{loading ? "Loading…" : `${pagination.total.toLocaleString()} total emails logged`}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => fetchLogs(pagination.page)} className="w-9 h-9 rounded-xl border border-[#E4E7EF] dark:border-[#262A38] flex items-center justify-center text-[#8B92A9] hover:text-[#2563EB] hover:border-[#2563EB] transition">
            <svg className={`w-4 h-4 ${loading?"animate-spin":""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
          </button>
          <button onClick={handleExportCSV} disabled={exportLoading} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#059669] text-white text-[13px] font-semibold hover:bg-green-700 disabled:opacity-50 transition">
            {exportLoading?<svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>:<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>}
            Export CSV
          </button>
          <button onClick={() => setShowBlast(true)} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#7C3AED] text-white text-[13px] font-semibold hover:bg-purple-700 transition">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>
            Send Email
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-3 shrink-0">
        {[{label:"This page",value:logs.length,color:"#2563EB"},{label:"Sent",value:sentCount,color:"#059669"},{label:"Failed",value:failedCount,color:"#DC2626"},{label:"All time",value:pagination.total,color:"#7C3AED"}].map(s => (
          <div key={s.label} className="flex items-center gap-2 bg-white dark:bg-[#1A1D27] border border-[#E4E7EF] dark:border-[#262A38] rounded-xl px-3 py-2">
            <span className="w-2 h-2 rounded-full shrink-0" style={{background:s.color}}/><span className="text-[13px] font-bold text-[#0F1117] dark:text-[#F0F2FA]">{s.value.toLocaleString()}</span><span className="text-[11px] text-[#8B92A9]">{s.label}</span>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4 shrink-0">
        <div className="relative w-full sm:flex-1 sm:min-w-[180px] sm:max-w-xs">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#8B92A9]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z"/></svg>
          <input type="text" value={search} onChange={e => handleSearchChange(e.target.value)} placeholder="Search by recipient…" className="pl-8 pr-4 py-2 w-full rounded-xl border border-[#E4E7EF] dark:border-[#262A38] bg-white dark:bg-[#1A1D27] text-[12px] placeholder:text-[#8B92A9] focus:outline-none focus:border-[#2563EB] transition"/>
          {search && <button onClick={() => handleSearchChange("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#8B92A9]"><svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg></button>}
        </div>
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <select value={campaignFilter} onChange={e => { setCampaignFilter(e.target.value); fetchLogs(1,search,e.target.value,sortOrder); }} className="flex-1 sm:flex-none px-3 py-2 rounded-xl border border-[#E4E7EF] dark:border-[#262A38] bg-white dark:bg-[#1A1D27] text-[12px] focus:outline-none focus:border-[#2563EB] transition"><option value="">All Source</option>{campaigns.map(c => <option key={c} value={c}>{c}</option>)}</select>
          <input type="date" value={dateFrom} max={dateTo||undefined} onChange={e => { setDateFrom(e.target.value); fetchLogs(1,search,campaignFilter,sortOrder,e.target.value,dateTo); }} className="flex-1 sm:flex-none px-3 py-2 rounded-xl border border-[#E4E7EF] dark:border-[#262A38] bg-white dark:bg-[#1A1D27] text-[12px] focus:outline-none focus:border-[#2563EB] transition sm:w-[140px]"/>
          <span className="text-[12px] text-[#8B92A9] hidden sm:inline">to</span>
          <input type="date" value={dateTo} min={dateFrom||undefined} onChange={e => { setDateTo(e.target.value); fetchLogs(1,search,campaignFilter,sortOrder,dateFrom,e.target.value); }} className="flex-1 sm:flex-none px-3 py-2 rounded-xl border border-[#E4E7EF] dark:border-[#262A38] bg-white dark:bg-[#1A1D27] text-[12px] focus:outline-none focus:border-[#2563EB] transition sm:w-[140px]"/>
          {(dateFrom||dateTo) && <button onClick={() => { setDateFrom(""); setDateTo(""); fetchLogs(1,search,campaignFilter,sortOrder,"",""); }} className="px-3 py-2 rounded-xl border border-[#E4E7EF] dark:border-[#262A38] text-[12px] text-[#8B92A9] hover:text-[#DC2626] hover:border-[#DC2626] transition">✕ Clear</button>}
          <select value={sortOrder} onChange={e => { setSortOrder(e.target.value); fetchLogs(1,search,campaignFilter,e.target.value,dateFrom,dateTo); }} className="flex-1 sm:flex-none px-3 py-2 rounded-xl border border-[#E4E7EF] dark:border-[#262A38] bg-white dark:bg-[#1A1D27] text-[12px] focus:outline-none focus:border-[#2563EB] transition"><option value="desc">Newest first</option><option value="asc">Oldest first</option></select>
        </div>
      </div>

      {error && <div className="bg-[#FEF2F2] dark:bg-[#2D0A0A] border border-[#FECACA] dark:border-[#7F1D1D] rounded-xl px-4 py-3 text-[12px] text-[#DC2626] mb-3 shrink-0">⚠ {error}</div>}

      <div className="flex-1 overflow-auto bg-white dark:bg-[#1A1D27] border border-[#E4E7EF] dark:border-[#262A38] rounded-2xl min-h-0">
        <table className="w-full min-w-[500px]">
          <thead>
            <tr className="border-b border-[#E4E7EF] dark:border-[#262A38] bg-[#F8F9FC] dark:bg-[#13161E]">
              {["Recipient","Subject","Source","Status","Sent At",""].map((h,i) => <th key={h} className={`px-4 py-3 text-left text-[11px] font-bold text-[#8B92A9] uppercase tracking-wide whitespace-nowrap ${i===2?"hidden sm:table-cell":""}`}>{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E4E7EF] dark:divide-[#262A38]">
            {loading ? Array.from({length:6}).map((_,i) => <SkeletonRow key={i}/>) : logs.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-16 text-center">
                <div className="text-[36px] mb-3">📭</div>
                <p className="text-[14px] font-semibold text-[#4B5168] dark:text-[#9DA3BB]">No email logs found</p>
                <p className="text-[12px] text-[#8B92A9] mt-1">{search||campaignFilter||dateFrom||dateTo?"Try clearing your filters.":"Send emails to start tracking history."}</p>
              </td></tr>
            ) : logs.map(log => (
              <tr key={log._id} className="hover:bg-[#F8F9FC] dark:hover:bg-[#13161E] transition-colors cursor-pointer" onClick={() => setSelectedLogId(log._id)}>
                <td className="px-4 py-3"><div className="flex items-center gap-2"><div className="w-7 h-7 rounded-full bg-[#F5F3FF] dark:bg-[#1E1040] flex items-center justify-center text-[10px] font-bold text-[#7C3AED] shrink-0">{log.to?.charAt(0)?.toUpperCase()||"?"}</div><span className="text-[12px] font-medium text-[#0F1117] dark:text-[#F0F2FA] max-w-[160px] truncate">{log.to}</span></div></td>
                <td className="px-4 py-3"><span className="text-[12px] text-[#4B5168] dark:text-[#9DA3BB] max-w-[200px] truncate block">{log.subject}</span></td>
                <td className="px-4 py-3 hidden sm:table-cell">{log.campaignId?<span className="inline-block px-2.5 py-1 rounded-full bg-[#EEF3FF] dark:bg-[#1A2540] text-[#2563EB] dark:text-[#4F8EF7] text-[11px] font-semibold max-w-[140px] truncate">{log.campaignId}</span>:<span className="text-[12px] text-[#8B92A9]">—</span>}</td>
                <td className="px-4 py-3"><StatusBadge status={log.status}/></td>
                <td className="px-4 py-3"><span className="text-[12px] text-[#8B92A9] whitespace-nowrap">{fmtDate(log.sentAt)}</span></td>
                <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                  <button onClick={() => handleDelete(log._id)} disabled={deletingId===log._id} className="p-1.5 rounded-lg text-[#8B92A9] hover:text-[#DC2626] hover:bg-[#FEF2F2] dark:hover:bg-[#2D0A0A] transition disabled:opacity-40">
                    {deletingId===log._id?<svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>:<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {pagination.totalPages > 1 && (
          <div className="px-4 py-3 border-t border-[#E4E7EF] dark:border-[#262A38] flex items-center justify-between">
            <span className="text-[12px] text-[#8B92A9]">Page {pagination.page} of {pagination.totalPages} · {pagination.total} total</span>
            <div className="flex items-center gap-1.5">
              <button disabled={pagination.page<=1} onClick={() => fetchLogs(pagination.page-1)} className="px-3 py-1.5 rounded-lg border border-[#E4E7EF] dark:border-[#262A38] text-[12px] font-semibold text-[#4B5168] disabled:opacity-40 hover:border-[#2563EB] hover:text-[#2563EB] transition">← Prev</button>
              {Array.from({length:Math.min(5,pagination.totalPages)},(_,i)=>{ const start=Math.max(1,Math.min(pagination.page-2,pagination.totalPages-4)); const p=start+i; if(p>pagination.totalPages)return null; return <button key={p} onClick={()=>fetchLogs(p)} className={`w-8 h-8 rounded-lg text-[12px] font-semibold transition ${p===pagination.page?"bg-[#2563EB] text-white":"border border-[#E4E7EF] dark:border-[#262A38] text-[#4B5168] hover:border-[#2563EB] hover:text-[#2563EB]"}`}>{p}</button>; })}
              <button disabled={pagination.page>=pagination.totalPages} onClick={() => fetchLogs(pagination.page+1)} className="px-3 py-1.5 rounded-lg border border-[#E4E7EF] dark:border-[#262A38] text-[12px] font-semibold text-[#4B5168] disabled:opacity-40 hover:border-[#2563EB] hover:text-[#2563EB] transition">Next →</button>
            </div>
          </div>
        )}
      </div>
      {selectedLogId && <LogDetailModal logId={selectedLogId} onClose={() => setSelectedLogId(null)}/>}
      {showBlast && <EmailBlastModal onClose={() => setShowBlast(false)}/>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── SMS PANEL — Refactored into SmsSidebar + SmsRightPanel components
// ─────────────────────────────────────────────────────────────────────────────
function SmsStatusTick({ status }) {
  if (status === "sent") return (
    <svg className="w-4 h-4 text-[#34B7F1] inline-block" viewBox="0 0 16 11" fill="currentColor">
      <path d="M11.071.653a.75.75 0 0 1 .025 1.06l-6.5 7a.75.75 0 0 1-1.092-.013l-3-3.5a.75.75 0 1 1 1.14-.977l2.46 2.87 5.908-6.415a.75.75 0 0 1 1.059-.025z"/>
      <path d="M14.071.653a.75.75 0 0 1 .025 1.06l-6.5 7a.75.75 0 0 1-1.085.013L4.54 6.653a.75.75 0 0 1 1.14-.977l1.502 1.752 5.83-6.75a.75.75 0 0 1 1.059-.025z"/>
    </svg>
  );
  return (
    <svg className="w-3.5 h-3.5 text-[#8B92A9] inline-block" viewBox="0 0 16 11" fill="currentColor">
      <path d="M11.071.653a.75.75 0 0 1 .025 1.06l-6.5 7a.75.75 0 0 1-1.092-.013l-3-3.5a.75.75 0 1 1 1.14-.977l2.46 2.87 5.908-6.415a.75.75 0 0 1 1.059-.025z"/>
    </svg>
  );
}

function SmsAvatar({ name, size = "md" }) {
  const initials = (name || "?").split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2);
  const colors   = ["#EA580C","#7C3AED","#0284C7","#059669","#DC2626","#D97706","#0891B2"];
  const color    = colors[(name || "?").charCodeAt(0) % colors.length];
  const sz       = size === "sm" ? "w-9 h-9 text-[11px]" : "w-11 h-11 text-[13px]";
  return <div className={`${sz} rounded-full flex items-center justify-center font-bold text-white shrink-0`} style={{ background: color }}>{initials}</div>;
}

function SmsBubble({ log }) {
  return (
    <div className="flex justify-end mb-2 px-4">
      <div className="max-w-[75%]">
        <div className="bg-[#DCF8C6] dark:bg-[#005C4B] rounded-2xl rounded-tr-sm px-4 py-2.5 shadow-sm">
          <p className="text-[13px] text-[#111B21] dark:text-[#E9EDEF] leading-relaxed whitespace-pre-wrap break-words">{log.message}</p>
          <div className="flex items-center justify-end gap-1 mt-1">
            <span className="text-[10px] text-[#667781] dark:text-[#8696A0]">{formatTime(log.sentAt)}</span>
            <SmsStatusTick status={log.status}/>
          </div>
        </div>
        {log.status === "failed" && log.errorMessage && <p className="text-[10px] text-[#DC2626] mt-0.5 text-right">{log.errorMessage}</p>}
      </div>
    </div>
  );
}

// ── SmsSidebar ────────────────────────────────────────────────────────────────
function SmsSidebar({ leads, loading, stats, campaigns, selectedLead, onSelectLead, onBlast, search, onSearchChange, campaignFilter, onCampaignChange, visible }) {
  return (
    <div className={`w-full sm:w-[300px] lg:w-[340px] shrink-0 flex flex-col bg-white dark:bg-[#111B21] border-r border-[#E4E7EF] dark:border-[#2A3942] overflow-hidden h-full ${visible ? "flex" : "hidden sm:flex"}`}>
      {/* Header */}
      <div className="bg-[#075E54] dark:bg-[#202C33] px-4 py-3 flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-[15px] font-bold text-white leading-none">SMS</h2>
          <p className="text-[11px] text-[#8FB8A8] mt-0.5">{stats.total} total messages</p>
        </div>
        <button onClick={onBlast} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#25D366] hover:bg-[#20B858] text-white text-[12px] font-semibold transition">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>
          Blast
        </button>
      </div>

      {/* Stats */}
      <div className="flex gap-2 px-4 py-2 bg-[#F0F2F5] dark:bg-[#202C33] border-b border-[#E4E7EF] dark:border-[#2A3942] shrink-0">
        {[{label:"sent",value:stats.sent,color:"bg-[#059669]"},{label:"failed",value:stats.failed,color:"bg-[#DC2626]"},{label:"leads",value:leads.length,color:"bg-[#7C3AED]"}].map(s => (
          <div key={s.label} className="flex items-center gap-1.5 bg-white dark:bg-[#2A3942] rounded-lg px-2.5 py-1.5">
            <span className={`w-2 h-2 rounded-full ${s.color}`}/><span className="text-[11px] font-bold text-[#111B21] dark:text-[#E9EDEF]">{s.value}</span><span className="text-[10px] text-[#667781]">{s.label}</span>
          </div>
        ))}
      </div>

      {/* Search + filter */}
      <div className="px-3 py-2 bg-[#F0F2F5] dark:bg-[#202C33] flex gap-2 border-b border-[#E4E7EF] dark:border-[#2A3942] shrink-0">
        <div className="relative flex-1">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#8B92A9]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z"/></svg>
          <input type="text" value={search} onChange={e => onSearchChange(e.target.value)} placeholder="Search contacts…" className="w-full pl-8 pr-3 py-2 bg-white dark:bg-[#2A3942] rounded-xl text-[12px] text-[#111B21] dark:text-[#E9EDEF] placeholder:text-[#8B92A9] focus:outline-none"/>
        </div>
        <select value={campaignFilter} onChange={e => onCampaignChange(e.target.value)} className="px-2 py-2 bg-white dark:bg-[#2A3942] rounded-xl text-[11px] text-[#111B21] dark:text-[#E9EDEF] focus:outline-none">
          <option value="">All</option>
          {campaigns.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Lead list — this is the only scrollable area */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          Array.from({length:6}).map((_,i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-[#F0F2FA] dark:border-[#1E2130]">
              <div className="w-11 h-11 rounded-full bg-[#F1F5F9] dark:bg-[#1A1D27] animate-pulse shrink-0"/>
              <div className="flex-1 space-y-2"><div className="h-3 w-32 rounded bg-[#F1F5F9] dark:bg-[#1A1D27] animate-pulse"/><div className="h-2.5 w-48 rounded bg-[#F1F5F9] dark:bg-[#1A1D27] animate-pulse"/></div>
            </div>
          ))
        ) : leads.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 p-8 opacity-60">
            <div className="text-4xl">📱</div>
            <p className="text-[13px] text-[#667781] text-center">No SMS contacts yet. Send your first blast!</p>
          </div>
        ) : (
          leads.map(lead => <SmsLeadRow key={lead.to} lead={lead} isActive={selectedLead?.to === lead.to} onClick={() => onSelectLead(lead)}/>)
        )}
      </div>
    </div>
  );
}

function SmsLeadRow({ lead, isActive, onClick }) {
  const lastMsg     = lead.lastMessage || "";
  const lastTime    = lead.lastSentAt ? timeAgo(lead.lastSentAt) : "";
  const failedCount = lead.failedCount || 0;
  const sentCount   = lead.sentCount || 0;
  const hasSms      = lead.hasSmsHistory;
  return (
    <button onClick={onClick} className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-[#F0F2FA] dark:hover:bg-[#1A1D27] transition-colors text-left border-b border-[#F0F2FA] dark:border-[#1E2130] ${isActive?"bg-[#F0F2FA] dark:bg-[#1A1D27]":""}`}>
      <div className="relative shrink-0">
        <SmsAvatar name={lead.recipientName||lead.to}/>
        {hasSms && <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-[#25D366] border-2 border-white dark:border-[#111B21] flex items-center justify-center"><svg className="w-2 h-2 text-white" viewBox="0 0 16 11" fill="currentColor"><path d="M11.071.653a.75.75 0 0 1 .025 1.06l-6.5 7a.75.75 0 0 1-1.092-.013l-3-3.5a.75.75 0 1 1 1.14-.977l2.46 2.87 5.908-6.415a.75.75 0 0 1 1.059-.025z"/></svg></span>}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-1">
          <span className="text-[13px] font-semibold text-[#111B21] dark:text-[#E9EDEF] truncate">{lead.recipientName||lead.to}</span>
          {lastTime && <span className={`text-[11px] shrink-0 ${failedCount>0?"text-[#DC2626]":"text-[#8B92A9] dark:text-[#565C75]"}`}>{lastTime}</span>}
        </div>
        <div className="flex items-center justify-between gap-1 mt-0.5">
          <p className="text-[12px] text-[#667781] dark:text-[#8696A0] truncate flex-1">{hasSms?(lastMsg||lead.to):<span className="italic opacity-60">{lead.to}</span>}</p>
          {failedCount>0 && <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-[#DC2626] text-white text-[10px] font-bold flex items-center justify-center">{failedCount}</span>}
          {failedCount===0 && sentCount>0 && <span className="shrink-0 text-[10px] text-[#059669] font-semibold">{sentCount} ✓</span>}
          {!hasSms && <span className="shrink-0 text-[10px] text-[#8B92A9] italic">no SMS</span>}
        </div>
        {lead.campaignId && <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded-full bg-[#FFF7ED] dark:bg-[#1c0a00] text-[#EA580C] text-[9px] font-semibold truncate max-w-[140px]">{lead.campaignId}</span>}
      </div>
    </button>
  );
}

// ── SmsRightPanel ─────────────────────────────────────────────────────────────
function SmsRightPanel({ selectedLead, showComposer, onBack, onSent, visible }) {
  return (
    <div className={`flex-1 flex flex-col overflow-hidden min-w-0 h-full ${visible ? "flex" : "hidden sm:flex"}`}>
      {selectedLead ? (
        <SmsLeadThread lead={selectedLead} onBack={onBack} onSend={onSent}/>
      ) : showComposer ? (
        <SmsBlastComposer onSent={onSent}/>
      ) : (
        <SmsEmptyState onBlast={onSent}/>
      )}
    </div>
  );
}

function SmsEmptyState({ onBlast }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-[#EFEAE2] dark:bg-[#0B141A] gap-4 h-full">
      <div className="w-20 h-20 rounded-full bg-[#EA580C]/10 flex items-center justify-center">
        <svg className="w-10 h-10 text-[#EA580C]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/></svg>
      </div>
      <div className="text-center">
        <h3 className="text-[16px] font-bold text-[#111B21] dark:text-[#E9EDEF]">SMS Communications</h3>
        <p className="text-[13px] text-[#667781] dark:text-[#8696A0] mt-1">Select a contact to view thread or blast to send SMS</p>
      </div>
      <button onClick={onBlast} className="flex items-center gap-2 px-6 py-3 rounded-full bg-[#25D366] hover:bg-[#20B858] text-white text-[13px] font-semibold transition shadow-md">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>
        Send SMS Blast
      </button>
    </div>
  );
}

function SmsLeadThread({ lead, onBack, onSend }) {
  const [logs, setLogs]               = useState([]);
  const [loading, setLoading]         = useState(true);
  const [message, setMessage]         = useState("");
  const [templateId, setTemplateId]   = useState("");
  const [senderId, setSenderId]       = useState("");
  const [sending, setSending]         = useState(false);
  const [showConfig, setShowConfig]   = useState(false);
  const [authKey, setAuthKey]         = useState("");
  const [configSaved, setConfigSaved] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    api.get("/sms-config").then(r => { if(r.data?.data){ setAuthKey(r.data.data.msg91AuthKey||""); setSenderId(r.data.data.msg91SenderId||""); } }).catch(()=>{});
  }, []);

  useEffect(() => {
    setLoading(true);
    api.get(`/sms/history?search=${encodeURIComponent(lead.to)}&limit=100&sortOrder=asc`).then(r => setLogs(r.data.data||[])).catch(()=>{}).finally(()=>setLoading(false));
  }, [lead.to]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);

  const handleSaveConfig = async () => {
    if (!authKey.trim()) return alert("Auth Key cannot be empty");
    setConfigSaving(true);
    try { await api.put("/sms-config", { msg91AuthKey: authKey.trim(), msg91SenderId: senderId.trim()||"SKYCRM" }); setConfigSaved(true); setTimeout(()=>setConfigSaved(false),2500); }
    catch (err) { alert(err.response?.data?.message||"Failed to save config"); }
    finally { setConfigSaving(false); }
  };

  const handleSend = async () => {
    if (!message.trim()) return;
    setSending(true);
    try {
      await api.post("/sms-campaign/send-single", { name: lead.recipientName||"", mobile: lead.to, message, templateId: templateId||undefined, senderId: senderId||undefined });
      setLogs(prev => [...prev, { _id: Date.now(), to: lead.to, recipientName: lead.recipientName, message, status: "sent", sentAt: new Date().toISOString(), campaignId: null }]);
      setMessage("");
      if (onSend) onSend();
    } catch (err) { alert(err.response?.data?.message||"Failed to send SMS"); }
    finally { setSending(false); }
  };

  const name = lead.recipientName || lead.to;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="bg-[#075E54] dark:bg-[#202C33] px-4 py-3 flex items-center gap-3 shrink-0">
        <button onClick={onBack} className="text-white/70 hover:text-white transition mr-1 sm:hidden">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/></svg>
        </button>
        <SmsAvatar name={name} size="sm"/>
        <div className="flex-1 min-w-0">
          <h3 className="text-[14px] font-semibold text-white leading-none truncate">{name}</h3>
          <p className="text-[11px] text-[#8FB8A8] mt-0.5">{lead.to}{lead.campaignId?` · ${lead.campaignId}`:""}</p>
        </div>
        <button onClick={() => setShowConfig(s => !s)} className={`w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center transition ${showConfig?"bg-white/20 text-white":"text-white/70 hover:text-white"}`}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
        </button>
      </div>

      {/* Config drawer */}
      {showConfig && (
        <div className="bg-[#F0F2F5] dark:bg-[#202C33] px-4 py-3 border-b border-[#E4E7EF] dark:border-[#2A3942] shrink-0">
          <p className="text-[10px] font-bold text-[#667781] dark:text-[#8696A0] uppercase tracking-widest mb-2.5">MSG91 Settings</p>
          <div className="flex gap-3 flex-wrap">
            <div className="flex-1 min-w-[160px]">
              <label className="block text-[10px] font-semibold text-[#667781] dark:text-[#8696A0] mb-1">Auth Key <span className="text-[#DC2626]">*</span></label>
              <input type="password" value={authKey} onChange={e => setAuthKey(e.target.value)} placeholder="447171TxxxXXXX67f2b4e5" className={FIELD_CLS}/>
            </div>
            <div className="w-28">
              <label className="block text-[10px] font-semibold text-[#667781] dark:text-[#8696A0] mb-1">Sender ID</label>
              <input type="text" maxLength={6} value={senderId} onChange={e => setSenderId(e.target.value.toUpperCase())} placeholder="SKYCRM" className={FIELD_CLS}/>
            </div>
            <div className="flex-1 min-w-[160px]">
              <label className="block text-[10px] font-semibold text-[#667781] dark:text-[#8696A0] mb-1">DLT Template ID</label>
              <input type="text" value={templateId} onChange={e => setTemplateId(e.target.value)} placeholder="1234567890123456789" className={FIELD_CLS}/>
            </div>
            <div className="flex items-end pb-[18px]">
              <button onClick={handleSaveConfig} disabled={configSaving||!authKey.trim()} className="px-4 py-2 rounded-lg bg-[#25D366] hover:bg-[#20B858] disabled:opacity-40 text-white text-[11px] font-semibold transition whitespace-nowrap">
                {configSaving?"Saving…":configSaved?"✓ Saved!":"Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Messages — scrollable */}
      <div className="flex-1 overflow-y-auto py-4 min-h-0"
        style={{ background: "url(\"data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23000000' fill-opacity='0.03'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E\")" }}>
        {loading ? (
          <div className="flex justify-center items-center h-full"><svg className="w-6 h-6 animate-spin text-[#25D366]" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg></div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 opacity-60">
            <svg className="w-12 h-12 text-[#667781]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}><path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/></svg>
            <p className="text-[13px] text-[#667781] dark:text-[#8696A0]">No messages yet</p>
          </div>
        ) : logs.map(log => <SmsBubble key={log._id} log={log}/>)}
        <div ref={bottomRef}/>
      </div>

      {/* Input bar */}
      <div className="bg-[#F0F2F5] dark:bg-[#202C33] px-3 py-2.5 flex items-end gap-2 shrink-0">
        <div className="flex-1 bg-white dark:bg-[#2A3942] rounded-2xl px-4 py-2 min-h-[42px] flex items-center">
          <textarea value={message} onChange={e => setMessage(e.target.value)} onKeyDown={e => { if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();handleSend();} }} rows={1} placeholder="Type a message"
            className="w-full bg-transparent text-[13px] text-[#111B21] dark:text-[#E9EDEF] placeholder:text-[#8B92A9] resize-none focus:outline-none leading-relaxed" style={{maxHeight:"100px",overflowY:"auto"}}/>
        </div>
        <button onClick={handleSend} disabled={sending||!message.trim()} className="w-11 h-11 rounded-full bg-[#25D366] hover:bg-[#20B858] disabled:opacity-40 flex items-center justify-center transition shadow-md shrink-0">
          {sending ? <svg className="w-4 h-4 animate-spin text-white" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>
                   : <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>}
        </button>
      </div>
    </div>
  );
}

function SmsBlastComposer({ onSent }) {
  const [mode, setMode]             = useState("campaign");
  const [form, setForm]             = useState({ campaign: "" });
  const [singleLead, setSingleLead] = useState({ name: "", mobile: "" });
  const [csvText, setCsvText]       = useState("name,mobile\nRahul Sharma,919876543210");
  const [csvParsed, setCsvParsed]   = useState(null);
  const [csvError, setCsvError]     = useState("");
  const [message, setMessage]       = useState("");
  const [templateId, setTemplateId] = useState("");
  const [senderId, setSenderId]     = useState("");
  const [leadCount, setLeadCount]   = useState(null);
  const [campaigns, setCampaigns]   = useState([]);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState("");
  const [result, setResult]         = useState(null);

  const MERGE_TAGS = ["{{name}}","{{mobile}}","{{email}}","{{campaign}}"];
  const charCount  = message.length;
  const smsCount   = charCount === 0 ? 0 : Math.ceil(charCount/160);

  useEffect(() => { api.get("/lead/distinct-campaigns").then(r => setCampaigns(r.data.data||[])).catch(()=>{}); }, []);
  useEffect(() => {
    setLeadCount(null);
    if (mode==="campaign" && form.campaign) { api.get(`/sms-campaign/preview?campaign=${encodeURIComponent(form.campaign)}`).then(r=>setLeadCount(r.data.count)).catch(()=>{}); }
  }, [form.campaign,mode]);

  const parseCsv = () => {
    setCsvError(""); setCsvParsed(null);
    const lines = csvText.trim().split("\n").filter(Boolean);
    if (lines.length<2) return setCsvError("CSV needs a header row + at least one data row");
    const header   = lines[0].split(",").map(h=>h.trim().toLowerCase());
    const mobileIdx = header.indexOf("mobile");
    if (mobileIdx===-1) return setCsvError("CSV must have a 'mobile' column");
    const nameIdx = header.indexOf("name");
    const rows = lines.slice(1).map(line => { const cols=line.split(",").map(c=>c.trim().replace(/^"|"$/g,"")); return {name:nameIdx!==-1?cols[nameIdx]:"Friend",mobile:cols[mobileIdx]}; }).filter(r=>r.mobile&&r.mobile.replace(/\D/g,"").length>=10);
    if (rows.length===0) return setCsvError("No valid mobile rows found");
    setCsvParsed(rows);
  };

  const handleSend = async () => {
    if (!message.trim()) return setError("Message body is required");
    setLoading(true); setError("");
    try {
      let res;
      if (mode==="campaign") {
        if (!form.campaign) { setError("Please select a campaign"); setLoading(false); return; }
        if (!window.confirm(`Send SMS to ${leadCount??"?"} leads in "${form.campaign}"?`)) { setLoading(false); return; }
        res = await api.post("/sms-campaign/send",{campaign:form.campaign,message,templateId:templateId||undefined,senderId:senderId||undefined});
      } else if (mode==="single") {
        if (!singleLead.mobile) { setError("Mobile number is required"); setLoading(false); return; }
        if (!window.confirm(`Send SMS to ${singleLead.name||singleLead.mobile}?`)) { setLoading(false); return; }
        res = await api.post("/sms-campaign/send-single",{name:singleLead.name,mobile:singleLead.mobile,message,templateId:templateId||undefined,senderId:senderId||undefined});
      } else {
        if (!csvParsed) { setError("Parse your CSV first"); setLoading(false); return; }
        if (!window.confirm(`Send SMS to ${csvParsed.length} recipients?`)) { setLoading(false); return; }
        res = await api.post("/sms-campaign/send-csv",{recipients:csvParsed,message,templateId:templateId||undefined,senderId:senderId||undefined});
      }
      setResult({success:true,message:res.data.message,total:res.data.total});
      if (onSent) onSent();
    } catch (err) { setError(err.response?.data?.message||err.response?.data?.error||"Failed to send SMS"); }
    finally { setLoading(false); }
  };

  const isValid = message.trim() && (mode==="campaign"?!!form.campaign:mode==="single"?!!singleLead.mobile:!!csvParsed);
  const recipientLabel = mode==="campaign"&&leadCount!==null?`${leadCount} leads`:mode==="single"&&singleLead.mobile?"1 recipient":mode==="csv"&&csvParsed?`${csvParsed.length} recipients`:"recipients";
  const previewMsg = message.replace(/{{name}}/g,singleLead.name||"Rahul Sharma").replace(/{{mobile}}/g,singleLead.mobile||"9876543210").replace(/{{campaign}}/g,form.campaign||"Campaign").replace(/{{email}}/g,"rahul@example.com");

  if (result) return (
    <div className="flex-1 flex flex-col items-center justify-center bg-[#EFEAE2] dark:bg-[#0B141A] gap-4 h-full">
      <div className="w-20 h-20 rounded-full bg-[#25D366]/10 flex items-center justify-center mb-2">
        <svg className="w-10 h-10 text-[#25D366]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
      </div>
      <h3 className="text-[18px] font-bold text-[#111B21] dark:text-[#E9EDEF]">SMS Blast Queued!</h3>
      <p className="text-[13px] text-[#667781] dark:text-[#8696A0] text-center max-w-xs">{result.message}</p>
      <button onClick={()=>setResult(null)} className="mt-2 px-6 py-2.5 rounded-full bg-[#25D366] text-white text-[13px] font-semibold hover:bg-[#20B858] transition">Send Another</button>
    </div>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#EFEAE2] dark:bg-[#0B141A]">
      {/* Header */}
      <div className="bg-[#075E54] dark:bg-[#202C33] px-4 py-3 flex items-center gap-3 shrink-0">
        <div className="w-9 h-9 rounded-full bg-[#EA580C] flex items-center justify-center">
          <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>
        </div>
        <div><h3 className="text-[14px] font-semibold text-white leading-none">New SMS Blast</h3><p className="text-[11px] text-[#8FB8A8] mt-0.5">via MSG91 · DLT compliant</p></div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto min-h-0 px-4 py-4 space-y-4">
        <div className="flex justify-center">
          <div className="bg-[#FFF7C7] dark:bg-[#2A2519] rounded-lg px-4 py-2 max-w-sm text-center shadow-sm">
            <p className="text-[11px] text-[#7B6914] dark:text-[#CDB648] leading-relaxed">📋 MSG91 requires a <strong>DLT Template ID</strong> for Indian numbers. Use <code className="bg-yellow-200 dark:bg-yellow-900 px-1 rounded">{"{{name}}"}</code> to personalise.</p>
          </div>
        </div>

        {/* Mode selector */}
        <div className="bg-white dark:bg-[#202C33] rounded-2xl p-4 shadow-sm">
          <p className="text-[11px] font-semibold text-[#667781] dark:text-[#8696A0] uppercase tracking-wide mb-2">Send to</p>
          <div className="flex gap-2">
            {[{key:"campaign",label:"CRM Campaign",icon:"🎯"},{key:"single",label:"Single Number",icon:"📱"},{key:"csv",label:"CSV Upload",icon:"📄"}].map(m => (
              <button key={m.key} onClick={()=>setMode(m.key)} className={`flex-1 py-2 px-2 rounded-xl text-[11px] font-semibold border transition ${mode===m.key?"bg-[#DCF8C6] dark:bg-[#005C4B] border-[#25D366] text-[#075E54] dark:text-[#E9EDEF]":"border-[#E4E7EF] dark:border-[#2A3942] text-[#8B92A9]"}`}>
                <span className="mr-1">{m.icon}</span>{m.label}
              </button>
            ))}
          </div>
        </div>

        {/* Mode fields */}
        <div className="bg-white dark:bg-[#202C33] rounded-2xl p-4 shadow-sm space-y-3">
          {mode==="campaign" && (
            <div>
              <label className="block text-[11px] font-semibold text-[#667781] dark:text-[#8696A0] mb-1.5">Campaign <span className="text-[#DC2626]">*</span></label>
              <select value={form.campaign} onChange={e=>setForm(p=>({...p,campaign:e.target.value}))} className={FIELD_CLS}>
                <option value="">— Select campaign —</option>
                {campaigns.map(c=><option key={c} value={c}>{c}</option>)}
              </select>
              {leadCount!==null && <p className="text-[11px] text-[#8B92A9] mt-1"><span className="font-bold text-[#EA580C]">{leadCount}</span> leads with mobile numbers</p>}
            </div>
          )}
          {mode==="single" && (
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-[11px] font-semibold text-[#667781] dark:text-[#8696A0] mb-1.5">Name</label><input type="text" value={singleLead.name} onChange={e=>setSingleLead(p=>({...p,name:e.target.value}))} placeholder="Rahul Sharma" className={FIELD_CLS}/></div>
              <div><label className="block text-[11px] font-semibold text-[#667781] dark:text-[#8696A0] mb-1.5">Mobile <span className="text-[#DC2626]">*</span></label><input type="tel" value={singleLead.mobile} onChange={e=>setSingleLead(p=>({...p,mobile:e.target.value}))} placeholder="919876543210" className={FIELD_CLS}/></div>
            </div>
          )}
          {mode==="csv" && (
            <div>
              <textarea value={csvText} onChange={e=>{setCsvText(e.target.value);setCsvParsed(null);setCsvError("");}} rows={4} className={FIELD_CLS+" font-mono text-[11px] resize-y"}/>
              <div className="flex items-center gap-2 mt-1.5">
                <button onClick={parseCsv} className="px-3 py-1.5 rounded-lg bg-[#F1F5F9] dark:bg-[#2A3942] text-[11px] font-semibold text-[#4B5168] border border-[#E4E7EF] dark:border-[#2A3942] transition">Parse CSV</button>
                {csvParsed && <span className="text-[11px] text-[#059669] font-semibold">✓ {csvParsed.length} valid rows</span>}
                {csvError  && <span className="text-[11px] text-[#DC2626]">⚠ {csvError}</span>}
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-[#F1F5F9] dark:border-[#2A3942]">
            <div><label className="block text-[11px] font-semibold text-[#667781] dark:text-[#8696A0] mb-1.5">DLT Template ID</label><input type="text" value={templateId} onChange={e=>setTemplateId(e.target.value)} placeholder="1234567890123456789" className={FIELD_CLS}/></div>
            <div><label className="block text-[11px] font-semibold text-[#667781] dark:text-[#8696A0] mb-1.5">Sender ID</label><input type="text" maxLength={6} value={senderId} onChange={e=>setSenderId(e.target.value.toUpperCase())} placeholder="SKYCRM" className={FIELD_CLS}/></div>
          </div>
        </div>

        {/* Message body */}
        <div className="bg-white dark:bg-[#202C33] rounded-2xl p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <label className="text-[11px] font-semibold text-[#667781] dark:text-[#8696A0] uppercase tracking-wide">Message <span className="text-[#DC2626]">*</span></label>
            <div className="flex items-center gap-1 flex-wrap justify-end">
              {MERGE_TAGS.map(tag => <button key={tag} onClick={()=>setMessage(m=>m+tag)} className="px-2 py-0.5 rounded-md bg-[#DCF8C6] dark:bg-[#005C4B] text-[#075E54] dark:text-[#E9EDEF] text-[10px] font-mono font-bold hover:opacity-80 transition">{tag}</button>)}
            </div>
          </div>
          <textarea value={message} onChange={e=>setMessage(e.target.value)} rows={4} className={FIELD_CLS+" resize-y"} placeholder="Hi {{name}}, this is a message from SkyUp CRM."/>
          <div className="flex items-center justify-between mt-1.5">
            <p className="text-[10px] text-[#8B92A9]"><span className={charCount>160?"text-[#EA580C] font-bold":""}>{charCount}</span> chars · <span className={smsCount>1?"text-[#EA580C] font-bold":""}>{smsCount} SMS</span>/recipient</p>
            <p className="text-[10px] text-[#8B92A9]">→ <strong className="text-[#EA580C]">{recipientLabel}</strong></p>
          </div>
        </div>

        {/* Preview */}
        {message.trim() && (
          <div>
            <p className="text-[10px] font-semibold text-[#667781] dark:text-[#8696A0] uppercase tracking-wide text-center mb-2">Preview</p>
            <div className="flex justify-end px-2">
              <div className="max-w-[75%] bg-[#DCF8C6] dark:bg-[#005C4B] rounded-2xl rounded-tr-sm px-4 py-2.5 shadow-sm">
                <p className="text-[13px] text-[#111B21] dark:text-[#E9EDEF] leading-relaxed whitespace-pre-wrap">{previewMsg}</p>
                <div className="flex items-center justify-end gap-1 mt-1">
                  <span className="text-[10px] text-[#667781] dark:text-[#8696A0]">now</span>
                  <svg className="w-4 h-4 text-[#34B7F1]" viewBox="0 0 16 11" fill="currentColor"><path d="M11.071.653a.75.75 0 0 1 .025 1.06l-6.5 7a.75.75 0 0 1-1.092-.013l-3-3.5a.75.75 0 1 1 1.14-.977l2.46 2.87 5.908-6.415a.75.75 0 0 1 1.059-.025z"/><path d="M14.071.653a.75.75 0 0 1 .025 1.06l-6.5 7a.75.75 0 0 1-1.085.013L4.54 6.653a.75.75 0 0 1 1.14-.977l1.502 1.752 5.83-6.75a.75.75 0 0 1 1.059-.025z"/></svg>
                </div>
              </div>
            </div>
          </div>
        )}
        {error && <div className="bg-[#FEF2F2] dark:bg-[#2D0A0A] border border-[#FECACA] dark:border-[#7F1D1D] rounded-xl px-4 py-3 text-[12px] text-[#DC2626]">⚠ {error}</div>}
      </div>

      {/* Send bar */}
      <div className="bg-[#F0F2F5] dark:bg-[#202C33] px-4 py-3 flex items-center gap-3 shrink-0 border-t border-[#E4E7EF] dark:border-[#2A3942]">
        <div className="flex-1 bg-white dark:bg-[#2A3942] rounded-full px-4 py-2.5 text-[12px] text-[#667781] dark:text-[#8696A0] select-none">
          {message.trim() ? <span className="text-[#111B21] dark:text-[#E9EDEF] truncate block">{message.slice(0,60)}{message.length>60?"…":""}</span> : "Compose your message above…"}
        </div>
        <button onClick={handleSend} disabled={loading||!isValid} className="w-11 h-11 rounded-full bg-[#25D366] hover:bg-[#20B858] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition shadow-md">
          {loading ? <svg className="w-5 h-5 animate-spin text-white" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>
                   : <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>}
        </button>
      </div>
    </div>
  );
}

// ── SmsPanel root ──────────────────────────────────────────────────────────────
function SmsPanel() {
  const [leads, setLeads]                   = useState([]);
  const [loading, setLoading]               = useState(true);
  const [search, setSearch]                 = useState("");
  const [selectedLead, setSelectedLead]     = useState(null);
  const [showComposer, setShowComposer]     = useState(false);
  const [campaignFilter, setCampaignFilter] = useState("");
  const [campaigns, setCampaigns]           = useState([]);
  const [stats, setStats]                   = useState({ total: 0, sent: 0, failed: 0 });
  const debounceRef = useRef(null);

  const fetchLeads = useCallback(async (s = search, camp = campaignFilter) => {
    setLoading(true);
    try {
      const [crmRes, smsRes] = await Promise.allSettled([
        api.get("/lead/admin/all"),
        api.get(`/sms/history?page=1&limit=500&sortOrder=desc${camp?`&campaignId=${encodeURIComponent(camp)}`:""}`),
      ]);
      const crmLeads = (crmRes.status==="fulfilled"?crmRes.value.data:[])||[];
      const smsLogs  = (smsRes.status==="fulfilled"?(smsRes.value.data?.data||[]):[]);

      const normalise = p => (p||"").replace(/\D/g,"").slice(-10);
      const smsMap = {};
      smsLogs.forEach(log => {
        const key = normalise(log.to); if(!key) return;
        if(!smsMap[key]) smsMap[key]={sentCount:0,failedCount:0,lastMessage:"",lastSentAt:null,campaignId:null};
        if(log.status==="sent")   smsMap[key].sentCount++;
        if(log.status==="failed") smsMap[key].failedCount++;
        if(!smsMap[key].lastSentAt||new Date(log.sentAt)>new Date(smsMap[key].lastSentAt)){
          smsMap[key].lastSentAt=log.sentAt; smsMap[key].lastMessage=log.message; smsMap[key].campaignId=log.campaignId||null;
        }
      });

      let leadList = crmLeads.filter(l=>l.mobile&&l.mobile.replace(/\D/g,"").length>=6).map(l => {
        const key=normalise(l.mobile); const hist=smsMap[key]||{};
        return {_id:l._id,to:l.mobile,recipientName:l.name||"",campaignId:l.campaign||hist.campaignId||null,sentCount:hist.sentCount||0,failedCount:hist.failedCount||0,lastMessage:hist.lastMessage||"",lastSentAt:hist.lastSentAt||l.createdAt||null,hasSmsHistory:!!hist.lastSentAt};
      });

      const crmNums = new Set(crmLeads.map(l=>normalise(l.mobile)));
      Object.entries(smsMap).forEach(([key,hist])=>{ if(!crmNums.has(key)){ const origLog=smsLogs.find(l=>normalise(l.to)===key); leadList.push({to:origLog?.to||key,recipientName:origLog?.recipientName||"",campaignId:hist.campaignId||null,sentCount:hist.sentCount,failedCount:hist.failedCount,lastMessage:hist.lastMessage,lastSentAt:hist.lastSentAt,hasSmsHistory:true}); } });

      if (camp) leadList=leadList.filter(l=>l.campaignId===camp||l.hasSmsHistory);
      if (s)    leadList=leadList.filter(l=>l.to.includes(s)||(l.recipientName||"").toLowerCase().includes(s.toLowerCase())||(l.campaignId||"").toLowerCase().includes(s.toLowerCase()));

      leadList.sort((a,b)=>{ if(a.hasSmsHistory&&b.hasSmsHistory)return new Date(b.lastSentAt)-new Date(a.lastSentAt); if(a.hasSmsHistory)return -1; if(b.hasSmsHistory)return 1; return(a.recipientName||"").localeCompare(b.recipientName||""); });

      setLeads(leadList);
      setStats({ total: smsLogs.length, sent: smsLogs.filter(l=>l.status==="sent").length, failed: smsLogs.filter(l=>l.status==="failed").length });
    } catch(e) { console.error("SmsPanel fetchLeads error:",e); }
    finally { setLoading(false); }
  }, [search, campaignFilter]);

  useEffect(() => { fetchLeads(); }, []);
  useEffect(() => { api.get("/lead/distinct-campaigns").then(r=>setCampaigns(r.data.data||[])).catch(()=>{}); }, []);

  const handleSearchChange = val => { setSearch(val); clearTimeout(debounceRef.current); debounceRef.current=setTimeout(()=>fetchLeads(val,campaignFilter),400); };
  const handleCampaignChange = val => { setCampaignFilter(val); fetchLeads(search,val); };
  const handleSelectLead = lead => { setSelectedLead(lead); setShowComposer(false); };
  const handleBlast = () => { setSelectedLead(null); setShowComposer(true); };
  const handleBack  = () => { setSelectedLead(null); setShowComposer(false); };
  const handleSent  = () => fetchLeads();

  // On mobile: show only one panel at a time
  const sidebarVisible = !selectedLead && !showComposer;
  const rightVisible   = !!(selectedLead || showComposer);

  return (
    // KEY FIX: absolute inset-0 fills the parent's box exactly.
    // Parent in Communications must be: relative, overflow-hidden, with a defined height.
    <div className="absolute inset-0 flex overflow-hidden rounded-2xl border border-[#E4E7EF] dark:border-[#262A38] shadow-sm">
      <SmsSidebar
        leads={leads} loading={loading} stats={stats} campaigns={campaigns}
        selectedLead={selectedLead} onSelectLead={handleSelectLead}
        onBlast={handleBlast} search={search} onSearchChange={handleSearchChange}
        campaignFilter={campaignFilter} onCampaignChange={handleCampaignChange}
        visible={sidebarVisible}
      />
      <SmsRightPanel
        selectedLead={selectedLead} showComposer={showComposer}
        onBack={handleBack} onSent={handleSent}
        visible={rightVisible}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── AUTO TEMPLATE SETTINGS PANEL
// ─────────────────────────────────────────────────────────────────────────────
function AutoTemplateSettingsPanel({ activeTab, onClose }) {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [error, setError]       = useState("");

  useEffect(() => {
    api.get("/admin/company/auto-template").then(r=>setSettings(r.data.autoTemplate||{})).catch(()=>setSettings({}));
  }, []);

  const update = (channel,key,value) => { setSettings(prev=>({...prev,[channel]:{...(prev?.[channel]||{}),[key]:value}})); setSaved(false); };

  const handleSave = async () => {
    setSaving(true); setError(""); setSaved(false);
    try { await api.put("/admin/company/auto-template",settings); setSaved(true); setTimeout(()=>setSaved(false),2500); }
    catch (e) { setError(e.response?.data?.message||"Failed to save settings"); }
    finally { setSaving(false); }
  };

  if (!settings) return <div className="flex items-center justify-center py-8 gap-2 text-[#8B92A9]"><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>Loading…</div>;

  const wa=settings.whatsapp||{}; const em=settings.email||{}; const sm=settings.sms||{};
  const tokens = { whatsapp:{ring:"#25D366",bg:"bg-[#f0fdf4] dark:bg-[#052e1c]",text:"text-[#25D366]",border:"border-[#25D366]"}, email:{ring:"#7C3AED",bg:"bg-[#f5f3ff] dark:bg-[#1e1040]",text:"text-[#7C3AED]",border:"border-[#7C3AED]"}, sms:{ring:"#EA580C",bg:"bg-[#fff7ed] dark:bg-[#1c0a00]",text:"text-[#EA580C]",border:"border-[#EA580C]"} };
  const tok = tokens[activeTab]||tokens.whatsapp;

  return (
    <div className="bg-white dark:bg-[#1A1D27] border border-[#E4E7EF] dark:border-[#262A38] rounded-2xl overflow-hidden mb-4 shadow-sm">
      <div className={`flex items-center justify-between px-5 py-3.5 ${tok.bg} border-b border-[#E4E7EF] dark:border-[#262A38]`}>
        <div className="flex items-center gap-2.5">
          <div className={`w-7 h-7 rounded-lg ${tok.bg} border ${tok.border} flex items-center justify-center`}>
            <svg className={`w-3.5 h-3.5 ${tok.text}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
          </div>
          <div>
            <p className={`text-[13px] font-bold ${tok.text} leading-none`}>Auto-Template for New Leads</p>
            <p className="text-[11px] text-[#8B92A9] mt-0.5">Automatically send a message when a new lead is added</p>
          </div>
        </div>
        <button onClick={onClose} className="w-7 h-7 rounded-lg border border-[#E4E7EF] dark:border-[#262A38] flex items-center justify-center text-[#8B92A9] hover:text-[#0F1117] dark:hover:text-[#F0F2FA] transition">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <div className="px-5 py-4 space-y-4">
        {activeTab==="whatsapp" && (
          <>
            <div className="flex items-center justify-between">
              <div><p className="text-[13px] font-semibold text-[#0F1117] dark:text-[#F0F2FA]">Send WhatsApp Template to New Leads</p><p className="text-[11px] text-[#8B92A9] mt-0.5">Every new lead will automatically receive the template below</p></div>
              <button onClick={()=>update("whatsapp","enabled",!wa.enabled)} className={`relative w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none ${wa.enabled?"bg-[#25D366]":"bg-[#E4E7EF] dark:bg-[#262A38]"}`}><span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${wa.enabled?"translate-x-5":"translate-x-0"}`}/></button>
            </div>
            {wa.enabled && (
              <div className="space-y-3 pt-1 border-t border-[#E4E7EF] dark:border-[#262A38]">
                <div className="flex gap-2.5 bg-[#FFFBEB] dark:bg-[#1c1600] border border-[#FDE68A] dark:border-[#78350f] rounded-xl px-4 py-3"><span className="text-[14px] shrink-0">💡</span><p className="text-[11px] text-[#92400E] dark:text-[#FCD34D] leading-relaxed">The template name must exactly match an approved template in your <strong>MSG91 / Meta dashboard</strong>.</p></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="block text-[11px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Template Name <span className="text-[#DC2626]">*</span></label><input type="text" value={wa.templateName||""} onChange={e=>update("whatsapp","templateName",e.target.value)} placeholder="crm_followup_leads" className={FIELD_CLS}/></div>
                  <div><label className="block text-[11px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Language</label><select value={wa.languageCode||"en"} onChange={e=>update("whatsapp","languageCode",e.target.value)} className={FIELD_CLS}><option value="en">English (en)</option><option value="hi">Hindi (hi)</option><option value="mr">Marathi (mr)</option></select></div>
                </div>
              </div>
            )}
          </>
        )}
        {activeTab==="email" && (
          <>
            <div className="flex items-center justify-between">
              <div><p className="text-[13px] font-semibold text-[#0F1117] dark:text-[#F0F2FA]">Send Email to New Leads</p><p className="text-[11px] text-[#8B92A9] mt-0.5">Every new lead with an email address will receive this automatically</p></div>
              <button onClick={()=>update("email","enabled",!em.enabled)} className={`relative w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none ${em.enabled?"bg-[#7C3AED]":"bg-[#E4E7EF] dark:bg-[#262A38]"}`}><span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${em.enabled?"translate-x-5":"translate-x-0"}`}/></button>
            </div>
            {em.enabled && (
              <div className="space-y-3 pt-1 border-t border-[#E4E7EF] dark:border-[#262A38]">
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="block text-[11px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Subject <span className="text-[#DC2626]">*</span></label><input type="text" value={em.subject||""} onChange={e=>update("email","subject",e.target.value)} placeholder="Welcome, {{name}}!" className={FIELD_CLS}/></div>
                  <div><label className="block text-[11px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">From Name</label><input type="text" value={em.fromName||""} onChange={e=>update("email","fromName",e.target.value)} placeholder="SkyUp CRM Team" className={FIELD_CLS}/></div>
                </div>
                <div><label className="block text-[11px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1">Email Body (HTML)</label><textarea rows={5} value={em.bodyTemplate||""} onChange={e=>update("email","bodyTemplate",e.target.value)} className={FIELD_CLS+" font-mono text-[12px] resize-y"} placeholder="<p>Hi {{name}},</p><p>Thank you for your interest!</p>"/></div>
              </div>
            )}
          </>
        )}
        {activeTab==="sms" && (
          <>
            <div className="flex items-center justify-between">
              <div><p className="text-[13px] font-semibold text-[#0F1117] dark:text-[#F0F2FA]">Send SMS to New Leads</p><p className="text-[11px] text-[#8B92A9] mt-0.5">Every new lead with a mobile number will receive this automatically</p></div>
              <button onClick={()=>update("sms","enabled",!sm.enabled)} className={`relative w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none ${sm.enabled?"bg-[#EA580C]":"bg-[#E4E7EF] dark:bg-[#262A38]"}`}><span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${sm.enabled?"translate-x-5":"translate-x-0"}`}/></button>
            </div>
            {sm.enabled && (
              <div className="space-y-3 pt-1 border-t border-[#E4E7EF] dark:border-[#262A38]">
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="block text-[11px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">DLT Template ID</label><input type="text" value={sm.templateId||""} onChange={e=>update("sms","templateId",e.target.value)} placeholder="1234567890123456789" className={FIELD_CLS}/></div>
                  <div><label className="block text-[11px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1.5">Sender ID</label><input type="text" maxLength={6} value={sm.senderId||""} onChange={e=>update("sms","senderId",e.target.value.toUpperCase())} placeholder="SKYCRM" className={FIELD_CLS}/></div>
                </div>
                <div><label className="block text-[11px] font-semibold text-[#4B5168] dark:text-[#9DA3BB] mb-1">Message <span className="text-[#DC2626]">*</span></label><textarea rows={3} value={sm.message||""} onChange={e=>update("sms","message",e.target.value)} className={FIELD_CLS+" resize-y"} placeholder="Hi {{name}}, thanks for your interest!"/><p className="text-[10px] text-[#8B92A9] mt-1">{(sm.message||"").length} chars · {Math.max(1,Math.ceil((sm.message||"").length/160))} SMS</p></div>
              </div>
            )}
          </>
        )}
        <div className="flex items-center justify-between pt-1 border-t border-[#E4E7EF] dark:border-[#262A38]">
          {error && <p className="text-[11px] text-[#DC2626]">⚠ {error}</p>}
          {saved && <p className="text-[11px] text-[#059669] font-semibold">✓ Settings saved</p>}
          {!error&&!saved&&<span/>}
          <button onClick={handleSave} disabled={saving} className={`flex items-center gap-2 px-5 py-2 rounded-xl text-[13px] font-semibold text-white transition disabled:opacity-50 ${activeTab==="email"?"bg-[#7C3AED] hover:bg-purple-700":activeTab==="sms"?"bg-[#EA580C] hover:bg-orange-700":"bg-[#25D366] hover:bg-[#1da851]"}`}>
            {saving?<><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>Saving…</>:"Save Settings"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── MAIN COMMUNICATIONS PAGE
// ─────────────────────────────────────────────────────────────────────────────
export default function Communications({ currentUser }) {
  const [tab, setTab]                         = useState("whatsapp");
  const [showSettings, setShowSettings]       = useState(false);
  const [showIntegrations, setShowIntegrations] = useState(false);
  const isAdmin = currentUser?.role === "admin" || currentUser?.role === "super_admin" || currentUser?.role === "superadmin";

  return (
    <div className="bg-[#F8F9FC] dark:bg-[#0D0F14] min-h-screen font-poppins px-3 sm:px-6 py-3 sm:py-6 flex flex-col">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center sm:justify-between gap-2 sm:gap-4 mb-3 sm:mb-5 shrink-0">
        <div>
          <h1 className="text-[20px] sm:text-[24px] font-bold text-[#0F1117] dark:text-[#F0F2FA]">Communications</h1>
          <p className="text-[12px] sm:text-[13px] text-[#8B92A9] dark:text-[#565C75] mt-0.5">WhatsApp · Email · SMS — all in one place</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TabNav active={tab} onChange={t => { setTab(t); setShowSettings(false); }}/>
          {isAdmin && (
            <button onClick={() => setShowIntegrations(true)} title="Manage Integrations" className="flex items-center gap-1.5 px-3 sm:px-4 py-2 sm:py-2.5 rounded-xl border border-[#E4E7EF] dark:border-[#262A38] text-[12px] sm:text-[13px] font-semibold text-[#8B92A9] hover:text-[#0F1117] dark:hover:text-[#F0F2FA] hover:border-[#2563EB] transition">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>
              <span className="hidden sm:inline">Integrations</span>
            </button>
          )}
          {isAdmin && (
            <button onClick={() => setShowSettings(s => !s)} title="Auto-Template Settings"
              className={`flex items-center gap-1.5 px-3 sm:px-4 py-2 sm:py-2.5 rounded-xl border text-[12px] sm:text-[13px] font-semibold transition ${showSettings ? tab==="email"?"border-[#7C3AED] bg-[#f5f3ff] dark:bg-[#1e1040] text-[#7C3AED]":tab==="sms"?"border-[#EA580C] bg-[#fff7ed] dark:bg-[#1c0a00] text-[#EA580C]":"border-[#25D366] bg-[#f0fdf4] dark:bg-[#052e1c] text-[#25D366]" : "border-[#E4E7EF] dark:border-[#262A38] text-[#8B92A9] hover:text-[#0F1117] dark:hover:text-[#F0F2FA]"}`}>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
              <span className="hidden sm:inline">Auto-Template</span>
              <span className={`w-1.5 h-1.5 rounded-full ${tab==="email"?"bg-[#7C3AED]":tab==="sms"?"bg-[#EA580C]":"bg-[#25D366]"} ${showSettings?"opacity-100":"opacity-50"}`}/>
            </button>
          )}
        </div>
      </div>

      {/* Auto-template settings */}
      {isAdmin && showSettings && <AutoTemplateSettingsPanel activeTab={tab} onClose={() => setShowSettings(false)}/>}

      {/* ── Panel area
            KEY: position:relative + overflow:hidden gives the SMS panel's absolute inset-0 a containing block.
            flex-1 + min-h-0 make it fill the remaining vertical space without overflow.
      ── */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        {tab === "whatsapp" && (
          <div className="h-full">
            <WhatsAppPanel currentUser={currentUser}/>
          </div>
        )}
        {tab === "email" && (
          <div className="h-full flex flex-col overflow-hidden">
            <EmailPanel/>
          </div>
        )}
        {tab === "sms" && (
          // relative + h-full gives SmsPanel's absolute inset-0 its dimensions
          <div className="relative h-full overflow-hidden">
            <SmsPanel/>
          </div>
        )}
      </div>

      {showIntegrations && <IntegrationsModal onClose={() => setShowIntegrations(false)}/>}
    </div>
  );
}