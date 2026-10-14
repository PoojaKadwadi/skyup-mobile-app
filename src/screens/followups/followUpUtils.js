// src/screens/followups/followUpUtils.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Pure logic for the Follow-ups screen (no React / no React Native in here, so it is easy to test).
//
// The server (GET /reports/follow-ups) returns the same lists as the web Daily Report's "Follow-ups" tab:
//   followUps         every pending follow-up: due date, urgency, who set it (origin: 'employee' | 'auto'),
//                     the employee's own REMARK (what they typed on the lead), and the follow-up's own note
//                     when a person wrote it (system-written text is dropped)
//   missingFollowUps  leads 24h+ old that never had a follow-up date
//   employees         per-employee counts
// This file turns that into rows, filters them and groups them for the screen.
// ─────────────────────────────────────────────────────────────────────────────

export const URGENCY_ORDER = ['overdue', 'today', 'upcoming', 'missing'];

export const URGENCY_CFG = {
  overdue:  { label: 'Overdue',            color: '#EF4444', icon: 'alert-circle-outline'   },
  today:    { label: 'Due today',          color: '#F59E0B', icon: 'phone-clock'            },
  upcoming: { label: 'Upcoming',           color: '#3B82F6', icon: 'calendar-arrow-right'   },
  missing:  { label: 'No follow-up date',  color: '#B91C1C', icon: 'calendar-remove-outline' },
};

export function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 6) return '••••••';
  return d.slice(0, 2) + '•••••' + d.slice(-2);
}

export function initials(name) {
  return (name || '?').split(' ').filter(Boolean).map((n) => n[0]).join('').slice(0, 2).toUpperCase() || '?';
}

export function waitingLabel(hours) {
  const h = Math.max(0, Number(hours) || 0);
  if (h < 48) return `${h}h · no date`;                       // short enough for the card's pill
  return `${Math.floor(h / 24)} days · no date`;
}

// A blank / whitespace-only remark is no remark (never draw an empty quote box).
function remarkOf(r) {
  const text = r && r.text ? String(r.text).trim() : '';
  return text ? { text, by: r.by || '', at: r.at || null } : null;
}

const UNASSIGNED = 'unassigned';
const empId = (v) => (v ? String(v) : UNASSIGNED);

// One row per follow-up / per lead missing a date.
export function normalizeReport(report) {
  const r = report || {};
  const out = [];
  (r.followUps || []).forEach((f, i) => {
    out.push({
      key: `f:${f._id}:${f.scheduledAt}:${i}`, kind: 'followup', leadId: String(f._id),
      name: f.name || '', mobile: f.mobile || '', status: f.status || '',
      urgency: URGENCY_CFG[f.urgency] ? f.urgency : 'upcoming', daysLabel: f.daysLabel || '',
      scheduledAt: f.scheduledAt || null, type: f.type || 'follow-up',
      // set by an employee, or created automatically (workflow / verification)? An older server doesn't say → treat as employee.
      origin: f.origin === 'auto' ? 'auto' : 'employee',
      // what the employee wrote: their remark on the lead, and the follow-up's note only when a person wrote it.
      // (An older server sends neither → fall back to its plain note, as before.)
      remark: remarkOf(f.employeeRemark),
      note: f.customNote !== undefined ? String(f.customNote || '').trim() : String(f.note || '').trim(),
      employee: f.assignedUser || 'Unassigned', employeeId: empId(f.userId), hours: 0,
    });
  });
  (r.missingFollowUps || []).forEach((m) => {
    out.push({
      key: `m:${m._id}`, kind: 'missing', leadId: String(m._id),
      name: m.name || '', mobile: m.mobile || '', status: m.status || '',
      urgency: 'missing', daysLabel: waitingLabel(m.hoursSinceCreated),
      scheduledAt: null, note: '', remark: null, origin: 'employee', type: '', employee: m.assignedUser || 'Unassigned', employeeId: empId(m.userId), hours: Number(m.hoursSinceCreated) || 0,
    });
  });
  return out;
}

const digitsOf = (v) => String(v || '').replace(/\D/g, '');

// employeeId: 'all' | an employee id | 'unassigned'      urgency: 'all' | overdue | today | upcoming | missing
// source: 'all' | 'employee' (set by an employee) | 'auto' (created automatically) — applies to follow-ups only;
//         a lead with no follow-up date at all has no source, so it is never hidden by this.
export function filterItems(items, { employeeId = 'all', urgency = 'all', search = '', source = 'all' } = {}) {
  const q = String(search || '').trim().toLowerCase();
  const qd = digitsOf(q);
  return items.filter((it) => {
    if (employeeId !== 'all' && it.employeeId !== employeeId) return false;
    if (urgency !== 'all' && it.urgency !== urgency) return false;
    if (source !== 'all' && it.kind === 'followup' && it.origin !== source) return false;
    if (!q) return true;
    if (String(it.name).toLowerCase().includes(q) || String(it.note).toLowerCase().includes(q)
      || String(it.remark ? it.remark.text : '').toLowerCase().includes(q) || String(it.remark ? it.remark.by : '').toLowerCase().includes(q)
      || String(it.employee).toLowerCase().includes(q) || String(it.status).toLowerCase().includes(q)) return true;
    return qd.length >= 3 && digitsOf(it.mobile).includes(qd);
  });
}

export function countByUrgency(items) {
  const c = { overdue: 0, today: 0, upcoming: 0, missing: 0, total: items.length };
  for (const it of items) c[it.urgency] = (c[it.urgency] || 0) + 1;
  return c;
}

// How many follow-ups were set by an employee vs created automatically (leads with no date don't count).
export function countBySource(items) {
  const c = { employee: 0, auto: 0 };
  for (const it of items) if (it.kind === 'followup') c[it.origin] = (c[it.origin] || 0) + 1;
  return c;
}

// The employee picker: everyone who has something pending, with their total.
export function employeeOptions(employees) {
  const list = (employees || []).map((e) => ({ value: empId(e.userId), label: `${e.name || 'Unassigned'} (${e.total})` }));
  return [{ value: 'all', label: 'All employees' }, ...list];
}

const byDue = (a, b) => {
  const o = URGENCY_ORDER.indexOf(a.urgency) - URGENCY_ORDER.indexOf(b.urgency);
  if (o) return o;
  if (a.urgency === 'missing') return b.hours - a.hours;                        // waiting longest first
  return new Date(a.scheduledAt) - new Date(b.scheduledAt);                      // earliest due first
};

// groupBy 'urgency': Overdue → Due today → Upcoming → No follow-up date
// groupBy 'employee': one section per employee (most overdue first), each ordered by urgency then date
export function groupItems(items, groupBy = 'urgency') {
  if (groupBy === 'employee') {
    const map = new Map();
    for (const it of items) {
      if (!map.has(it.employeeId)) map.set(it.employeeId, { key: it.employeeId, title: it.employee, data: [] });
      map.get(it.employeeId).data.push(it);
    }
    return [...map.values()].map((s) => {
      s.data.sort(byDue);
      s.counts = countByUrgency(s.data);
      return s;
    }).sort((a, b) => (b.counts.overdue - a.counts.overdue) || (b.counts.today - a.counts.today) || (b.counts.total - a.counts.total) || a.title.localeCompare(b.title));
  }
  return URGENCY_ORDER.map((k) => {
    const data = items.filter((it) => it.urgency === k).sort(byDue);
    return { key: k, title: URGENCY_CFG[k].label, color: URGENCY_CFG[k].color, data, counts: countByUrgency(data) };
  }).filter((s) => s.data.length);
}
