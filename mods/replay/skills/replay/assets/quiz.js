// Replay quiz: reads the answers on the page and hands them to the tarcsweb viewer, or to the clipboard
// outside it (a browser tab). The page never holds the key; the agent grades against quiz.json.
(() => {
  const root = document.querySelector('.quiz');
  if (!root) return;
  const qs = [...root.querySelectorAll('.q[data-id]')];
  // Letter badges are decoration; the label text sent leaves them out.
  const words = (el) => (el ? [...el.childNodes].filter((n) => !(n.nodeType === 1 && n.matches('.ol'))).map((n) => n.textContent).join('') : '').replace(/\s+/g, ' ').trim();

  for (const q of qs) {
    const legend = q.querySelector('legend');
    if (legend && !legend.id) legend.id = `quiz-${q.dataset.id}-l`;
    for (const r of q.querySelectorAll('input[type=radio]')) {
      r.name ||= q.dataset.id;
      if (!r.parentElement.querySelector('.ol')) r.insertAdjacentHTML('afterend', `<span class="ol" aria-hidden="true">${r.value.toUpperCase()}</span>`);
    }
    const ta = q.querySelector('textarea');
    if (ta && legend && !ta.labels?.length) ta.setAttribute('aria-labelledby', legend.id);
  }

  // A terminal page is a still picture: no buttons, the user answers in the chat.
  if (root.hasAttribute('data-still')) return;
  const embedded = parent !== window;
  let bar = root.querySelector('.quiz-bar');
  if (!bar) root.append((bar = document.createElement('div')));
  bar.className = 'quiz-bar';
  bar.innerHTML = (embedded ? '<button type="button" class="qbtn go" data-act="send">Send answers to the chat</button>' : '')
    + '<button type="button" class="qbtn" data-act="copy">Copy answers</button><span class="quiz-status" role="status"></span>';
  const status = bar.querySelector('.quiz-status');
  const sendBtn = bar.querySelector('[data-act=send]');
  const say = (text, kind = '') => {
    status.textContent = text;
    status.className = `quiz-status${kind ? ` ${kind}` : ''}`;
  };

  const collect = () => qs.map((q) => {
    const ta = q.querySelector('textarea');
    if (ta) return { id: q.dataset.id, kind: 'open', answer: ta.value.trim() };
    const r = q.querySelector('input[type=radio]:checked');
    return { id: q.dataset.id, kind: 'choice', answer: r ? r.value : '', label: r ? words(r.closest('label')) : '' };
  });
  // Same shape the viewer writes, so the agent grades a copied answer the same way.
  const asText = (answers) => {
    const lines = answers.map((a) => {
      if (a.kind === 'open') return a.answer ? `- ${a.id} (open):\n${a.answer.split('\n').map((l) => `  > ${l}`).join('\n')}` : `- ${a.id} (open): no answer`;
      return a.answer ? `- ${a.id}: ${a.answer}${a.label ? ` · page text "${a.label.replace(/"/g, "'")}"` : ''}` : `- ${a.id}: no answer`;
    });
    const key = root.dataset.key;
    return `Quiz answers. ${key ? `Grade them with the key in ${key}` : 'Grade them with the quiz.json beside this replay'}:\n${lines.join('\n')}\n`;
  };
  const blanks = (answers) => {
    const missing = answers.filter((a) => !a.answer);
    qs.forEach((q, i) => (answers[i].answer ? q.removeAttribute('data-missing') : q.setAttribute('data-missing', '')));
    return missing.length ? ` ${missing.length} unanswered.` : '';
  };

  // Send stays off while a send is pending and after it lands, until an answer changes.
  let wait = 0;
  let note = '';
  let pending = '';
  let sent = '';
  const sync = () => {
    if (sendBtn) sendBtn.disabled = !!pending || JSON.stringify(collect()) === sent;
  };
  addEventListener('message', (e) => {
    if (e.source !== parent || !e.data) return;
    if (e.data.replayQuizDraft && typeof e.data.replayQuizDraft === 'object') {
      for (const q of qs) {
        const v = e.data.replayQuizDraft[q.dataset.id];
        if (typeof v !== 'string') continue;
        const ta = q.querySelector('textarea');
        if (ta) ta.value = v;
        else for (const r of q.querySelectorAll('input[type=radio]')) r.checked = r.value === v;
      }
      return sync();
    }
    if (!e.data.replayQuiz || !pending) return;
    clearTimeout(wait);
    if (e.data.replayQuiz === 'sent') {
      sent = pending;
      say(`Answers are in the chat box. Close the replay and send the message for grading.${note}`, 'ok');
    } else if (e.data.replayQuiz === 'refused') say('The viewer did not accept the answers. Click Send again.', 'bad');
    else say('Could not find the chat box. Use Copy answers.', 'bad');
    pending = '';
    sync();
  });

  // The viewer keeps a draft per page, posted on every edit (no debounce), so paging away never loses the last keystroke.
  const onEdit = () => {
    sync();
    if (embedded) parent.postMessage({ replay: 1, quizDraft: Object.fromEntries(collect().map((a) => [a.id, a.answer])) }, '*');
  };
  root.addEventListener('input', onEdit);
  root.addEventListener('change', onEdit);

  // A tab without clipboard access still gets the text, selected for Ctrl+C.
  const showText = (text) => {
    let pre = root.querySelector('.quiz-copy');
    if (!pre) root.append((pre = Object.assign(document.createElement('pre'), { className: 'quiz-copy' })));
    pre.textContent = text;
    getSelection().selectAllChildren(pre);
  };
  const legacyCopy = (text) => {
    const t = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(t);
    t.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    t.remove();
    return ok;
  };

  bar.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const answers = collect();
    note = blanks(answers);
    if (act === 'send') {
      if (pending) return;
      pending = JSON.stringify(answers);
      sync();
      parent.postMessage({ replay: 1, quiz: { answers } }, '*');
      say(`Sending…${note}`);
      // An older viewer ignores the message; say so instead of waiting forever.
      wait = setTimeout(() => {
        pending = '';
        sync();
        say('The viewer did not answer. Use Copy answers.', 'bad');
      }, 1500);
      return;
    }
    // Copy takes over the status line, so a send still waiting must not overwrite it.
    clearTimeout(wait);
    pending = '';
    sync();
    const text = asText(answers);
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = legacyCopy(text);
    }
    if (ok) say(`Copied. Paste it in the chat for grading.${note}`, 'ok');
    else {
      showText(text);
      say('Could not copy. The text is selected below: use Ctrl+C.', 'bad');
    }
  });
})();
