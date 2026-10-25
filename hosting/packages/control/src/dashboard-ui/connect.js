'use strict';
// Connect Claude: picks the visitor's OS, downloads a fresh connector file, shows where it goes.
(function () {
  const opts = window.BASALT_CONNECT || {};
  const $ = (s) => document.querySelector(s);
  const ua = navigator.userAgent;
  let os = /Windows/i.test(ua) ? 'windows' : /Mac/i.test(ua) ? 'mac' : /Linux|X11/i.test(ua) ? 'linux' : 'mac';

  const MOVE = {
    mac: 'mkdir -p ~/my-app && mv "$(ls -t ~/Downloads/*mcp*.json | head -1)" ~/my-app/.mcp.json',
    linux: 'mkdir -p ~/my-app && mv "$(ls -t ~/Downloads/*mcp*.json | head -1)" ~/my-app/.mcp.json',
    windows: 'New-Item -ItemType Directory -Force $HOME\\my-app | Out-Null; Move-Item -Force (Get-ChildItem $HOME\\Downloads\\*mcp*.json | Sort-Object LastWriteTime | Select-Object -Last 1).FullName $HOME\\my-app\\.mcp.json',
  };
  const MOVE_NOTE = {
    mac: 'Paste it into the Terminal app. Finder hides files that start with a dot; that is normal.',
    linux: 'Paste it into a terminal.',
    windows: 'Paste it into PowerShell (Start menu, type "PowerShell").',
  };
  const OPEN = { mac: 'cd ~/my-app && claude', linux: 'cd ~/my-app && claude', windows: 'cd $HOME\\my-app; claude' };
  const NOTE = {
    mac: 'For Claude Code on this Mac.',
    linux: 'For Claude Code on Linux (or inside WSL on Windows).',
    windows: opts.windowsLoopback ? 'For Claude Code on Windows itself (not inside WSL).' : 'For Claude Code on Windows itself. This Basalt has no loopback registry, so installs may fail; use WSL instead.',
  };

  function show() {
    document.querySelectorAll('[data-os]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.os === os)));
    $('#os-note').textContent = NOTE[os];
    $('#move-cmd').textContent = MOVE[os];
    $('#move-note').textContent = MOVE_NOTE[os];
    $('#open-cmd').textContent = OPEN[os];
  }

  let toastTimer;
  function toast(text, bad) {
    const t = $('#toast');
    t.textContent = text;
    t.className = `toast${bad ? ' bad' : ''}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  async function download() {
    const btn = $('#download');
    btn.disabled = true;
    try {
      const res = await fetch('/dashboard/api/connector', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-basalt-dashboard': '1' },
        body: JSON.stringify({ os }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Download failed (${res.status}).`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = '.mcp.json';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      const done = $('#done');
      done.textContent = 'Downloaded. It is in your Downloads folder. Next, move it into your app folder.';
      done.hidden = false;
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.os) {
      os = b.dataset.os;
      show();
    } else if (b.id === 'download') void download();
    else if (b.dataset.copy) {
      navigator.clipboard.writeText($(`#${b.dataset.copy}`).textContent).then(() => toast('Copied.'), () => toast('Couldn’t copy. Select the text and copy it yourself.', true));
    }
  });

  if (opts.hasDashboard) $('#to-dashboard').hidden = false;
  show();
})();
