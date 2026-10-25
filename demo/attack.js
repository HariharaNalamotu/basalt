// Basalt security demo: try to break a live Basalt app from inside its own page, the way a
// hacker (or broken AI-written code) would. Paste this whole file into the browser console on
// the app, signed in.
//
//   1. As customer A: run basaltAttack(). It copies a command naming one of A's entries.
//   2. As customer B (another browser profile): paste this file, then paste that command.
//
// Every attempt goes through the same door the app's own code uses (/_basalt/data), with B's
// real login. Nothing here is special to the demo: Basalt has no "demo mode" for these checks.
(() => {
  const BASE = '/_basalt/data';
  const SYSTEM = ['id', 'owner_id', 'created_at', 'updated_at', 'archived_at'];

  async function call(path, body, headers = {}) {
    try {
      const res = await fetch(BASE + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, ok: Boolean(json && json.ok), data: json && json.data, error: json && json.error };
    } catch (e) {
      return { status: 0, ok: false, error: { message: String(e) } };
    }
  }
  const data = (op, body, headers) => call(`/v1/data/${op}`, body, headers);
  // A clear "no" from Basalt: a 4xx answer, not a crash or a busy signal.
  const refused = (r) => !r.ok && r.status >= 400 && r.status < 500 && r.status !== 429;
  const said = (r) => (r.error && r.error.message ? `: ${r.error.message}` : ` status ${r.status}`);

  // A login that claims to be customer A, signed with a made up key.
  function forgedLogin(sub) {
    const enc = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const now = Math.floor(Date.now() / 1000);
    const sig = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b % 64]).join('').slice(0, 43);
    return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub, aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600 })}.${sig.padEnd(43, 'A')}`;
  }

  // A copy of one of B's own entries that the rules will accept, at a fresh time so it can't
  // clash with a real booking. If the app has a unique rule (one person per class spot), a plain
  // copy still clashes, so later tries also tag plain text (tries >= 1) and move whole numbers
  // (tries >= 2). Emails and phone numbers stay as they are, so they still pass their format.
  function copyOf(row, tries = 0) {
    const input = {};
    const tag = Math.random().toString(36).slice(2, 6);
    for (const [k, v] of Object.entries(row)) {
      if (SYSTEM.includes(k) || v === null) continue;
      const plainText = typeof v === 'string' && !/@/.test(v) && !/^\+?[\d\s().-]{7,}$/.test(v);
      input[k] = typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)
        ? new Date(Date.UTC(2099, 0, 1) + Math.floor(Math.random() * 5e5) * 60000).toISOString()
        : tries >= 1 && plainText ? `${v}-t${tag}`
          : tries >= 2 && Number.isInteger(v) ? (v > 1 ? v - 1 : v + 1)
            : v;
    }
    return input;
  }
  // Saves a copy of B's entry (plus anything in extra), trying fresh values while it clashes.
  async function saveCopy(table, row, extra = {}) {
    let r;
    for (let tries = 0; tries < 3; tries++) {
      r = await data('create', { table, input: { ...copyOf(row, tries), ...extra } });
      if (r.status !== 409) return r;
    }
    return r;
  }

  // The stage panel from the Basalt design system (design/README.md, "Stage demo panel"): black and
  // silver, every result on one screen in two columns, status shown by word, icon and color.
  const ICON = {
    REFUSED: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
    LEAKED: '<path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9Z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    BROKEN: '<path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9Z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    "CAN'T TELL": '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    WORKS: '<path d="M20 6 9 17l-5-5"/>',
  };
  const TONE = { REFUSED: 'safe', LEAKED: 'danger', BROKEN: 'danger', "CAN'T TELL": 'warning', WORKS: 'info' };
  const STAGE_CSS = `
#basalt-attack{--bg-0:#0C0E11;--bg-1:#13161A;--bg-2:#1B1F24;--border:#353D47;--edge:#7D8996;--text:#F2F4F6;--text-2:#C0C6CE;--focus:#D3DCE8;
  --safe:#A9CEBC;--safe-bg:#182B24;--warning:#E1C38C;--warning-bg:#30281A;--danger:#E4ADB3;--danger-bg:#321F25;--info:#B2C8E0;--info-bg:#1D2938;
  position:fixed;inset:0;z-index:2147483647;overflow:auto;background:var(--bg-0);color:var(--text-2);padding:32px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;text-align:left}
