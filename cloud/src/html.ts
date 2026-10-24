// Shared bits for Basalt Cloud's pages: escaping and the page shell.

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>
body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#1a1a1a;background:#fff}
h1{font-size:24px}h2{font-size:18px;margin:24px 0 4px}.card{border:1px solid #e3e3e3;border-radius:10px;padding:16px 20px;margin:16px 0}
li{margin:4px 0}.muted{color:#666;font-size:14px}.warn{background:#fff8e6;border-left:4px solid #e67700;padding:10px 14px;border-radius:6px}
button{font:inherit;padding:10px 20px;border-radius:8px;border:1px solid #1a1a1a;cursor:pointer;margin-right:8px}
.yes{background:#1a1a1a;color:#fff}.no{background:#fff}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}.card{border-color:#333}.muted{color:#aaa}.warn{background:#2a2110}button{border-color:#eee}.yes{background:#eee;color:#111}.no{background:#111;color:#eee}}
</style></head><body>${body}</body></html>`;
}
