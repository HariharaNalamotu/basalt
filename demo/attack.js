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
  // clash with a real booking.
  function copyOf(row) {
    const input = {};
    for (const [k, v] of Object.entries(row)) {
      if (SYSTEM.includes(k) || v === null) continue;
      input[k] = typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)
        ? new Date(Date.UTC(2099, 0, 1) + Math.floor(Math.random() * 5e5) * 60000).toISOString()
        : v;
    }
    return input;
  }

  function panel(title, rows, footer, good) {
    document.getElementById('basalt-attack')?.remove();
    const el = document.createElement('div');
    el.id = 'basalt-attack';
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0d1117;color:#e6edf3;font:18px/1.4 system-ui,sans-serif;overflow:auto;padding:28px 32px';
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    el.innerHTML = `
      <button style="position:fixed;top:16px;right:20px;font:inherit;padding:6px 14px;border-radius:8px;border:1px solid #30363d;background:#161b22;color:#e6edf3;cursor:pointer">Close</button>
      <div style="max-width:960px;margin:0 auto">
        <div style="font-size:28px;font-weight:700;margin-bottom:4px;padding-right:90px">${esc(title)}</div>
        <div style="color:#8b949e;margin-bottom:14px">Run from this page with customer B's real login, through the same door the app's own code uses.</div>
        <div style="font-size:24px;font-weight:800;margin-bottom:14px;color:${good ? '#7ee787' : '#ffa198'}">${esc(footer)}</div>
        ${rows.map((r) => `
          <div style="display:flex;gap:16px;align-items:center;padding:8px 0;border-top:1px solid #21262d">
            <span style="flex:none;min-width:132px;text-align:center;font-weight:800;letter-spacing:.04em;padding:6px 10px;border-radius:8px;${r.pass ? 'background:#0f5323;color:#7ee787' : r.pass === null ? 'background:#3d2e00;color:#e3b341' : 'background:#67060c;color:#ffa198'}">${r.pass ? esc(r.badge || 'REFUSED') : r.pass === null ? "CAN'T TELL" : r.badge ? 'BROKEN' : 'LEAKED'}</span>
            <span style="flex:1"><b>${esc(r.title)}</b><br><span style="color:#8b949e;font-size:15px">${esc(r.detail)}</span></span>
          </div>`).join('')}
      </div>`;
    el.querySelector('button').onclick = () => el.remove();
    document.body.appendChild(el);
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
      for (let page = 0; page < 20; page++) {
        const r = await data('list', { ...body, limit: 100, ...(after ? { after } : {}) });
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
    const probe = await data('create', { table, input: copyOf(template) });
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
        : listed.complete ? `Basalt sent back only this customer's own ${listed.rows.length - 1}, plus the test entry. Nobody else's shows up.` : `Only this customer's in the first 2,000, but there were more to check.`);

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
      del.ok || sql.ok ? 'One of them worked.' : noDoor ? 'There is no delete and no raw database access (404, 404).' : `Couldn't tell (${del.status}, ${sql.status}).`);

    // 6. Save an entry in A's name.
    if (targetOwner) {
      const fake = await data('create', { table, input: { ...copyOf(template), owner_id: targetOwner } });
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
        forged.ok ? 'The forged login worked.' : forged.status === 401 ? `The database checked the signature itself and said${said(forged)}` : why(forged));
    }

    // The door still works for the real owner of an entry, then the test entry is tidied away.
    const back = await data('get', { table, id: probe.data.id });
    add('Customer B opens their own booking', back.ok, back.ok ? 'Works as normal.' : `Unexpected:${said(back)}`, 'WORKS');
    await data('archive', { table, id: probe.data.id });

    const bad = rows.filter((r) => r.pass === false).length;
    const unsure = rows.filter((r) => r.pass === null).length;
    const attacks = rows.filter((r) => r.badge !== 'WORKS');
    panel('Attacking this app from inside its own page', rows,
      bad ? `${bad} problem${bad === 1 ? '' : 's'} found.` : unsure ? `${unsure} check${unsure === 1 ? '' : 's'} couldn't tell. Run it again.` : `${attacks.length} of ${attacks.length} attacks refused by the database.`, !bad && !unsure);
    console.table(rows.map((r) => ({ attack: r.title, result: r.pass ? r.badge || 'REFUSED' : r.pass === null ? "can't tell" : r.badge ? 'BROKEN' : 'LEAKED', detail: r.detail })));
    return rows;
  };
  console.log('%cBasalt attack demo loaded. Run basaltAttack() as customer A, or the copied command as customer B.', 'font-size:16px');
})();
