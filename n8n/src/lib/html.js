// ── Échappement HTML (toute donnée externe — HAL, RSS, LLM — passe par esc) ──
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function nl2br(v) { return esc(v).replace(/\r?\n/g, '<br>'); }
function safeColor(v, fallback) { return /^#[0-9a-fA-F]{3,8}$/.test(String(v || '')) ? v : fallback; }
function safeUrl(v) { return /^https?:\/\//i.test(String(v || '')) ? String(v) : ''; }
function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d) ? '' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Paris' });
}
function fmtDateTime(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d) ? '' : d.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Paris' });
}
