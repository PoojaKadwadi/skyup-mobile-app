// ── Contact-name ↔ recording-filename matching ────────────────────────────────
// Shared by LeadRecordingsSection (manual scan) and recordingService (auto sync)
// so the two paths can never drift apart again.
//
// BUG THIS FIXES: the old matcher accepted a file if it shared ANY single
// token of 4+ characters with the lead name. Common Indian surnames / given-name
// parts are shared across many contacts, so:
//   lead "Surendra Kumar Chikara"  ← "Call Kunal Kumar Mandal_….m4a"   (kumar)
//   lead "Syed Habeeb"             ← "Call Syed Aftab_….m4a"           (syed)
// were treated as the same person, listed under the wrong lead AND uploaded
// against the wrong lead's number. It also did raw substring checks, so
// "ram" matched inside "ramesh".
//
// New rule (token-based, whole words only):
//   1. Every lead-name token appears in the filename  → match.
//      ("Pooja" ← "pooja kadwadi", "Ramesh Kumar" ← "kumar ramesh")
//   2. Otherwise, the filename may carry a SHORTER form of the lead's name,
//      but only if EVERY filename token belongs to the lead's name (no extra
//      name = no other person) AND at least one shared token is distinctive
//      (not a common surname/honorific).
//      ("Ramesh Kumar" ← "ramesh" ✔, "Syed Habeeb" ← "syed" ✘,
//       "Surendra Kumar Chikara" ← "kunal kumar mandal" ✘)

// Dialer/app boilerplate words that are never part of a contact name.
const FILENAME_NOISE = /\b(call|calls|recording|recordings|rec|record|voice|audio|incoming|outgoing|outgoingcall|incomingcall|with|to|from)\b/gi;

// Tokens too common to identify a person on their own.
const COMMON_NAME_TOKENS = new Set([
  'kumar', 'kumari', 'singh', 'kaur', 'devi', 'bai', 'bhai', 'ben', 'lal',
  'syed', 'sayed', 'saiyed', 'shaikh', 'sheikh', 'shaik', 'mohammed', 'mohammad',
  'muhammad', 'mohamed', 'mohd', 'md', 'khan', 'ali', 'ahmed', 'ahmad',
  'sri', 'shri', 'shree', 'smt', 'mr', 'mrs', 'ms', 'miss', 'dr', 'sir', 'madam',
  'rao', 'reddy', 'naidu', 'gowda', 'sharma', 'verma', 'gupta', 'patel', 'shah',
  'yadav', 'das', 'raj', 'nath', 'prasad', 'babu', 'swamy', 'iyer', 'nair',
]);

export function normaliseForNameMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[_\-.+()]+/g, ' ')   // separators → spaces
    .replace(/\d+/g, ' ')          // date/time/last-4 digit clusters
    .replace(/[•*·]+/g, ' ')       // masked-number glyphs
    .replace(FILENAME_NOISE, ' ')  // dialer boilerplate
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  return normaliseForNameMatch(text).split(' ').filter(t => t.length >= 2);
}

// Tokens of the filename (extension stripped).
export function filenameNameTokens(filename) {
  return tokens(String(filename || '').replace(/\.[a-z0-9]{1,5}$/i, ''));
}

export function filenameMatchesName(filename, leadName) {
  if (!leadName || String(leadName).trim().length < 2) return false;

  const fTokens = filenameNameTokens(filename);
  const nTokens = tokens(leadName);
  if (fTokens.length === 0 || nTokens.length === 0) return false;

  const fSet = new Set(fTokens);
  const nSet = new Set(nTokens);

  // 1. Full lead name present in the filename.
  if (nTokens.every(t => fSet.has(t))) return true;

  // 2. Filename holds only part of the lead's name, nothing else.
  if (!fTokens.every(t => nSet.has(t))) return false; // names someone else
  return fTokens.some(t => t.length >= 3 && !COMMON_NAME_TOKENS.has(t));
}