#basalt-attack *{box-sizing:border-box;margin:0}
#basalt-attack h1,#basalt-attack p,#basalt-attack div{max-width:none}
#basalt-attack .inner{max-width:1120px;margin:0 auto;display:grid;gap:24px}
#basalt-attack .head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:start}
#basalt-attack .brand{display:inline-flex;align-items:center;gap:8px;color:var(--text);font-weight:600;margin-bottom:12px}
#basalt-attack .brand .mark{width:28px;height:28px}
#basalt-attack h1{color:var(--text);font-size:40px;line-height:48px;font-weight:600;letter-spacing:-.02em}
#basalt-attack .intro{font-size:20px;line-height:28px;margin-top:8px}
#basalt-attack .summary{display:flex;align-items:center;gap:12px;color:var(--text);font-size:32px;line-height:40px;font-weight:600;letter-spacing:-.02em}
#basalt-attack .summary svg{width:32px;height:32px}
#basalt-attack .close{min-height:44px;padding:8px 16px;border:1px solid var(--edge);border-radius:8px;background:var(--bg-1);color:var(--text);font:inherit;font-weight:600;cursor:pointer}
#basalt-attack .close:hover{background:var(--bg-2)}
#basalt-attack .close:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
#basalt-attack .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 32px}
#basalt-attack .row{display:grid;grid-template-columns:168px minmax(0,1fr);gap:16px;align-items:start;padding:14px 0;border-top:1px solid var(--border)}
#basalt-attack .badge{display:inline-flex;align-items:center;gap:8px;justify-self:start;padding:4px 10px;border:1px solid var(--tone);border-radius:4px;background:var(--tone-bg);color:var(--tone);font-size:18px;line-height:28px;font-weight:600;letter-spacing:.02em;white-space:nowrap}
#basalt-attack svg{width:24px;height:24px;flex:none;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
#basalt-attack .t{color:var(--text);font-size:20px;line-height:28px;font-weight:600}
#basalt-attack .d{font-size:16px;line-height:24px;margin-top:2px;overflow-wrap:anywhere}
#basalt-attack .safe{--tone:var(--safe);--tone-bg:var(--safe-bg)}#basalt-attack .danger{--tone:var(--danger);--tone-bg:var(--danger-bg)}
#basalt-attack .warning{--tone:var(--warning);--tone-bg:var(--warning-bg)}#basalt-attack .info{--tone:var(--info);--tone-bg:var(--info-bg)}
@media (min-height:900px) and (min-width:1024px){#basalt-attack .t{font-size:24px;line-height:32px}#basalt-attack .d{font-size:20px;line-height:28px}
  #basalt-attack .row{min-height:104px;padding:16px 0;gap:24px}}
@media (max-height:820px) and (min-width:1024px){#basalt-attack{padding:20px 32px}#basalt-attack .inner{gap:14px}#basalt-attack .brand{margin-bottom:4px}
  #basalt-attack h1{font-size:32px;line-height:40px}#basalt-attack .intro{font-size:18px;line-height:26px;margin-top:4px}
  #basalt-attack .summary{font-size:28px;line-height:36px}#basalt-attack .row{grid-template-columns:152px minmax(0,1fr);padding:9px 0}}
@media (max-width:1023px){#basalt-attack .grid{grid-template-columns:minmax(0,1fr)}}
@media (max-width:767px){#basalt-attack{padding:16px}#basalt-attack h1{font-size:32px;line-height:40px}#basalt-attack .row{grid-template-columns:minmax(0,1fr);gap:8px}}`;

  function panel(title, rows, footer, good) {
    document.getElementById('basalt-attack')?.remove();
    const el = document.createElement('div');
    el.id = 'basalt-attack';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'basalt-attack-title');
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const label = (r) => (r.pass ? r.badge || 'REFUSED' : r.pass === null ? "CAN'T TELL" : r.badge ? 'BROKEN' : 'LEAKED');
    const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;
    el.innerHTML = `<style>${STAGE_CSS}</style>
      <div class="inner">
        <div class="head">
          <div><div class="brand"><svg class="mark" viewBox="0 0 64 64" aria-hidden="true" style="fill:none;stroke:none"><polygon points="12,14 24,6 40,6 52,14 52,50 40,58 24,58 12,50" fill="#7D8996"/><polygon points="12,14 24,6 40,6 52,14 40,22 24,22" fill="#E3E6EA"/><polygon points="12,14 24,22 24,58 12,50" fill="#E3E6EA"/></svg>Basalt</div>
            <h1 id="basalt-attack-title">${esc(title)}</h1>
            <p class="intro">Run from this page with customer B's real login, through the same door the app's own code uses.</p></div>
          <button class="close" type="button">Close</button>
        </div>
        <div class="summary ${good ? 'safe' : 'danger'}"><span style="color:var(--tone)">${svg(good ? 'REFUSED' : 'LEAKED')}</span>${esc(footer)}</div>
        <div class="grid">${rows.map((r) => {
          const l = label(r);
          return `<div class="row"><span class="badge ${TONE[l]}">${svg(l)}${esc(l)}</span><div><div class="t">${esc(r.title)}</div><p class="d">${esc(r.detail)}</p></div></div>`;
        }).join('')}</div>
      </div>`;
    const close = el.querySelector('.close');
    close.onclick = () => el.remove();
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') el.remove(); });
    document.body.appendChild(el);
    close.focus();
  }

  window.basaltAttack = async function basaltAttack(targetId, targetOwner, table = 'bookings') {
    if (!targetId) {
      // Step 1, as customer A.
      const mine = await data('list', { table });
      const row = mine.ok && mine.data.rows[0];
      if (!row) return console.log(`%cNo ${table} for this login yet. Book something first, then run basaltAttack() again.`, 'font-size:16px');
      const cmd = `basaltAttack('${row.id}', '${row.owner_id}', '${table}')`;
      try { await navigator.clipboard.writeText(cmd); } catch { /* copy it by hand below */ }
      console.log(`%cCustomer A's entry: ${row.id}\nNow, signed in as customer B, paste attack.js and then:\n\n${cmd}\n\n(copied to the clipboard)`, 'font-size:16px');
      return cmd;
    }

    const rows = [];
    const add = (title, pass, detail, badge) => rows.push({ title, pass, detail, badge });
    // REFUSED only for the specific "no" each attack should get. Anything else (a validation
    // error, an outage, a busy signal) can't prove the data is safe, so it shows CAN'T TELL.
    const verdict = (r, codes, status) => (r.ok ? false : r.status === status && (!codes || codes.includes(r.error && r.error.code)) ? true : null);
    const why = (r, leakText) => (r.ok ? leakText : r.status === 0 || r.status >= 500 || r.status === 429 ? `Couldn't tell (status ${r.status}).` : `Basalt said${said(r)}`);

    // Every page of a list, so nothing hides on page two.
    async function all(body) {
      let out = [];
      let after;
      for (let page = 0; page < 50; page++) {
        // Small pages: every read counts against the customer's per-minute limit, and the demo may run twice in a row.
        const r = await data('list', { ...body, limit: 20, ...(after ? { after } : {}) });
        if (!r.ok) return { r, rows: null };
        out = out.concat(r.data.rows);
        if (!r.data.next) return { r, rows: out, complete: true };
        after = r.data.next;
      }
      return { rows: out, complete: false };
    }

    const first = await all({ table });
    if (!first.rows) return console.log(`%cSign in as customer B first (Basalt said${said(first.r)}).`, 'font-size:16px');
    const template = first.rows.find((r) => r.owner_id !== targetOwner);
    if (!template) return console.log(`%cBook something as this customer first (and make sure it isn't customer A's login).`, 'font-size:16px');
    // Who B really is, from a throwaway test entry B saves now (far in the future, archived at the end).
    const probe = await saveCopy(table, template);
    if (!probe.ok) return console.log(`%cCouldn't save a test entry to start (Basalt said${said(probe)}).`, 'font-size:16px');
    const me = probe.data.owner_id;
    if (me === targetOwner) {
      await data('archive', { table, id: probe.data.id });
      return console.log("%cThis is customer A's own login. Sign in as a different customer.", 'font-size:16px');
    }
    const field = Object.keys(copyOf(probe.data)).find((k) => typeof probe.data[k] === 'string');

    // 1. List everything: anything not B's is a leak, whoever it belongs to.
    const listed = await all({ table });
    const foreign = (listed.rows || []).filter((r) => r.owner_id !== me);
    add('List every booking in the app', !listed.rows ? null : foreign.length ? false : listed.complete ? true : null,
      !listed.rows ? why(listed.r) : foreign.length ? `${foreign.length} booking${foreign.length === 1 ? '' : 's'} from other customers came back.`
        : listed.complete ? `Basalt sent back only this customer's own ${listed.rows.length - 1}, plus the test entry. Nobody else's shows up.` : `Only this customer's in the first 1,000, but there were more to check.`);

    // 2. Open A's entry by its id.
    const get = await data('get', { table, id: targetId });
    add("Open customer A's booking by its id", verdict(get, ['not_found'], 404), why(get, "It opened customer A's booking."));
    const original = get.ok ? get.data : null;

    // 3. Change it, with a value the rules accept (B's own), so a refusal is about whose it is.
    if (field) {
      const upd = await data('update', { table, id: targetId, input: { [field]: probe.data[field] } });
      add("Change customer A's booking", verdict(upd, ['not_found'], 404), why(upd, "The change went through. (Put back.)"));
      if (upd.ok && original) await data('update', { table, id: targetId, input: { [field]: original[field] } });
    }

    // 4. Cancel it.
    const arc = await data('archive', { table, id: targetId });
    add("Cancel customer A's booking", verdict(arc, ['not_found'], 404), why(arc, 'It was cancelled. (Brought back.)'));
    if (arc.ok) await data('restore', { table, id: targetId });

    // 5. Delete, or run database code directly. Neither door exists (a harmless read is used).
    const del = await data('delete', { table, id: targetId });
    const sql = await call('/v1/sql', { query: `select * from ${table}` });
    const noDoor = verdict(del, null, 404) && verdict(sql, null, 404);
    add('Delete a booking, or run raw database code', del.ok || sql.ok ? false : noDoor ? true : null,
      del.ok || sql.ok ? 'One of them worked.' : noDoor ? 'There is no delete and no raw database access.' : `Couldn't tell (${del.status}, ${sql.status}).`);

    // 6. Save an entry in A's name.
    if (targetOwner) {
      const fake = await saveCopy(table, template, { owner_id: targetOwner });
      if (fake.ok && fake.data.id) await data('archive', { table, id: fake.data.id });
      const faked = fake.ok && fake.data.owner_id !== me;
      add("Book in customer A's name", faked ? false : fake.ok ? true : verdict(fake, ['invalid_input'], 400),
        faked ? 'The entry says someone else made it.' : fake.ok ? 'Basalt ignored the name and recorded customer B.' : why(fake));
    }

    // 7. A search that tries to sneak in database code. It has to actually run to prove anything,
    // so each text field is tried until one isn't turned away for its format (like a phone).
    let inj = null;
    for (const k of Object.keys(copyOf(probe.data)).filter((k) => typeof probe.data[k] === 'string' && !/^\d{4}-\d\d-\d\dT/.test(probe.data[k]))) {
      inj = await all({ table, where: { [k]: "x' or '1'='1" } });
      if (inj.rows) break;
    }
    if (inj) {
      const leaked = (inj.rows || []).filter((r) => r.owner_id !== me);
      add('A search that sneaks in database code', leaked.length ? false : inj.rows ? true : null,
        leaked.length ? `It returned ${leaked.length} booking${leaked.length === 1 ? '' : 's'} from other customers.` : inj.rows ? 'Treated as plain text. Nothing leaked.' : why(inj.r));
    }

    // 8. The database's own tables.
    const sys = await data('list', { table: 'pg_authid' });
    add("Read the database's password table", verdict(sys, ['invalid_input'], 400), why(sys, 'It answered.'));

    // 9. A forged login for customer A.
    if (targetOwner) {
      const forged = await data('get', { table, id: targetId }, { authorization: `Bearer ${forgedLogin(targetOwner)}` });
      add('A forged login that claims to be customer A', verdict(forged, ['denied'], 401),
        forged.ok ? 'The forged login worked.' : forged.status === 401 ? 'The database checked the signature itself and refused it.' : why(forged));
    }

    // The door still works for the real owner of an entry, then the test entry is tidied away.
    const back = await data('get', { table, id: probe.data.id });
    add('Customer B opens their own booking', back.ok, back.ok ? 'Works as normal.' : `Unexpected${said(back)}`, 'WORKS');
    await data('archive', { table, id: probe.data.id });

    const bad = rows.filter((r) => r.pass === false).length;
    const unsure = rows.filter((r) => r.pass === null).length;
    const attacks = rows.filter((r) => r.badge !== 'WORKS');
    panel('Attacking this app from inside its own page', rows,
      bad ? `${bad} problem${bad === 1 ? '' : 's'} found.` : unsure ? `${unsure} check${unsure === 1 ? '' : 's'} couldn't tell. Run it again.` : `${attacks.length} of ${attacks.length} attacks refused by Basalt.`, !bad && !unsure);
    console.table(rows.map((r) => ({ attack: r.title, result: r.pass ? r.badge || 'REFUSED' : r.pass === null ? "can't tell" : r.badge ? 'BROKEN' : 'LEAKED', detail: r.detail })));
    return rows;
  };
  console.log('%cBasalt attack demo loaded. Run basaltAttack() as customer A, or the copied command as customer B.', 'font-size:16px');
})();
