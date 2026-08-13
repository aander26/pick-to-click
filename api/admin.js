// ============================================================================
// Pick to Click 2026 — serverless admin function (runs on Vercel)
//
// This is the ONLY place the secret keys live. They are read from Vercel
// environment variables at runtime and never reach the browser:
//   ADMIN_KEY                  - the password you invent to authorize admin actions
//   SUPABASE_URL               - your project URL (same one the app uses)
//   SUPABASE_SERVICE_ROLE_KEY  - Supabase service key (bypasses row-level security)
//
// The browser calls this endpoint (POST /api/admin) with the admin key in the
// body. Every privileged action — lock/unlock picks, set k, push 2026 stats,
// delete an entry — happens here, server-side.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// Constant-time compare so a wrong key can't be guessed by timing the response.
function keyMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const ADMIN_KEY = process.env.ADMIN_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Fail loudly (but without leaking secrets) if the env vars are missing.
  // This is the most common deploy snag, so the message is explicit.
  const missing = [];
  if (!ADMIN_KEY) missing.push('ADMIN_KEY');
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    return res.status(500).json({
      error: 'Server is missing environment variables: ' + missing.join(', ') +
             '. Set them in Vercel > Project > Settings > Environment Variables, then redeploy.'
    });
  }

  // Vercel parses JSON bodies automatically, but guard for string bodies too.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  if (!keyMatches(body.adminKey, ADMIN_KEY)) {
    return res.status(401).json({ error: 'Unauthorized: wrong admin key.' });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const action = body.action;

  try {
    switch (action) {

      // --- Lock / unlock the submission window --------------------------------
      case 'lock': {
        const { error } = await supabase
          .from('settings')
          .update({ submissions_locked: true, locked_at: new Date().toISOString() })
          .eq('id', 1);
        if (error) throw error;
        return res.status(200).json({ ok: true, message: 'Submissions locked. Picks are now revealed.' });
      }

      case 'unlock': {
        const { error } = await supabase
          .from('settings')
          .update({ submissions_locked: false, locked_at: null })
          .eq('id', 1);
        if (error) throw error;
        return res.status(200).json({ ok: true, message: 'Submissions re-opened. Picks hidden again.' });
      }

      // --- Tune the smoothing constant k -------------------------------------
      case 'set_k': {
        const k = Number(body.k);
        if (!Number.isFinite(k) || k < 0) {
          return res.status(400).json({ error: 'k must be a number >= 0.' });
        }
        const { error } = await supabase.from('settings').update({ k }).eq('id', 1);
        if (error) throw error;
        return res.status(200).json({ ok: true, message: 'k set to ' + k + '.' });
      }

      // --- Set an optional display deadline ----------------------------------
      case 'set_deadline': {
        const lock_at = body.lock_at ? new Date(body.lock_at).toISOString() : null;
        const { error } = await supabase.from('settings').update({ lock_at }).eq('id', 1);
        if (error) throw error;
        return res.status(200).json({ ok: true, message: 'Deadline updated.' });
      }

      // --- Push 2026 cumulative stats ----------------------------------------
      // body.stats = [{ player_id, rush_yds, rec, tackles, ... }, ...]
      // Any stat column left out defaults to 0. Upsert = insert or replace.
      case 'update_stats': {
        const stats = Array.isArray(body.stats) ? body.stats : null;
        if (!stats || stats.length === 0) {
          return res.status(400).json({ error: 'Provide a non-empty stats array.' });
        }
        const allowed = ['rush_att','rush_yds','rush_td','pass_att','pass_yds','pass_td',
                         'pass_int','rec','rec_yds','rec_td','tackles','tfl','sacks','int','pbu'];
        const rows = [];
        for (const s of stats) {
          if (!s || !s.player_id) {
            return res.status(400).json({ error: 'Every stat row needs a player_id.' });
          }
          const row = { player_id: String(s.player_id), updated_at: new Date().toISOString() };
          for (const col of allowed) {
            if (s[col] !== undefined && s[col] !== null && s[col] !== '') {
              const v = Number(s[col]);
              if (!Number.isFinite(v)) {
                return res.status(400).json({ error: 'Non-numeric value for ' + col + ' on ' + s.player_id });
              }
              row[col] = v;
            }
          }
          rows.push(row);
        }
        const { error } = await supabase.from('live_stats').upsert(rows, { onConflict: 'player_id' });
        if (error) throw error;
        return res.status(200).json({ ok: true, message: 'Updated stats for ' + rows.length + ' player(s).' });
      }

      // --- Remove one player's live stat line (e.g. entered by mistake) ------
      case 'clear_stats': {
        if (!body.player_id) return res.status(400).json({ error: 'Provide player_id.' });
        const { error } = await supabase.from('live_stats').delete().eq('player_id', String(body.player_id));
        if (error) throw error;
        return res.status(200).json({ ok: true, message: 'Cleared stats for ' + body.player_id + '.' });
      }

      // --- Delete an entry (fix a mistaken/duplicate submission) --------------
      case 'delete_entry': {
        if (!body.entry_id) return res.status(400).json({ error: 'Provide entry_id.' });
        const { error } = await supabase.from('entries').delete().eq('id', body.entry_id);
        if (error) throw error;
        return res.status(200).json({ ok: true, message: 'Entry deleted.' });
      }

      // --- Read-back for the admin panel -------------------------------------
      case 'status': {
        const { data: settings, error: e1 } = await supabase
          .from('settings').select('*').eq('id', 1).single();
        if (e1) throw e1;
        const { count, error: e2 } = await supabase
          .from('entries').select('*', { count: 'exact', head: true });
        if (e2) throw e2;
        return res.status(200).json({ ok: true, settings, entry_count: count });
      }

      default:
        return res.status(400).json({ error: 'Unknown action: ' + String(action) });
    }
  } catch (err) {
    return res.status(500).json({ error: (err && err.message) ? err.message : 'Server error.' });
  }
};
