(() => {
  const form = document.getElementById('contactForm');
  const banner = document.getElementById('statusBanner');
  const btn = document.getElementById('submitBtn');
  const msgEl = document.getElementById('message');
  const countEl = document.getElementById('charCount');
  const topicEl = document.getElementById('topic');

  function showBanner(kind, text) {
    banner.className = `banner show ${kind}`;
    banner.textContent = text;
    banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Handle non-JS redirect params (?sent=1&id=... or ?err=...) and ?topic=...
  const qs = new URLSearchParams(window.location.search);
  const preTopic = qs.get('topic');
  if (preTopic && topicEl && [...topicEl.options].some((o) => o.value === preTopic)) {
    topicEl.value = preTopic;
  }
  if (qs.get('sent') === '1') {
    const id = qs.get('id');
    showBanner('ok', id
      ? `Message sent to the PCoin team (reference ${id}). We will follow up via the contact you provided.`
      : 'Message sent to the PCoin team.');
  } else if (qs.get('err')) {
    showBanner('err', qs.get('err'));
  }

  if (msgEl && countEl) {
    const updateCount = () => {
      countEl.textContent = `${msgEl.value.length} / 3000`;
    };
    msgEl.addEventListener('input', updateCount);
    updateCount();
  }

  if (!form) return;

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    banner.className = 'banner';

    const payload = {
      topic: form.topic.value,
      name: form.name.value.trim(),
      reply_to: form.reply_to.value.trim(),
      message: form.message.value.trim(),
      website: form.website.value,
    };

    if (!payload.name) {
      showBanner('err', 'Please enter your name or handle.');
      form.name.focus();
      return;
    }
    if (payload.reply_to.length < 2) {
      showBanner('err', 'Please enter an email address or Telegram/Discord handle so we can reply.');
      form.reply_to.focus();
      return;
    }
    if (payload.message.length < 10) {
      showBanner('err', 'Please enter a message of at least 10 characters.');
      form.message.focus();
      return;
    }

    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = 'Sending...';
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Requested-With': 'fetch',
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        form.reset();
        if (countEl) countEl.textContent = '0 / 3000';
        showBanner('ok', data.id && data.id !== 'ok'
          ? `Message sent to the PCoin team (reference ${data.id}). We will follow up via the contact you provided.`
          : 'Message sent to the PCoin team.');
      } else {
        showBanner('err', data.error || 'Could not send message. Please try again or email pcoin@pc.am.');
      }
    } catch {
      showBanner('err', 'Network error while sending. Please try again or email pcoin@pc.am.');
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  });
})();
