// A CONFIRMATION DIALOG IN THE PAGE, not the browser's.
//
// Owner, 2026-09-25: "there is a prompt alert in the browser before sending --
// change it to a nice HTML confirmation modal, we should not use any alert or
// prompt JS". The browser's confirm() box is unstyled, cannot say which request
// or how much in a way that stands out, and on some browsers offers "prevent this
// page from creating more dialogs" -- after which every money button on the page
// silently does nothing.
//
// USE: put data-confirm="the question" on a <form>. Optional:
//   data-confirm-ok="Send 237.50 wPCN"   the confirm button's label
//   data-danger                          a red confirm button, for money leaving
// The form's own validation runs first (the submit event only fires once it
// passes). Confirming disables every button in the form before submitting, so a
// double click cannot post twice. Escape, Cancel or a click outside closes it
// and nothing is sent. Without JavaScript the form still submits -- the servers
// behind these buttons are idempotent, so the dialog is a guard, not the lock.
//
// The text goes in with textContent, never innerHTML, so a message built from
// an address or an email cannot inject markup.

export const CONFIRM_CSS = `
.xconfirm-back{position:fixed;inset:0;background:rgba(5,8,16,.62);display:flex;align-items:center;
justify-content:center;z-index:9999;padding:16px}
.xconfirm{background:var(--panel,#151c2c);color:var(--text,#e6e9ef);border:1px solid var(--border,#2a3346);
border-radius:14px;max-width:480px;width:100%;padding:22px 24px;box-shadow:0 24px 70px rgba(0,0,0,.55)}
.xconfirm h3{margin:0 0 10px;font-size:17px}
.xconfirm-msg{margin:0 0 20px;white-space:pre-line;line-height:1.55;font-size:15px;word-break:break-word}
.xconfirm-btns{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap}
.xconfirm-btns button{border-radius:999px;padding:9px 20px;font-weight:700;cursor:pointer;font-size:14px;
border:1px solid var(--border,#2a3346);background:transparent;color:inherit}
.xconfirm-btns .xconfirm-ok{background:var(--blue,#60a5fa);color:#0b1220;border-color:transparent}
.xconfirm-btns .xconfirm-ok.danger{background:var(--red,#ef4444);color:#fff}
.xconfirm-btns button:disabled{opacity:.6;cursor:default}
`;

export const CONFIRM_JS = `
(function () {
  function open(msg, okText, danger, onOk) {
    var back = document.createElement('div');
    back.className = 'xconfirm-back';
    back.innerHTML = '<div class="xconfirm" role="dialog" aria-modal="true"><h3>Please confirm</h3>'
      + '<p class="xconfirm-msg"></p><div class="xconfirm-btns">'
      + '<button type="button" class="xconfirm-cancel">Cancel</button>'
      + '<button type="button" class="xconfirm-ok"></button></div></div>';
    back.querySelector('.xconfirm-msg').textContent = msg;
    var ok = back.querySelector('.xconfirm-ok');
    ok.textContent = okText || 'Confirm';
    if (danger) ok.classList.add('danger');
    function close() { document.removeEventListener('keydown', key, true); back.remove(); }
    function key(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    back.querySelector('.xconfirm-cancel').onclick = close;
    ok.onclick = function () { ok.disabled = true; close(); onOk(); };
    document.addEventListener('keydown', key, true);
    document.body.appendChild(back);
    ok.focus();
  }
  // Exposed for code that confirms without a form (a fetch-driven button).
  window.pcoinConfirm = function (msg, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var done = false;
      open(msg, opts.ok, !!opts.danger, function () { done = true; resolve(true); });
      var obs = new MutationObserver(function () {
        if (!document.querySelector('.xconfirm-back')) { obs.disconnect(); if (!done) resolve(false); }
      });
      obs.observe(document.body, { childList: true });
    });
  };
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || !f.getAttribute) return;
    var msg = f.getAttribute('data-confirm');
    if (!msg || f.getAttribute('data-confirmed') === '1') return;
    e.preventDefault();
    open(msg, f.getAttribute('data-confirm-ok'), f.hasAttribute('data-danger'), function () {
      f.setAttribute('data-confirmed', '1');
      Array.prototype.forEach.call(f.querySelectorAll('button,input[type=submit]'), function (x) { x.disabled = true; });
      HTMLFormElement.prototype.submit.call(f);
    });
  }, true);
})();
`;
