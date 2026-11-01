// Small progressive enhancements. Every action also works without JavaScript.
(function () {
  'use strict';
  var tokenMeta = document.querySelector('meta[name="csrf-token"]');
  var csrf = tokenMeta ? tokenMeta.getAttribute('content') : '';

  // Board drag and drop. Dropping on Done opens the close form, so the
  // person closing it always records who did the work.
  var board = document.querySelector('[data-board]');
  if (board) {
    var dragging = null;
    board.addEventListener('dragstart', function (e) {
      var card = e.target.closest('[data-task-id]');
      if (!card) return;
      dragging = card;
      card.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.getAttribute('data-task-id'));
    });
    board.addEventListener('dragend', function () {
      if (dragging) dragging.classList.remove('is-dragging');
      dragging = null;
      board.querySelectorAll('.col.is-over').forEach(function (c) { c.classList.remove('is-over'); });
    });
    board.addEventListener('dragover', function (e) {
      var col = e.target.closest('[data-status]');
      if (!col || !dragging) return;
      e.preventDefault();
      board.querySelectorAll('.col.is-over').forEach(function (c) { if (c !== col) c.classList.remove('is-over'); });
      col.classList.add('is-over');
    });
    board.addEventListener('drop', function (e) {
      var col = e.target.closest('[data-status]');
      if (!col || !dragging) return;
      e.preventDefault();
      var id = dragging.getAttribute('data-task-id');
      var status = col.getAttribute('data-status');
      if (!/^\d+$/.test(id)) return;
      if (status === 'done') {
        window.location.href = '/tasks/' + id + '/close';
        return;
      }
      fetch('/tasks/' + id + '/move', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ status: status }),
      }).then(function (res) {
        if (!res.ok) throw new Error('move failed');
        window.location.reload();
      }).catch(function () {
        var msg = document.querySelector('[data-board-error]');
        if (msg) msg.hidden = false;
      });
    });
  }

  // Filters apply as soon as they change.
  document.querySelectorAll('[data-autosubmit]').forEach(function (el) {
    el.addEventListener('change', function () {
      var question = el.getAttribute('data-confirm');
      if (question && !window.confirm(question)) {
        el.form.reset();
        return;
      }
      el.form.submit();
    });
  });

  // Ask before destructive actions.
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  // Copy a one-time link.
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var input = document.querySelector(btn.getAttribute('data-copy'));
      if (!input) return;
      input.select();
      var done = function () { btn.textContent = btn.getAttribute('data-copied'); };
      if (navigator.clipboard) navigator.clipboard.writeText(input.value).then(done, function () {});
    });
  });

  // Table: row colouring switches instantly and is remembered in this browser.
  // A colour named in the URL (a shared link, or the form without JavaScript) wins.
  var colorSelect = document.querySelector('[data-color-by-select]');
  if (colorSelect) {
    var sheet = document.querySelector('[data-sheet]');
    var KEY = 'mahamm.table.color';
    var allowed = ['status', 'priority', 'label', 'none'];
    var applyColor = function (value) {
      if (allowed.indexOf(value) < 0) return;
      colorSelect.value = value;
      if (sheet) sheet.setAttribute('data-color-by', value);
    };
    var remember = function (value) {
      try { window.localStorage.setItem(KEY, value); } catch (e) { /* storage blocked: colour still works for this page */ }
    };
    var fromUrl = new URLSearchParams(window.location.search).get('color');
    if (fromUrl) {
      if (allowed.indexOf(fromUrl) >= 0) remember(fromUrl);
    } else {
      var saved = null;
      try { saved = window.localStorage.getItem(KEY); } catch (e) { saved = null; }
      if (saved) applyColor(saved);
    }
    colorSelect.addEventListener('change', function () {
      applyColor(colorSelect.value);
      remember(colorSelect.value);
    });
  }

  // Close form: show "who did it" only for Completed, "duplicate of" only for Duplicate.
  var closeForm = document.querySelector('[data-close-form]');
  if (closeForm) {
    var sync = function () {
      var picked = closeForm.querySelector('input[name="reason"]:checked');
      var reason = picked ? picked.value : 'completed';
      closeForm.querySelectorAll('[data-show-for]').forEach(function (block) {
        block.hidden = block.getAttribute('data-show-for') !== reason;
      });
    };
    closeForm.addEventListener('change', sync);
    sync();
  }
})();
