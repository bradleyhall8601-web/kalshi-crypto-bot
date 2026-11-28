// Safe start (11/27 investigation): if Telegram can't be read at boot, the bot must not run on code defaults or overwrite the saved settings.
process.env.BOT_TEST = '1';
const { W, start } = require('./harness');
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x = '') => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, x); } };
const msgs = () => W.tg.filter(x => x.method === 'sendMessage' && !String(x.body.text).startsWith('⚙️ BOT SETTINGS')).map(x => x.body.text);
const saved = '⚙️ BOT SETTINGS (do not unpin)\n' + JSON.stringify({ v: 24, SERIES: ['KXBTCD'], SETL: Date.now(), PAPER: 1, LATE_MIN: 0.8, LATE_LIVE: 1 });
W.pinned = saved; W.chatFail = 8; // Telegram answers 500 for the first 8 getChat calls (3 tries each)
(async () => {
  console.log('\nSafe start');
  const { post } = start({}); await wait(1500);
  ok(W.pinned === saved && !(W.settingsSends > 0), 'settings unreadable at boot: the saved settings are not overwritten');
  await post({ message: { chat: { id: 42 }, text: '/set trade 3' } }); await wait(400);
  ok(W.pinned === saved && msgs().some(m => /haven't loaded yet/.test(m)), '…and a /set waits (it would be lost) instead of applying to defaults');
  await wait(4000);
  ok(msgs().some(m => /Couldn't load my saved settings/.test(m)), 'Brad is told real bets are held until the settings load', msgs().join(' | ').slice(0, 300));
  ok(msgs().some(m => /Saved settings loaded — real bets back on/.test(m)), 'it retries and loads them once Telegram answers', msgs().join(' | ').slice(0, 400));
  await post({ message: { chat: { id: 42 }, text: '/settings' } }); await wait(600);
  const st = msgs().slice(-1)[0] || '';
  ok(/paper[^\n]*1/i.test(st) || /PAPER/.test(W.pinned), 'loaded values are in use (paper practice stays on)', st.slice(0, 200));
  ok(/"OWNER":\{"id":"[0-9a-f]{8}"/.test(W.pinned) || /\nZ:/.test(W.pinned), 'after loading, this copy marks itself as the active one');
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
