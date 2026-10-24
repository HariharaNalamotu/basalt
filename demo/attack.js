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
            <span style="flex:none;min-width:132px;text-align:center;font-weight:800;letter-spacing:.04em;padding:6px 10px;border-radius:8px;${r.pass ? 'background:#0f5323;color:#7ee787' : r.pass === null ? 'background:#3d2e00;color:#e3b341' : 'background:#67060c;color:#ffa198'}">${r.pass ? esc(r.badge || 'REFUSED') : r.pass === null ? "CAN'T TELL" : 'LEAKED'}</span>
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
    const mine = await data('list', { table });
    if (!mine.ok) return console.log(`%cSign in as customer B first (Basalt said${said(mine)}).`, 'font-size:16px');
    const listed = mine.data.rows;
    if (listed.length > 0 && listed.every((r) => r.owner_id === targetOwner)) return console.log('%cThis is customer A\'s own login. Sign in as a different customer.', 'font-size:16px');
    // Judged by owner, so a leak shows as a leak instead of looking like A's own login.
    const own = listed.filter((r) => r.owner_id !== targetOwner);
    const leakedRows = listed.filter((r) => r.owner_id === targetOwner || r.id === targetId);

    // 1. List everything.
    add('List every booking in the app', leakedRows.length === 0,
      leakedRows.length ? `Customer A's bookings came back in customer B's list (${leakedRows.length}).` : `Basalt sent back only this customer's own ${own.length}. Customer A's never shows up.`);

    // 2. Open A's entry by its id.
    const get = await data('get', { table, id: targetId });
    add("Open customer A's booking by its id", refused(get) && !get.ok, get.ok ? 'It opened.' : `Basalt said${said(get)}`);

    // 3. Change it.
    const field = own[0] && Object.keys(copyOf(own[0])).find((k) => typeof own[0][k] === 'string');
    if (field) {
      const upd = await data('update', { table, id: targetId, input: { [field]: own[0][field] } });
      add("Change customer A's booking", refused(upd), upd.ok ? 'The change went through.' : `Basalt said${said(upd)}`);
    } else {
      add("Change customer A's booking", null, "Book something as this customer first, so there's a valid change to try.");
    }

    // 4. Cancel it.
    const arc = await data('archive', { table, id: targetId });
    add("Cancel customer A's booking", refused(arc), arc.ok ? 'It was cancelled.' : `Basalt said${said(arc)}`);

    // 5. Delete everything. Basalt has no delete at all.
    const del = await data('delete', { table, id: targetId });
    const sql = await call('/v1/sql', { query: `delete from ${table}` });
    add('Delete bookings, or run raw database code', refused(del) && refused(sql),
      del.ok || sql.ok ? 'Something was deleted.' : `There is no delete and no raw database access (${del.status}, ${sql.status}).`);

    // 6. Save an entry in A's name.
    if (own[0] && targetOwner) {
      const fake = await data('create', { table, input: { ...copyOf(own[0]), owner_id: targetOwner } });
      if (fake.ok && fake.data.id) await data('archive', { table, id: fake.data.id });
      add("Book in customer A's name", !(fake.ok && fake.data.owner_id === targetOwner),
        fake.ok ? (fake.data.owner_id === targetOwner ? "The entry says customer A made it." : 'Basalt ignored the name and recorded customer B.') : `Basalt said${said(fake)}`);
    }

    // 7. A search that tries to sneak in database code.
    if (field) {
      const inj = await data('list', { table, where: { [field]: "x' or '1'='1" } });
      const leaked = inj.ok && inj.data.rows.some((r) => r.id === targetId);
      add('A search that sneaks in database code', !leaked && (inj.ok || refused(inj)),
        leaked ? "It returned customer A's booking." : 'Treated as plain text. Nothing leaked.');
    }

    // 8. The database's own tables.
    const sys = await data('list', { table: 'pg_authid' });
    add("Read the database's password table", refused(sys), sys.ok ? 'It answered.' : `Basalt said${said(sys)}`);

    // 9. A forged login for customer A.
    if (targetOwner) {
      const forged = await data('get', { table, id: targetId }, { authorization: `Bearer ${forgedLogin(targetOwner)}` });
      add('A forged login that claims to be customer A', refused(forged), forged.ok ? 'The forged login worked.' : `The database checked the signature itself and said${said(forged)}`);
    }

    // The door still works for the real owner of an entry.
    const back = own[0] ? await data('get', { table, id: own[0].id }) : null;
    if (back) add("Customer B opens their own booking", back.ok, back.ok ? 'Works as normal.' : `Unexpected:${said(back)}`, 'WORKS');

    const bad = rows.filter((r) => r.pass === false && r.badge !== 'WORKS').length + (back && !back.ok ? 1 : 0);
    const attacks = rows.filter((r) => r.badge !== 'WORKS');
    panel('Attacking this app from inside its own page', rows,
      bad === 0 ? `${attacks.filter((r) => r.pass).length} of ${attacks.length} attacks refused by the database.` : `${bad} problem${bad === 1 ? '' : 's'} found.`, bad === 0);
    console.table(rows.map((r) => ({ attack: r.title, result: r.pass ? r.badge || 'REFUSED' : r.pass === null ? "can't tell" : 'LEAKED', detail: r.detail })));
    return rows;
  };
  console.log('%cBasalt attack demo loaded. Run basaltAttack() as customer A, or the copied command as customer B.', 'font-size:16px');
})();
