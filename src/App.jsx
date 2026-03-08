import { useState, useEffect, useCallback, useRef } from "react";

const DONATION_TYPES = ["Cash", "Check", "Venmo", "PayPal", "Deposit"];
const ADMIN_PIN = import.meta.env.VITE_ADMIN_PIN || "1234";
const DATA_KEY = "donation-tracker-data";
const ATTACHMENTS_KEY = "donation-tracker-attachments";
const ORG_NAME = "NEBV&MC";
const FUND_NAME = "NEBV&MC New Building Fund";
const ORG_EIN = "XX-XXXXXXX";
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

const generateId = () => Math.random().toString(36).substr(2, 9);
const formatCurrency = (amt) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amt);
const formatDate = (d) => new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
const hasRemoteApi = API_BASE_URL.length > 0;

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  if (response.status === 204) return null;
  return response.json();
}

// Storage helpers
async function loadData() {
  if (hasRemoteApi) {
    try {
      return await apiRequest("/state");
    } catch {
      return null;
    }
  }
  try {
    const raw = window.localStorage.getItem(DATA_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
async function saveData(data) {
  if (hasRemoteApi) {
    try {
      await apiRequest("/state", { method: "PUT", body: JSON.stringify(data) });
    } catch {}
    return;
  }
  try { window.localStorage.setItem(DATA_KEY, JSON.stringify(data)); } catch {}
}

// Attachments stored separately (base64 can be large)
async function loadAttachments() {
  if (hasRemoteApi) {
    try {
      return await apiRequest("/attachments");
    } catch {
      return {};
    }
  }
  try {
    const raw = window.localStorage.getItem(ATTACHMENTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
async function saveAttachment(donationId, attachment) {
  if (hasRemoteApi) {
    try {
      await apiRequest(`/attachments/${encodeURIComponent(donationId)}`, {
        method: "PUT",
        body: JSON.stringify(attachment)
      });
    } catch {}
    return;
  }
  try {
    const all = await loadAttachments();
    all[donationId] = attachment;
    window.localStorage.setItem(ATTACHMENTS_KEY, JSON.stringify(all));
  } catch {}
}
async function deleteAttachment(donationId) {
  if (hasRemoteApi) {
    try {
      await apiRequest(`/attachments/${encodeURIComponent(donationId)}`, { method: "DELETE" });
    } catch {}
    return;
  }
  try {
    const all = await loadAttachments();
    delete all[donationId];
    window.localStorage.setItem(ATTACHMENTS_KEY, JSON.stringify(all));
  } catch {}
}

// Tax Letter Generator
function generateTaxLetter(user, donations, year) {
  const yearDonations = donations.filter((d) => d.email === user.email && new Date(d.date).getFullYear() === year);
  const total = yearDonations.reduce((s, d) => s + d.amount, 0);
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  let text = `${ORG_NAME} / ${FUND_NAME}\nDONATION RECEIPT / TAX LETTER\n${"═".repeat(50)}\n\nDate: ${today}\n\nDear ${user.firstName} ${user.lastName},\n\nThank you for your generous contributions during the year ${year}.\nBelow is a summary of your donations:\n\n${"─".repeat(50)}\nDate            Type        Amount\n${"─".repeat(50)}\n`;
  yearDonations.forEach((d) => { text += `${formatDate(d.date).padEnd(16)}${d.type.padEnd(12)}${formatCurrency(d.amount)}\n`; });
  text += `${"─".repeat(50)}\nTOTAL: ${formatCurrency(total)}\n${"─".repeat(50)}\n\nNo goods or services were provided in exchange for\nthese contributions.\n\nThis letter may be used for tax deduction purposes.\n\nWith gratitude,\n${ORG_NAME}\n${FUND_NAME}\nEIN: ${ORG_EIN}\n`;
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const safeOrg = ORG_NAME.replace(/[^A-Za-z0-9]+/g, "_");
  const a = document.createElement("a"); a.href = url; a.download = `${safeOrg}_Tax_Letter_${year}_${user.lastName}.txt`; a.click();
  URL.revokeObjectURL(url);
}

function generateCSVExport(users, donations) {
  let csv = "Date,Donor Name,Email,Type,Reference,Amount,Has Receipt\n";
  [...donations].sort((a, b) => new Date(b.date) - new Date(a.date)).forEach((d) => {
    const u = users.find((u) => u.email === d.email);
    const name = u ? `${u.firstName} ${u.lastName}` : d.email;
    csv += `${d.date},"${name}",${d.email},${d.type},${d.checkNumber || ""},${d.amount},${d.hasAttachment ? "Yes" : "No"}\n`;
  });
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const safeOrg = ORG_NAME.replace(/[^A-Za-z0-9]+/g, "_");
  const a = document.createElement("a"); a.href = url; a.download = `${safeOrg}_Donations_Export_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// AI extraction via Claude API
async function extractFromDocument(base64Data, mediaType, fileName) {
  const isImage = mediaType.startsWith("image/");
  const isPDF = mediaType === "application/pdf";
  if (!isImage && !isPDF) throw new Error("Unsupported file type");
  const extractUrl = hasRemoteApi ? `${API_BASE_URL}/extract` : "/api/extract";
  const response = await fetch(extractUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base64Data, mediaType, fileName })
  });

  if (!response.ok) {
    throw new Error("Extraction request failed");
  }

  return response.json();
}

// ─── Shared Components ───

function Input({ label, type = "text", required, value, onChange, placeholder }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontSize: 11, fontFamily: "'DM Mono', monospace", textTransform: "uppercase", letterSpacing: 1.5, color: "#6b7f6b", marginBottom: 6 }}>
        {label} {required && <span style={{ color: "#c97b5a" }}>*</span>}
      </label>
      <input type={type} required={required} value={value} onChange={onChange} placeholder={placeholder}
        style={{ width: "100%", padding: "10px 14px", border: "1.5px solid #d4d9cc", borderRadius: 8, fontSize: 14, fontFamily: "'Source Serif 4', Georgia, serif", background: "#fafaf6", color: "#2d3a2d", outline: "none", transition: "border-color 0.2s", boxSizing: "border-box" }}
        onFocus={(e) => (e.target.style.borderColor = "#7a9a6a")} onBlur={(e) => (e.target.style.borderColor = "#d4d9cc")} />
    </div>
  );
}

function Button({ children, onClick, variant = "primary", style: s = {}, disabled }) {
  const base = { padding: "10px 22px", borderRadius: 8, fontSize: 13, fontFamily: "'DM Mono', monospace", fontWeight: 500, cursor: disabled ? "not-allowed" : "pointer", border: "none", letterSpacing: 0.5, transition: "all 0.2s", opacity: disabled ? 0.5 : 1, ...s };
  const styles = {
    primary: { ...base, background: "#4a6741", color: "#f4f4ec" },
    secondary: { ...base, background: "transparent", color: "#4a6741", border: "1.5px solid #4a6741" },
    ghost: { ...base, background: "transparent", color: "#7a9a6a", padding: "8px 14px" },
    danger: { ...base, background: "#c97b5a", color: "#fff" },
    admin: { ...base, background: "#3a4a5a", color: "#e8ecf0" },
  };
  return <button onClick={onClick} style={styles[variant]} disabled={disabled}>{children}</button>;
}

function Tabs({ tabs, active, onSelect }) {
  return (
    <div style={{ display: "flex", gap: 0, borderBottom: "1.5px solid #d4d9cc", marginBottom: 28, overflowX: "auto" }}>
      {tabs.map((t) => (
        <button key={t.key} onClick={() => onSelect(t.key)}
          style={{ padding: "12px 20px", border: "none", background: "none", cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 11, letterSpacing: 1, textTransform: "uppercase", color: active === t.key ? "#4a6741" : "#a0a89a", borderBottom: active === t.key ? "2.5px solid #4a6741" : "2.5px solid transparent", fontWeight: active === t.key ? 600 : 400, transition: "all 0.2s", marginBottom: -1.5, whiteSpace: "nowrap" }}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

function SelectField({ label, required, value, onChange, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontSize: 11, fontFamily: "'DM Mono', monospace", textTransform: "uppercase", letterSpacing: 1.5, color: "#6b7f6b", marginBottom: 6 }}>
        {label} {required && <span style={{ color: "#c97b5a" }}>*</span>}
      </label>
      <select value={value} onChange={onChange}
        style={{ width: "100%", padding: "10px 14px", border: "1.5px solid #d4d9cc", borderRadius: 8, fontSize: 14, fontFamily: "'Source Serif 4', Georgia, serif", background: "#fafaf6", color: "#2d3a2d", boxSizing: "border-box", cursor: "pointer" }}>
        {children}
      </select>
    </div>
  );
}

function Badge({ children, color = "#4a6741", bg = "#eef3ea" }) {
  return <span style={{ background: bg, color, padding: "3px 10px", borderRadius: 20, fontSize: 11, fontFamily: "'DM Mono', monospace", whiteSpace: "nowrap" }}>{children}</span>;
}

function StatCard({ label, value, accent }) {
  return (
    <div style={{ background: accent ? "#3a4a5a" : "#f4f6ef", borderRadius: 12, padding: "18px 20px" }}>
      <p style={{ margin: 0, fontFamily: "'DM Mono', monospace", fontSize: 10, color: accent ? "#8fa4b8" : "#8a9484", textTransform: "uppercase", letterSpacing: 1.5 }}>{label}</p>
      <p style={{ margin: "6px 0 0", fontSize: 22, fontFamily: "'Source Serif 4', Georgia, serif", color: accent ? "#e8ecf0" : "#2d3a2d", fontWeight: 700 }}>{value}</p>
    </div>
  );
}

function ConfirmModal({ message, onConfirm, onCancel }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div style={{ background: "#fafaf6", borderRadius: 14, padding: 28, maxWidth: 380, width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }}>
        <p style={{ margin: "0 0 20px", fontSize: 15, lineHeight: 1.5, color: "#2d3a2d" }}>{message}</p>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <Button variant="secondary" onClick={onCancel} style={{ padding: "8px 18px" }}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm} style={{ padding: "8px 18px" }}>Confirm</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Receipt Viewer Modal ───

function ReceiptViewer({ donationId, onClose }) {
  const [attachment, setAttachment] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadAttachments().then((all) => {
      setAttachment(all[donationId] || null);
      setLoading(false);
    });
  }, [donationId]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
      onClick={onClose}>
      <div style={{ background: "#fafaf6", borderRadius: 14, padding: 24, maxWidth: 600, width: "90%", maxHeight: "85vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <p style={{ margin: 0, fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#6b7f6b", textTransform: "uppercase", letterSpacing: 1.5 }}>
            Receipt / Attachment
          </p>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#8a9484", padding: 4 }}>✕</button>
        </div>
        {loading ? (
          <div style={{ textAlign: "center", padding: 40, color: "#8a9484" }}>Loading...</div>
        ) : !attachment ? (
          <div style={{ textAlign: "center", padding: 40, color: "#a0a89a" }}>
            <p style={{ fontSize: 28, margin: "0 0 8px" }}>📎</p>
            <p style={{ margin: 0, fontSize: 14 }}>No attachment found.</p>
          </div>
        ) : attachment.mediaType.startsWith("image/") ? (
          <img src={`data:${attachment.mediaType};base64,${attachment.data}`}
            alt="Receipt" style={{ width: "100%", borderRadius: 8, border: "1px solid #e4e8dc" }} />
        ) : attachment.mediaType === "application/pdf" ? (
          <div style={{ textAlign: "center", padding: 24 }}>
            <p style={{ fontSize: 40, margin: "0 0 12px" }}>📄</p>
            <p style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 600 }}>{attachment.fileName}</p>
            <p style={{ margin: "0 0 16px", fontSize: 13, color: "#8a9484" }}>PDF document attached</p>
            <Button variant="secondary" onClick={() => {
              const blob = new Blob([Uint8Array.from(atob(attachment.data), c => c.charCodeAt(0))], { type: "application/pdf" });
              const url = URL.createObjectURL(blob);
              window.open(url, "_blank");
              setTimeout(() => URL.revokeObjectURL(url), 5000);
            }}>Open PDF</Button>
          </div>
        ) : (
          <p style={{ textAlign: "center", color: "#8a9484" }}>Unsupported file type</p>
        )}
        <p style={{ margin: "12px 0 0", fontSize: 12, color: "#a0a89a", textAlign: "center" }}>{attachment?.fileName}</p>
      </div>
    </div>
  );
}

// ─── Document Scanner Component ───

function DocumentScanner({ onExtracted, onAttachment }) {
  const [scanning, setScanning] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState(null);
  const [extractResult, setExtractResult] = useState(null);
  const [error, setError] = useState("");
  const fileRef = useRef(null);

  const processFile = async (file) => {
    setError("");
    setExtractResult(null);

    const validTypes = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];
    if (!validTypes.includes(file.type)) {
      setError("Please upload an image (JPG, PNG) or PDF file.");
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setError("File too large. Maximum 10MB.");
      return;
    }

    // Read as base64
    const base64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result.split(",")[1]);
      r.onerror = () => rej(new Error("Failed to read file"));
      r.readAsDataURL(file);
    });

    // Set preview
    if (file.type.startsWith("image/")) {
      setPreview({ type: "image", src: `data:${file.type};base64,${base64}`, name: file.name });
    } else {
      setPreview({ type: "pdf", name: file.name });
    }

    // Store attachment
    onAttachment({ data: base64, mediaType: file.type, fileName: file.name });

    // Extract with AI
    setScanning(true);
    try {
      const result = await extractFromDocument(base64, file.type, file.name);
      setExtractResult(result);
      onExtracted(result);
    } catch (err) {
      setError("Could not extract details automatically. Please fill in manually.");
      console.error("Extraction error:", err);
    } finally {
      setScanning(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  };

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (file) processFile(file);
  };

  const clearScan = () => {
    setPreview(null); setExtractResult(null); setError("");
    onAttachment(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div style={{ marginBottom: 20 }}>
      <label style={{ display: "block", fontSize: 11, fontFamily: "'DM Mono', monospace", textTransform: "uppercase", letterSpacing: 1.5, color: "#6b7f6b", marginBottom: 8 }}>
        Scan Document
      </label>

      {!preview ? (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileRef.current?.click()}
          style={{
            border: `2px dashed ${dragOver ? "#4a6741" : "#d4d9cc"}`,
            borderRadius: 12, padding: "28px 20px", textAlign: "center", cursor: "pointer",
            background: dragOver ? "#eef3ea" : "#fafaf6", transition: "all 0.2s",
          }}
        >
          <input ref={fileRef} type="file" accept="image/*,.pdf" onChange={handleFileSelect} style={{ display: "none" }} />
          <p style={{ margin: "0 0 6px", fontSize: 28 }}>📷</p>
          <p style={{ margin: "0 0 4px", fontSize: 14, color: "#2d3a2d", fontWeight: 500 }}>
            Drop a check image or Venmo PDF here
          </p>
          <p style={{ margin: 0, fontSize: 12, color: "#a0a89a" }}>
            or click to browse · JPG, PNG, PDF up to 10MB
          </p>
        </div>
      ) : (
        <div style={{ border: "1.5px solid #d4d9cc", borderRadius: 12, overflow: "hidden", background: "#fafaf6" }}>
          {/* Preview area */}
          <div style={{ padding: 16, display: "flex", gap: 14, alignItems: "center" }}>
            {preview.type === "image" ? (
              <img src={preview.src} alt="Scan" style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: "1px solid #e4e8dc" }} />
            ) : (
              <div style={{ width: 72, height: 72, borderRadius: 8, background: "#f0f3ea", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28 }}>📄</div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 500, color: "#2d3a2d", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview.name}</p>
              {scanning ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 14, height: 14, border: "2px solid #d4d9cc", borderTopColor: "#4a6741", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                  <span style={{ fontSize: 13, color: "#6b7f6b" }}>Extracting details with AI...</span>
                </div>
              ) : extractResult ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 14 }}>✓</span>
                  <span style={{ fontSize: 13, color: "#4a6741" }}>
                    Extracted · {extractResult.confidence} confidence
                  </span>
                </div>
              ) : error ? (
                <span style={{ fontSize: 13, color: "#c97b5a" }}>{error}</span>
              ) : null}
            </div>
            <button onClick={clearScan} style={{ background: "none", border: "none", color: "#a0a89a", cursor: "pointer", fontSize: 16, padding: 4 }}>✕</button>
          </div>

          {/* Extraction notes */}
          {extractResult?.notes && (
            <div style={{ padding: "0 16px 14px", fontSize: 12, color: "#6b7f6b", lineHeight: 1.5 }}>
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#8a9484" }}>AI NOTES: </span>
              {extractResult.notes}
            </div>
          )}
        </div>
      )}

      {error && !preview && <p style={{ margin: "8px 0 0", fontSize: 13, color: "#c97b5a" }}>{error}</p>}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ─── Donation Form (reusable for user + admin) ───

function DonationForm({ users, defaultEmail, onAddDonation, showDonorSelect }) {
  const [donForm, setDonForm] = useState({ email: defaultEmail || users[0]?.email || "", date: new Date().toISOString().slice(0, 10), type: "Cash", amount: "", checkNumber: "" });
  const [success, setSuccess] = useState("");
  const [pendingAttachment, setPendingAttachment] = useState(null);

  const handleExtracted = (result) => {
    const updates = {};
    if (result.amount) updates.amount = String(result.amount);
    if (result.date) updates.date = result.date;
    if (result.type && DONATION_TYPES.includes(result.type)) updates.type = result.type;
    if (result.checkNumber) updates.checkNumber = result.checkNumber;
    if (Object.keys(updates).length > 0) {
      setDonForm((prev) => ({ ...prev, ...updates }));
    }
    // Try to match payer to a user
    if (result.payerName && showDonorSelect) {
      const name = result.payerName.toLowerCase();
      const match = users.find((u) => `${u.firstName} ${u.lastName}`.toLowerCase().includes(name) || name.includes(u.firstName.toLowerCase()));
      if (match) setDonForm((prev) => ({ ...prev, email: match.email }));
    }
  };

  const handleAdd = async () => {
    const amt = parseFloat(donForm.amount);
    if (!donForm.email || !donForm.date || !amt || amt <= 0) return;
    const donId = generateId();
    const donation = {
      id: donId, email: donForm.email, date: donForm.date, type: donForm.type,
      amount: amt, checkNumber: donForm.checkNumber, hasAttachment: !!pendingAttachment
    };

    // Save attachment separately
    if (pendingAttachment) {
      await saveAttachment(donId, pendingAttachment);
    }

    await onAddDonation(donation);
    setDonForm({ ...donForm, amount: "", checkNumber: "" });
    setPendingAttachment(null);
    setSuccess("Donation recorded with" + (pendingAttachment ? " receipt attached!" : "out receipt."));
    setTimeout(() => setSuccess(""), 3000);
  };

  const df = (key) => ({ value: donForm[key], onChange: (e) => setDonForm({ ...donForm, [key]: e.target.value }) });

  if (users.length === 0) {
    return <div style={{ textAlign: "center", padding: 48, color: "#a0a89a" }}><p style={{ margin: 0 }}>No registered users to add donations for.</p></div>;
  }

  return (
    <div style={{ maxWidth: 480 }}>
      {success && <div style={{ background: "#eef3ea", color: "#4a6741", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 16 }}>{success}</div>}

      <DocumentScanner onExtracted={handleExtracted} onAttachment={setPendingAttachment} />

      {showDonorSelect && (
        <SelectField label="Donor" required value={donForm.email} onChange={(e) => setDonForm({ ...donForm, email: e.target.value })}>
          {users.map((u) => <option key={u.id} value={u.email}>{u.firstName} {u.lastName} ({u.email})</option>)}
        </SelectField>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
        <Input label="Date" type="date" required {...df("date")} />
        <SelectField label="Type" required value={donForm.type} onChange={(e) => setDonForm({ ...donForm, type: e.target.value })}>
          {DONATION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </SelectField>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
        <Input label="Amount ($)" type="number" required {...df("amount")} placeholder="0.00" />
        <Input label="Check # / Reference" {...df("checkNumber")} placeholder="Optional" />
      </div>
      <Button onClick={handleAdd} style={{ width: "100%", marginTop: 4 }}>Record Donation</Button>
    </div>
  );
}

// ─── Receipt Button ───

function ReceiptButton({ donationId, hasAttachment }) {
  const [showViewer, setShowViewer] = useState(false);
  if (!hasAttachment) return <span style={{ color: "#d4d9cc", fontSize: 12 }}>—</span>;
  return (
    <>
      <button onClick={() => setShowViewer(true)}
        style={{ background: "#eef3ea", border: "1px solid #d4d9cc", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontSize: 11, fontFamily: "'DM Mono', monospace", color: "#4a6741", display: "inline-flex", alignItems: "center", gap: 4 }}>
        📎 View
      </button>
      {showViewer && <ReceiptViewer donationId={donationId} onClose={() => setShowViewer(false)} />}
    </>
  );
}

// ─── User Pages ───

function LoginPage({ users, onLogin, onGoRegister }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const handleLogin = () => {
    const user = users.find((u) => u.email === email && u.password === password);
    if (user) { onLogin(user); setError(""); } else setError("Invalid email or password.");
  };
  return (
    <div style={{ maxWidth: 400, margin: "0 auto" }}>
      <div style={{ textAlign: "center", marginBottom: 40 }}>
        <div style={{ fontSize: 38, marginBottom: 8 }}>🌿</div>
        <h1 style={{ fontFamily: "'Source Serif 4', Georgia, serif", fontSize: 28, color: "#2d3a2d", margin: 0, fontWeight: 600 }}>Welcome to {ORG_NAME}</h1>
        <p style={{ color: "#8a9484", fontSize: 14, margin: "8px 0 0" }}>Sign in to manage donations, including the {FUND_NAME}</p>
      </div>
      {error && <div style={{ background: "#fdf0ea", color: "#c97b5a", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 16 }}>{error}</div>}
      <Input label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" />
      <Input label="Password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
      <Button onClick={handleLogin} style={{ width: "100%", marginTop: 8 }}>Sign In</Button>
      <p style={{ textAlign: "center", marginTop: 20, fontSize: 13, color: "#8a9484" }}>
        Don't have an account?{" "}
        <span onClick={onGoRegister} style={{ color: "#4a6741", cursor: "pointer", fontWeight: 600, textDecoration: "underline" }}>Register</span>
      </p>
    </div>
  );
}

function RegisterPage({ users, onRegister, onGoLogin }) {
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({ firstName: "", lastName: "", phone: "", email: "", street: "", city: "", state: "", zip: "", password: "" });
  const [found, setFound] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");
  const handleSearch = () => {
    const q = search.toLowerCase().trim();
    const match = users.find((u) => u.email.toLowerCase() === q || `${u.firstName} ${u.lastName}`.toLowerCase().includes(q));
    if (match) { setFound(match); setShowForm(false); } else { setFound(null); setShowForm(true); }
  };
  const handleRegister = () => {
    if (!form.firstName || !form.lastName || !form.email || !form.password) { setError("Please fill in all required fields."); return; }
    if (users.find((u) => u.email === form.email)) { setError("This email is already registered."); return; }
    onRegister({ ...form, id: generateId() }); setError("");
  };
  const f = (key) => ({ value: form[key], onChange: (e) => setForm({ ...form, [key]: e.target.value }) });
  return (
    <div style={{ maxWidth: 480, margin: "0 auto" }}>
      <div style={{ textAlign: "center", marginBottom: 36 }}>
        <div style={{ fontSize: 38, marginBottom: 8 }}>🌱</div>
        <h1 style={{ fontFamily: "'Source Serif 4', Georgia, serif", fontSize: 28, color: "#2d3a2d", margin: 0, fontWeight: 600 }}>{ORG_NAME} Registration</h1>
        <p style={{ color: "#8a9484", fontSize: 14, margin: "8px 0 0" }}>Check if you're already in our system</p>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or email..."
          style={{ flex: 1, padding: "10px 14px", border: "1.5px solid #d4d9cc", borderRadius: 8, fontSize: 14, fontFamily: "'Source Serif 4', Georgia, serif", background: "#fafaf6", color: "#2d3a2d", outline: "none" }}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()} />
        <Button onClick={handleSearch}>Search</Button>
      </div>
      {found && (
        <div style={{ background: "#eef3ea", borderRadius: 10, padding: 20, marginBottom: 20 }}>
          <p style={{ margin: 0, fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#6b7f6b", textTransform: "uppercase", letterSpacing: 1 }}>Account Found</p>
          <p style={{ margin: "8px 0 4px", fontSize: 18, fontFamily: "'Source Serif 4', Georgia, serif", color: "#2d3a2d", fontWeight: 600 }}>{found.firstName} {found.lastName}</p>
          <p style={{ margin: 0, color: "#6b7f6b", fontSize: 13 }}>{found.email}</p>
          <Button onClick={onGoLogin} variant="secondary" style={{ marginTop: 14 }}>Go to Login</Button>
        </div>
      )}
      {showForm && (
        <div style={{ background: "#fafaf6", borderRadius: 12, padding: 24, border: "1px solid #e8eae2" }}>
          <p style={{ margin: "0 0 20px", fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#6b7f6b", textTransform: "uppercase", letterSpacing: 1 }}>New Registration</p>
          {error && <div style={{ background: "#fdf0ea", color: "#c97b5a", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 16 }}>{error}</div>}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
            <Input label="First Name" required {...f("firstName")} />
            <Input label="Last Name" required {...f("lastName")} />
          </div>
          <Input label="Contact Number" {...f("phone")} placeholder="Optional" />
          <Input label="Email" type="email" required {...f("email")} />
          <Input label="Street Address" {...f("street")} />
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "0 12px" }}>
            <Input label="City" {...f("city")} />
            <Input label="State" {...f("state")} />
            <Input label="Zip Code" {...f("zip")} />
          </div>
          <Input label="Password" type="password" required {...f("password")} />
          <Button onClick={handleRegister} style={{ width: "100%", marginTop: 4 }}>Create Account</Button>
        </div>
      )}
      <p style={{ textAlign: "center", marginTop: 20, fontSize: 13, color: "#8a9484" }}>
        Already registered?{" "}
        <span onClick={onGoLogin} style={{ color: "#4a6741", cursor: "pointer", fontWeight: 600, textDecoration: "underline" }}>Sign In</span>
      </p>
    </div>
  );
}

function UserDashboard({ user, users, donations, onAddDonation, onLogout }) {
  const [tab, setTab] = useState("history");
  const [yearFilter, setYearFilter] = useState("all");
  const myDonations = donations.filter((d) => d.email === user.email).filter((d) => yearFilter === "all" || new Date(d.date).getFullYear() === parseInt(yearFilter)).sort((a, b) => new Date(b.date) - new Date(a.date));
  const years = [...new Set(donations.filter((d) => d.email === user.email).map((d) => new Date(d.date).getFullYear()))].sort((a, b) => b - a);
  const totalAll = myDonations.reduce((s, d) => s + d.amount, 0);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 }}>
        <div>
          <p style={{ margin: 0, fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#8a9484", textTransform: "uppercase", letterSpacing: 1.5 }}>Dashboard</p>
          <h1 style={{ fontFamily: "'Source Serif 4', Georgia, serif", fontSize: 26, color: "#2d3a2d", margin: "4px 0 0", fontWeight: 600 }}>Hello, {user.firstName}</h1>
        </div>
        <Button variant="ghost" onClick={onLogout}>Sign Out →</Button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 28 }}>
        <StatCard label="Total Donated" value={formatCurrency(donations.filter((d) => d.email === user.email).reduce((s, d) => s + d.amount, 0))} />
        <StatCard label="This Year" value={formatCurrency(donations.filter((d) => d.email === user.email && new Date(d.date).getFullYear() === new Date().getFullYear()).reduce((s, d) => s + d.amount, 0))} />
        <StatCard label="Donations" value={donations.filter((d) => d.email === user.email).length} />
      </div>
      <Tabs tabs={[{ key: "history", label: "History" }, { key: "donate", label: "Add Donation" }, { key: "tax", label: "Tax Letter" }]} active={tab} onSelect={setTab} />

      {tab === "history" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <p style={{ margin: 0, color: "#6b7f6b", fontSize: 13 }}>{myDonations.length} donation{myDonations.length !== 1 ? "s" : ""} · {formatCurrency(totalAll)} total</p>
            <select value={yearFilter} onChange={(e) => setYearFilter(e.target.value)} style={{ padding: "6px 12px", border: "1.5px solid #d4d9cc", borderRadius: 6, fontFamily: "'DM Mono', monospace", fontSize: 12, background: "#fafaf6", color: "#2d3a2d", cursor: "pointer" }}>
              <option value="all">All Years</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          {myDonations.length === 0 ? (
            <div style={{ textAlign: "center", padding: 48, color: "#a0a89a" }}><p style={{ fontSize: 32, margin: "0 0 8px" }}>📋</p><p style={{ margin: 0, fontFamily: "'DM Mono', monospace", fontSize: 13 }}>No donations found</p></div>
          ) : (
            <div style={{ borderRadius: 10, overflow: "hidden", border: "1px solid #e4e8dc" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead><tr style={{ background: "#f0f3ea" }}>
                  {["Date", "Type", "Details", "Amount", "Receipt"].map((h) => <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontFamily: "'DM Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: 1.5, color: "#6b7f6b", fontWeight: 500 }}>{h}</th>)}
                </tr></thead>
                <tbody>{myDonations.map((d, i) => (
                  <tr key={d.id} style={{ borderTop: "1px solid #eef0e8", background: i % 2 === 0 ? "#fff" : "#fcfcf8" }}>
                    <td style={{ padding: "12px 16px", color: "#2d3a2d" }}>{formatDate(d.date)}</td>
                    <td style={{ padding: "12px 16px" }}><Badge>{d.type}</Badge></td>
                    <td style={{ padding: "12px 16px", color: "#8a9484", fontSize: 13 }}>{d.checkNumber ? `#${d.checkNumber}` : "—"}</td>
                    <td style={{ padding: "12px 16px", fontFamily: "'Source Serif 4', Georgia, serif", fontWeight: 600, color: "#2d3a2d" }}>{formatCurrency(d.amount)}</td>
                    <td style={{ padding: "12px 16px" }}><ReceiptButton donationId={d.id} hasAttachment={d.hasAttachment} /></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === "donate" && (
        <DonationForm users={users} defaultEmail={user.email} onAddDonation={onAddDonation} showDonorSelect={false} />
      )}

      {tab === "tax" && (
        <div style={{ maxWidth: 480 }}>
          <div style={{ background: "#f4f6ef", borderRadius: 12, padding: 24 }}>
            <p style={{ margin: "0 0 6px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#8a9484", textTransform: "uppercase", letterSpacing: 1.5 }}>Download {ORG_NAME} Tax Letter</p>
            <p style={{ margin: "0 0 20px", color: "#6b7f6b", fontSize: 14, lineHeight: 1.5 }}>Generate a donation receipt for your tax records, including contributions to the {FUND_NAME}.</p>
            {years.length === 0 ? <p style={{ color: "#a0a89a", fontSize: 14, fontStyle: "italic" }}>No donations recorded yet.</p> : (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {years.map((y) => {
                  const t = donations.filter((d) => d.email === user.email && new Date(d.date).getFullYear() === y).reduce((s, d) => s + d.amount, 0);
                  return (
                    <button key={y} onClick={() => generateTaxLetter(user, donations, y)}
                      style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "14px 22px", background: "#fff", border: "1.5px solid #d4d9cc", borderRadius: 10, cursor: "pointer", transition: "all 0.2s" }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#4a6741"; e.currentTarget.style.background = "#eef3ea"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#d4d9cc"; e.currentTarget.style.background = "#fff"; }}>
                      <span style={{ fontFamily: "'Source Serif 4', Georgia, serif", fontSize: 20, fontWeight: 700, color: "#2d3a2d" }}>{y}</span>
                      <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#6b7f6b", marginTop: 2 }}>{formatCurrency(t)}</span>
                      <span style={{ fontSize: 10, color: "#a0a89a", marginTop: 6 }}>↓ Download</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Admin Dashboard ───

function AdminDashboard({ users, donations, onAddDonation, onDeleteDonation, onDeleteUser, onUpdateUser, onLogout }) {
  const [tab, setTab] = useState("overview");
  const [success, setSuccess] = useState("");
  const [confirm, setConfirm] = useState(null);
  const [userFilter, setUserFilter] = useState("all");
  const [yearFilter, setYearFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [searchQ, setSearchQ] = useState("");
  const [editingUser, setEditingUser] = useState(null);
  const [editForm, setEditForm] = useState({});

  const totalAmount = donations.reduce((s, d) => s + d.amount, 0);
  const thisYear = new Date().getFullYear();
  const thisYearAmount = donations.filter((d) => new Date(d.date).getFullYear() === thisYear).reduce((s, d) => s + d.amount, 0);
  const allYears = [...new Set(donations.map((d) => new Date(d.date).getFullYear()))].sort((a, b) => b - a);
  const withReceipts = donations.filter((d) => d.hasAttachment).length;

  const typeBreakdown = DONATION_TYPES.map((t) => ({
    type: t, count: donations.filter((d) => d.type === t).length,
    total: donations.filter((d) => d.type === t).reduce((s, d) => s + d.amount, 0),
  })).filter((t) => t.count > 0);

  const filteredDonations = donations
    .filter((d) => userFilter === "all" || d.email === userFilter)
    .filter((d) => yearFilter === "all" || new Date(d.date).getFullYear() === parseInt(yearFilter))
    .filter((d) => typeFilter === "all" || d.type === typeFilter)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const filteredUsers = users.filter((u) => {
    if (!searchQ) return true;
    const q = searchQ.toLowerCase();
    return `${u.firstName} ${u.lastName}`.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  });

  const startEditUser = (u) => {
    setEditingUser(u.id);
    setEditForm({ firstName: u.firstName, lastName: u.lastName, phone: u.phone || "", email: u.email, street: u.street || "", city: u.city || "", state: u.state || "", zip: u.zip || "" });
  };

  const saveEditUser = () => {
    if (!editForm.firstName || !editForm.lastName || !editForm.email) return;
    onUpdateUser(editingUser, editForm);
    setEditingUser(null); setSuccess("User updated!"); setTimeout(() => setSuccess(""), 3000);
  };

  return (
    <div>
      {confirm && <ConfirmModal message={confirm.message} onConfirm={() => { confirm.action(); setConfirm(null); }} onCancel={() => setConfirm(null)} />}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}><Badge color="#3a4a5a" bg="#dce3ea">ADMIN</Badge></div>
          <h1 style={{ fontFamily: "'Source Serif 4', Georgia, serif", fontSize: 26, color: "#2d3a2d", margin: "4px 0 0", fontWeight: 600 }}>Administration Panel</h1>
        </div>
        <Button variant="ghost" onClick={onLogout}>Exit Admin →</Button>
      </div>

      {success && <div style={{ background: "#eef3ea", color: "#4a6741", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 20 }}>{success}</div>}

      <Tabs tabs={[
        { key: "overview", label: "Overview" },
        { key: "users", label: `Users (${users.length})` },
        { key: "donations", label: `Donations (${donations.length})` },
        { key: "add", label: "Scan & Add" },
        { key: "reports", label: "Reports" },
      ]} active={tab} onSelect={setTab} />

      {/* Overview */}
      {tab === "overview" && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 14, marginBottom: 28 }}>
            <StatCard label="Total Raised" value={formatCurrency(totalAmount)} accent />
            <StatCard label={`${thisYear} Total`} value={formatCurrency(thisYearAmount)} />
            <StatCard label="Users" value={users.length} />
            <StatCard label="Donations" value={donations.length} />
            <StatCard label="With Receipts" value={withReceipts} />
          </div>

          <div style={{ background: "#fafaf6", borderRadius: 12, padding: 24, border: "1px solid #e8eae2", marginBottom: 20 }}>
            <p style={{ margin: "0 0 16px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#6b7f6b", textTransform: "uppercase", letterSpacing: 1.5 }}>By Payment Type</p>
            {typeBreakdown.length === 0 ? <p style={{ color: "#a0a89a", fontSize: 14 }}>No donations yet.</p> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {typeBreakdown.map((t) => {
                  const pct = totalAmount > 0 ? (t.total / totalAmount) * 100 : 0;
                  return (
                    <div key={t.type}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontSize: 13, color: "#2d3a2d" }}>{t.type} <span style={{ color: "#a0a89a" }}>({t.count})</span></span>
                        <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "'Source Serif 4', Georgia, serif" }}>{formatCurrency(t.total)}</span>
                      </div>
                      <div style={{ height: 6, background: "#e8eae2", borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${pct}%`, background: "#4a6741", borderRadius: 3, transition: "width 0.5s" }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div style={{ background: "#fafaf6", borderRadius: 12, padding: 24, border: "1px solid #e8eae2" }}>
            <p style={{ margin: "0 0 16px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#6b7f6b", textTransform: "uppercase", letterSpacing: 1.5 }}>Top Donors</p>
            {users.length === 0 ? <p style={{ color: "#a0a89a", fontSize: 14 }}>No users yet.</p> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {users.map((u) => ({ ...u, total: donations.filter((d) => d.email === u.email).reduce((s, d) => s + d.amount, 0) }))
                  .sort((a, b) => b.total - a.total).slice(0, 10).map((u, i) => (
                    <div key={u.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #eef0e8" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span style={{ width: 24, height: 24, borderRadius: "50%", background: i < 3 ? "#4a6741" : "#d4d9cc", color: i < 3 ? "#fff" : "#6b7f6b", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>{i + 1}</span>
                        <div>
                          <p style={{ margin: 0, fontSize: 14, fontWeight: 500 }}>{u.firstName} {u.lastName}</p>
                          <p style={{ margin: 0, fontSize: 12, color: "#8a9484" }}>{u.email}</p>
                        </div>
                      </div>
                      <span style={{ fontFamily: "'Source Serif 4', Georgia, serif", fontWeight: 700, fontSize: 15, color: "#2d3a2d" }}>{formatCurrency(u.total)}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Users Tab */}
      {tab === "users" && (
        <div>
          <div style={{ marginBottom: 16 }}>
            <input value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="Search users by name or email..."
              style={{ width: "100%", padding: "10px 14px", border: "1.5px solid #d4d9cc", borderRadius: 8, fontSize: 14, fontFamily: "'Source Serif 4', Georgia, serif", background: "#fafaf6", color: "#2d3a2d", outline: "none", boxSizing: "border-box" }} />
          </div>
          {filteredUsers.length === 0 ? (
            <div style={{ textAlign: "center", padding: 48, color: "#a0a89a" }}><p style={{ fontSize: 32, margin: "0 0 8px" }}>👤</p><p style={{ margin: 0, fontFamily: "'DM Mono', monospace", fontSize: 13 }}>No users found</p></div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {filteredUsers.map((u) => {
                const uDons = donations.filter((d) => d.email === u.email);
                const uTotal = uDons.reduce((s, d) => s + d.amount, 0);
                const isEditing = editingUser === u.id;
                return (
                  <div key={u.id} style={{ background: "#fff", borderRadius: 10, border: "1px solid #e4e8dc", overflow: "hidden" }}>
                    <div style={{ padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div style={{ flex: 1 }}>
                        {isEditing ? (
                          <div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
                              <Input label="First Name" required value={editForm.firstName} onChange={(e) => setEditForm({ ...editForm, firstName: e.target.value })} />
                              <Input label="Last Name" required value={editForm.lastName} onChange={(e) => setEditForm({ ...editForm, lastName: e.target.value })} />
                            </div>
                            <Input label="Email" required value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
                            <Input label="Phone" value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} />
                            <Input label="Street" value={editForm.street} onChange={(e) => setEditForm({ ...editForm, street: e.target.value })} />
                            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "0 10px" }}>
                              <Input label="City" value={editForm.city} onChange={(e) => setEditForm({ ...editForm, city: e.target.value })} />
                              <Input label="State" value={editForm.state} onChange={(e) => setEditForm({ ...editForm, state: e.target.value })} />
                              <Input label="Zip" value={editForm.zip} onChange={(e) => setEditForm({ ...editForm, zip: e.target.value })} />
                            </div>
                            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                              <Button onClick={saveEditUser} style={{ padding: "8px 16px" }}>Save</Button>
                              <Button variant="ghost" onClick={() => setEditingUser(null)} style={{ padding: "8px 16px" }}>Cancel</Button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <p style={{ margin: "0 0 2px", fontSize: 16, fontWeight: 600, color: "#2d3a2d" }}>{u.firstName} {u.lastName}</p>
                            <p style={{ margin: "0 0 4px", fontSize: 13, color: "#8a9484" }}>{u.email}{u.phone ? ` · ${u.phone}` : ""}</p>
                            {u.street && <p style={{ margin: 0, fontSize: 12, color: "#a0a89a" }}>{u.street}{u.city ? `, ${u.city}` : ""}{u.state ? `, ${u.state}` : ""} {u.zip}</p>}
                          </>
                        )}
                      </div>
                      {!isEditing && (
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: 16 }}>
                          <div style={{ textAlign: "right" }}>
                            <p style={{ margin: 0, fontFamily: "'Source Serif 4', Georgia, serif", fontWeight: 700, fontSize: 16, color: "#2d3a2d" }}>{formatCurrency(uTotal)}</p>
                            <p style={{ margin: 0, fontSize: 11, color: "#a0a89a" }}>{uDons.length} donation{uDons.length !== 1 ? "s" : ""}</p>
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <Button variant="ghost" onClick={() => startEditUser(u)} style={{ padding: "4px 10px", fontSize: 11 }}>Edit</Button>
                            <Button variant="ghost" onClick={() => setConfirm({ message: `Delete ${u.firstName} ${u.lastName} and all their donations?`, action: () => onDeleteUser(u.id) })} style={{ padding: "4px 10px", fontSize: 11, color: "#c97b5a" }}>Delete</Button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* All Donations Tab */}
      {tab === "donations" && (
        <div>
          <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
            <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)} style={{ padding: "6px 12px", border: "1.5px solid #d4d9cc", borderRadius: 6, fontFamily: "'DM Mono', monospace", fontSize: 12, background: "#fafaf6", color: "#2d3a2d", cursor: "pointer" }}>
              <option value="all">All Donors</option>
              {users.map((u) => <option key={u.id} value={u.email}>{u.firstName} {u.lastName}</option>)}
            </select>
            <select value={yearFilter} onChange={(e) => setYearFilter(e.target.value)} style={{ padding: "6px 12px", border: "1.5px solid #d4d9cc", borderRadius: 6, fontFamily: "'DM Mono', monospace", fontSize: 12, background: "#fafaf6", color: "#2d3a2d", cursor: "pointer" }}>
              <option value="all">All Years</option>
              {allYears.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={{ padding: "6px 12px", border: "1.5px solid #d4d9cc", borderRadius: 6, fontFamily: "'DM Mono', monospace", fontSize: 12, background: "#fafaf6", color: "#2d3a2d", cursor: "pointer" }}>
              <option value="all">All Types</option>
              {DONATION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <span style={{ marginLeft: "auto", fontSize: 13, color: "#6b7f6b", alignSelf: "center" }}>
              {filteredDonations.length} result{filteredDonations.length !== 1 ? "s" : ""} · {formatCurrency(filteredDonations.reduce((s, d) => s + d.amount, 0))}
            </span>
          </div>

          {filteredDonations.length === 0 ? (
            <div style={{ textAlign: "center", padding: 48, color: "#a0a89a" }}><p style={{ fontSize: 32, margin: "0 0 8px" }}>💰</p><p style={{ margin: 0, fontFamily: "'DM Mono', monospace", fontSize: 13 }}>No donations found</p></div>
          ) : (
            <div style={{ borderRadius: 10, overflow: "hidden", border: "1px solid #e4e8dc" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 700 }}>
                  <thead><tr style={{ background: "#f0f3ea" }}>
                    {["Date", "Donor", "Type", "Ref", "Amount", "Receipt", ""].map((h) => <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontFamily: "'DM Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: 1.5, color: "#6b7f6b", fontWeight: 500 }}>{h}</th>)}
                  </tr></thead>
                  <tbody>{filteredDonations.map((d, i) => {
                    const u = users.find((u) => u.email === d.email);
                    return (
                      <tr key={d.id} style={{ borderTop: "1px solid #eef0e8", background: i % 2 === 0 ? "#fff" : "#fcfcf8" }}>
                        <td style={{ padding: "10px 14px", color: "#2d3a2d" }}>{formatDate(d.date)}</td>
                        <td style={{ padding: "10px 14px", fontWeight: 500 }}>{u ? `${u.firstName} ${u.lastName}` : d.email}</td>
                        <td style={{ padding: "10px 14px" }}><Badge>{d.type}</Badge></td>
                        <td style={{ padding: "10px 14px", color: "#8a9484" }}>{d.checkNumber ? `#${d.checkNumber}` : "—"}</td>
                        <td style={{ padding: "10px 14px", fontFamily: "'Source Serif 4', Georgia, serif", fontWeight: 600 }}>{formatCurrency(d.amount)}</td>
                        <td style={{ padding: "10px 14px" }}><ReceiptButton donationId={d.id} hasAttachment={d.hasAttachment} /></td>
                        <td style={{ padding: "10px 14px" }}>
                          <button onClick={() => setConfirm({ message: `Delete this ${formatCurrency(d.amount)} ${d.type} donation?`, action: () => { onDeleteDonation(d.id); deleteAttachment(d.id); } })}
                            style={{ background: "none", border: "none", color: "#c97b5a", cursor: "pointer", fontSize: 12, fontFamily: "'DM Mono', monospace", padding: "4px 8px" }}>✕</button>
                        </td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Scan & Add Tab */}
      {tab === "add" && (
        <DonationForm users={users} onAddDonation={onAddDonation} showDonorSelect={true} />
      )}

      {/* Reports Tab */}
      {tab === "reports" && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
            <div style={{ background: "#fafaf6", borderRadius: 12, padding: 24, border: "1px solid #e8eae2" }}>
              <p style={{ margin: "0 0 8px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#6b7f6b", textTransform: "uppercase", letterSpacing: 1.5 }}>{ORG_NAME} Export Data</p>
              <p style={{ margin: "0 0 16px", fontSize: 14, color: "#6b7f6b", lineHeight: 1.5 }}>Download all donation records (including {FUND_NAME}) as a CSV spreadsheet.</p>
              <Button variant="secondary" onClick={() => generateCSVExport(users, donations)} disabled={donations.length === 0}>Download CSV</Button>
            </div>
            <div style={{ background: "#fafaf6", borderRadius: 12, padding: 24, border: "1px solid #e8eae2" }}>
              <p style={{ margin: "0 0 8px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#6b7f6b", textTransform: "uppercase", letterSpacing: 1.5 }}>{ORG_NAME} Bulk Tax Letters</p>
              <p style={{ margin: "0 0 16px", fontSize: 14, color: "#6b7f6b", lineHeight: 1.5 }}>Generate tax letters for all donors for a given year.</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {allYears.length === 0 ? <p style={{ color: "#a0a89a", fontSize: 13 }}>No data yet.</p> : allYears.map((y) => (
                  <Button key={y} variant="secondary" onClick={() => {
                    users.forEach((u) => { if (donations.some((d) => d.email === u.email && new Date(d.date).getFullYear() === y)) generateTaxLetter(u, donations, y); });
                  }} style={{ padding: "8px 16px" }}>{y}</Button>
                ))}
              </div>
            </div>
          </div>

          <div style={{ background: "#fafaf6", borderRadius: 12, padding: 24, border: "1px solid #e8eae2" }}>
            <p style={{ margin: "0 0 16px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#6b7f6b", textTransform: "uppercase", letterSpacing: 1.5 }}>Yearly Summary</p>
            {allYears.length === 0 ? <p style={{ color: "#a0a89a", fontSize: 14 }}>No donations yet.</p> : (
              <div style={{ borderRadius: 8, overflow: "hidden", border: "1px solid #e4e8dc" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <thead><tr style={{ background: "#f0f3ea" }}>
                    {["Year", "Donors", "Donations", "Receipts", "Total"].map((h) => <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontFamily: "'DM Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: 1.5, color: "#6b7f6b", fontWeight: 500 }}>{h}</th>)}
                  </tr></thead>
                  <tbody>{allYears.map((y, i) => {
                    const yDons = donations.filter((d) => new Date(d.date).getFullYear() === y);
                    const yReceipts = yDons.filter((d) => d.hasAttachment).length;
                    return (
                      <tr key={y} style={{ borderTop: "1px solid #eef0e8", background: i % 2 === 0 ? "#fff" : "#fcfcf8" }}>
                        <td style={{ padding: "12px 16px", fontWeight: 700, fontFamily: "'Source Serif 4', Georgia, serif" }}>{y}</td>
                        <td style={{ padding: "12px 16px" }}>{new Set(yDons.map((d) => d.email)).size}</td>
                        <td style={{ padding: "12px 16px" }}>{yDons.length}</td>
                        <td style={{ padding: "12px 16px" }}>{yReceipts > 0 ? <Badge color="#4a6741" bg="#eef3ea">📎 {yReceipts}</Badge> : "—"}</td>
                        <td style={{ padding: "12px 16px", fontWeight: 600, fontFamily: "'Source Serif 4', Georgia, serif" }}>{formatCurrency(yDons.reduce((s, d) => s + d.amount, 0))}</td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── App ───

export default function App() {
  const [users, setUsers] = useState([]);
  const [donations, setDonations] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [page, setPage] = useState("login");
  const [loaded, setLoaded] = useState(false);
  const [adminPin, setAdminPin] = useState("");
  const [showAdminPrompt, setShowAdminPrompt] = useState(false);
  const [adminError, setAdminError] = useState("");

  useEffect(() => {
    loadData()
      .then((data) => {
        if (data) { setUsers(data.users || []); setDonations(data.donations || []); }
      })
      .finally(() => setLoaded(true));
  }, []);

  const persist = useCallback(async (u, d) => {
    await saveData({ users: u, donations: d });
  }, []);

  const handleRegister = async (user) => {
    const next = [...users, user];
    setUsers(next);
    await persist(next, donations);
    setCurrentUser(user); setPage("dashboard");
  };
  const handleAddDonation = async (don) => {
    const next = [...donations, don];
    setDonations(next);
    await persist(users, next);
  };
  const handleDeleteDonation = async (id) => {
    const next = donations.filter((d) => d.id !== id);
    setDonations(next);
    await persist(users, next);
  };
  const handleDeleteUser = async (id) => {
    const user = users.find((u) => u.id === id);
    const nextUsers = users.filter((u) => u.id !== id);
    const nextDons = user ? donations.filter((d) => d.email !== user.email) : donations;
    setUsers(nextUsers);
    setDonations(nextDons);
    await persist(nextUsers, nextDons);
  };
  const handleUpdateUser = async (id, updates) => {
    const existing = users.find((u) => u.id === id);
    if (!existing) return;

    const updatedUser = { ...existing, ...updates };
    const nextUsers = users.map((u) => (u.id === id ? updatedUser : u));
    const nextDons = existing.email !== updatedUser.email
      ? donations.map((d) => (d.email === existing.email ? { ...d, email: updatedUser.email } : d))
      : donations;

    setUsers(nextUsers);
    setDonations(nextDons);
    await persist(nextUsers, nextDons);
  };
  const handleLogin = (user) => { setCurrentUser(user); setPage("dashboard"); };
  const handleLogout = () => { setCurrentUser(null); setPage("login"); };
  const handleAdminLogin = () => {
    if (adminPin === ADMIN_PIN) { setPage("admin"); setShowAdminPrompt(false); setAdminPin(""); setAdminError(""); }
    else setAdminError("Incorrect PIN.");
  };

  if (!loaded) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f4f4ec", fontFamily: "'DM Mono', monospace", color: "#8a9484" }}>Loading...</div>
  );

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@400;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      <div style={{ minHeight: "100vh", background: page === "admin" ? "#eaecf0" : "#f4f4ec", fontFamily: "'Source Serif 4', Georgia, serif", color: "#2d3a2d", transition: "background 0.3s" }}>

        {showAdminPrompt && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
            <div style={{ background: "#fafaf6", borderRadius: 14, padding: 28, maxWidth: 340, width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }}>
              <p style={{ margin: "0 0 4px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#3a4a5a", textTransform: "uppercase", letterSpacing: 1.5 }}>{ORG_NAME} Admin Access</p>
              <p style={{ margin: "0 0 16px", fontSize: 14, color: "#6b7f6b" }}>Enter the admin PIN to continue.</p>
              {adminError && <div style={{ background: "#fdf0ea", color: "#c97b5a", padding: "8px 12px", borderRadius: 6, fontSize: 13, marginBottom: 12 }}>{adminError}</div>}
              <input type="password" value={adminPin} onChange={(e) => setAdminPin(e.target.value)} placeholder="PIN" autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleAdminLogin()}
                style={{ width: "100%", padding: "10px 14px", border: "1.5px solid #d4d9cc", borderRadius: 8, fontSize: 18, fontFamily: "'DM Mono', monospace", background: "#fafaf6", color: "#2d3a2d", outline: "none", boxSizing: "border-box", textAlign: "center", letterSpacing: 8 }} />
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
                <Button variant="ghost" onClick={() => { setShowAdminPrompt(false); setAdminPin(""); setAdminError(""); }}>Cancel</Button>
                <Button variant="admin" onClick={handleAdminLogin}>Enter</Button>
              </div>
            </div>
          </div>
        )}

        <div style={{ padding: "14px 32px", borderBottom: page === "admin" ? "1px solid #d0d4dc" : "1px solid #e4e8dc", display: "flex", justifyContent: "space-between", alignItems: "center", background: page === "admin" ? "rgba(234,236,240,0.9)" : "rgba(244,244,236,0.9)", backdropFilter: "blur(10px)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 20 }}>{page === "admin" ? "⚙️" : "🌿"}</span>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, fontWeight: 500, letterSpacing: 1, color: page === "admin" ? "#3a4a5a" : "#4a6741" }}>
              {ORG_NAME} DONATION TRACKER {page === "admin" && "· ADMIN"}
            </span>
          </div>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            {page !== "dashboard" && page !== "admin" && (
              <>
                <Button variant={page === "login" ? "primary" : "ghost"} onClick={() => setPage("login")} style={{ padding: "6px 14px", fontSize: 12 }}>Login</Button>
                <Button variant={page === "register" ? "primary" : "ghost"} onClick={() => setPage("register")} style={{ padding: "6px 14px", fontSize: 12 }}>Register</Button>
              </>
            )}
            {page !== "admin" && (
              <Button variant="ghost" onClick={() => setShowAdminPrompt(true)} style={{ padding: "6px 14px", fontSize: 11, color: "#a0a89a" }}>Admin</Button>
            )}
          </div>
        </div>

        <div style={{ maxWidth: page === "admin" ? 900 : 720, margin: "0 auto", padding: "40px 24px", transition: "max-width 0.3s" }}>
          {page === "login" && <LoginPage users={users} onLogin={handleLogin} onGoRegister={() => setPage("register")} />}
          {page === "register" && <RegisterPage users={users} onRegister={handleRegister} onGoLogin={() => setPage("login")} />}
          {page === "dashboard" && <UserDashboard user={currentUser} users={users} donations={donations} onAddDonation={handleAddDonation} onLogout={handleLogout} />}
          {page === "admin" && (
            <AdminDashboard users={users} donations={donations}
              onAddDonation={handleAddDonation} onDeleteDonation={handleDeleteDonation}
              onDeleteUser={handleDeleteUser} onUpdateUser={handleUpdateUser}
              onLogout={() => setPage("login")} />
          )}
        </div>
      </div>
    </>
  );
}
