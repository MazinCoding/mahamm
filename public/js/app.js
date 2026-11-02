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

  // Table ribbon. Without JavaScript the ribbon is a normal form and the row
  // checkboxes belong to it. With JavaScript: click selects a row, Shift-click a
  // range, Ctrl or Cmd-click adds one; clicking a cell opens a small menu for
  // that task; the brush applies the chosen value to each row you click.
  var ribbon = document.querySelector('[data-ribbon]');
  var sheetTable = document.querySelector('.sheet');
  if (ribbon && sheetTable) {
    var SEL_KEY = 'mahamm.table.selected';
    var BRUSH_KEY = 'mahamm.table.brush';
    var session = {
      get: function (key) { try { return JSON.parse(window.sessionStorage.getItem(key) || 'null'); } catch (e) { return null; } },
      set: function (key, value) { try { window.sessionStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* not kept: fine */ } },
      drop: function (key) { try { window.sessionStorage.removeItem(key); } catch (e) { /* nothing to drop */ } },
    };
    var statusLine = ribbon.querySelector('[data-ribbon-status]');
    var brushBtn = ribbon.querySelector('[data-brush]');
    var rows = Array.prototype.slice.call(sheetTable.querySelectorAll('tbody tr[data-task-id]'));
    var here = window.location.pathname + window.location.search;
    var anchor = null;
    var menu = null;
    var brush = { on: false, payload: null, label: '' };

    var msg = function (name, vars) {
      var text = ribbon.getAttribute('data-msg-' + name) || '';
      Object.keys(vars || {}).forEach(function (k) { text = text.split('{' + k + '}').join(String(vars[k])); });
      return text;
    };
    var say = function (text, warn) {
      statusLine.textContent = text;
      statusLine.classList.toggle('is-warn', !!warn);
    };
    var checkOf = function (row) { return row.querySelector('.row-check'); };
    var idOf = function (row) { return row.getAttribute('data-task-id'); };
    var selectedIds = function () { return rows.filter(function (r) { return checkOf(r).checked; }).map(idOf); };
    var refresh = function () {
      rows.forEach(function (r) { r.classList.toggle('is-selected', checkOf(r).checked); });
      if (brush.on) return;
      var n = selectedIds().length;
      say(n ? msg('count', { n: n }) : msg('hint'));
    };
    var only = function (row) { rows.forEach(function (r) { checkOf(r).checked = r === row; }); };
    var range = function (row) {
      var a = rows.indexOf(anchor);
      var b = rows.indexOf(row);
      rows.forEach(function (r, i) { checkOf(r).checked = i >= Math.min(a, b) && i <= Math.max(a, b); });
    };

    var payloadFrom = function (container, btn) {
      var person = container.querySelector('[name="assignee"]');
      var due = container.querySelector('[name="due"]');
      return { apply: btn.value, assignee: person ? person.value : '', due: due ? due.value : '' };
    };
    var labelFor = function (container, btn) {
      var text = btn.textContent.trim();
      var person = container.querySelector('[name="assignee"]');
      var due = container.querySelector('[name="due"]');
      if (btn.value === 'assignee' && person && person.selectedIndex >= 0) text += ': ' + person.options[person.selectedIndex].text;
      if (btn.value === 'due' && due && due.value) text += ': ' + due.value;
      return text;
    };

    var send = function (ids, payload) {
      fetch('/tasks/bulk', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ ids: ids.map(Number), apply: payload.apply, assignee: payload.assignee, due: payload.due, back: here }),
      }).then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      }).then(function (r) {
        if (!r.ok) {
          say((r.body && r.body.message) || msg('failed'), true);
          return;
        }
        if (r.body.redirect) {
          window.location.href = r.body.redirect;
          return;
        }
        // The page reloads to show the saved values; keep the selection and the brush.
        session.set(SEL_KEY, { path: here, ids: selectedIds() });
        window.location.reload();
      }).catch(function () { say(msg('failed'), true); });
    };

    var markArmed = function (value) {
      ribbon.querySelectorAll('.rb.is-armed').forEach(function (b) { b.classList.remove('is-armed'); });
      if (!value) return;
      ribbon.querySelectorAll('button[name="apply"]').forEach(function (b) { if (b.value === value) b.classList.add('is-armed'); });
    };
    var setBrush = function (on) {
      brush.on = on;
      brushBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      sheetTable.classList.toggle('is-brushing', on && !!brush.payload);
      if (!on) {
        brush.payload = null;
        markArmed(null);
        session.drop(BRUSH_KEY);
        refresh();
      } else if (!brush.payload) {
        say(msg('brush-pick'));
      }
    };
    var arm = function (payload, label) {
      brush.payload = payload;
      brush.label = label;
      markArmed(payload.apply);
      sheetTable.classList.add('is-brushing');
      session.set(BRUSH_KEY, { payload: payload, label: label, path: here });
      say(msg('brush', { v: label }));
    };

    var closeMenu = function () {
      if (menu) menu.remove();
      menu = null;
    };
    var openMenu = function (cell, row) {
      closeMenu();
      var id = idOf(row);
      if (row.hasAttribute('data-closed')) { say(msg('closed', { n: '#' + id }), true); return; }
      if (cell.hasAttribute('data-locked')) { say(msg('locked', { n: '#' + id }), true); return; }
      var group = ribbon.querySelector('[data-group="' + cell.getAttribute('data-field') + '"]');
      if (!group) return;
      only(row);
      anchor = row;
      refresh();
      var groupName = group.querySelector('.ribbon-label').textContent.trim();
      menu = document.createElement('div');
      menu.className = 'cell-menu';
      menu.setAttribute('role', 'dialog');
      menu.setAttribute('aria-label', '#' + id + ' · ' + groupName);
      var title = document.createElement('p');
      title.className = 'cell-menu-title';
      title.textContent = '#' + id + ' · ' + groupName;
      var body = group.querySelector('.ribbon-buttons').cloneNode(true);
      body.querySelectorAll('label').forEach(function (l) { l.remove(); });
      body.querySelectorAll('[id]').forEach(function (el) { el.removeAttribute('id'); el.setAttribute('aria-label', groupName); });
      body.querySelectorAll('button').forEach(function (b) { b.type = 'button'; b.classList.remove('is-armed'); });
      menu.appendChild(title);
      menu.appendChild(body);
      document.body.appendChild(menu);
      var box = cell.getBoundingClientRect();
      var width = document.documentElement.clientWidth;
      var left = Math.max(8, Math.min(box.left, width - menu.offsetWidth - 8));
      menu.style.top = (window.scrollY + box.bottom + 4) + 'px';
      menu.style.left = (window.scrollX + left) + 'px';
      menu.addEventListener('click', function (e) {
        var btn = e.target.closest('button');
        if (btn) send([id], payloadFrom(menu, btn));
      });
      var first = menu.querySelector('button, select, input');
      if (first) first.focus();
    };

    // Selection and the brush.
    sheetTable.addEventListener('mousedown', function (e) {
      if (e.shiftKey && e.target.closest('tbody tr')) e.preventDefault();
    });
    sheetTable.addEventListener('click', function (e) {
      var row = e.target.closest('tbody tr[data-task-id]');
      if (!row || e.target.closest('a')) return;
      if (brush.on && brush.payload) {
        e.preventDefault();
        if (row.hasAttribute('data-closed')) { say(msg('closed', { n: '#' + idOf(row) }), true); return; }
        only(row);
        send([idOf(row)], brush.payload);
        return;
      }
      if (e.target.classList.contains('row-check')) {
        if (e.shiftKey && anchor) range(row);
        anchor = row;
        refresh();
        return;
      }
      if (e.shiftKey && anchor) { range(row); refresh(); return; }
      if (e.ctrlKey || e.metaKey) { checkOf(row).checked = !checkOf(row).checked; anchor = row; refresh(); return; }
      var cell = e.target.closest('[data-field]');
      if (cell) { openMenu(cell, row); return; }
      only(row);
      anchor = row;
      refresh();
    });

    // Ribbon buttons apply to the selection, or load the brush when it's on.
    ribbon.addEventListener('submit', function (e) {
      var btn = e.submitter;
      if (!btn || btn.name !== 'apply') return;
      e.preventDefault();
      closeMenu();
      var payload = payloadFrom(ribbon, btn);
      if (brush.on) { arm(payload, labelFor(ribbon, btn)); return; }
      var ids = selectedIds();
      if (!ids.length) { say(msg('select'), true); return; }
      send(ids, payload);
    });
    brushBtn.addEventListener('click', function () { setBrush(!brush.on); });
    ribbon.querySelector('[data-select-all]').addEventListener('click', function () {
      rows.forEach(function (r) { checkOf(r).checked = true; });
      refresh();
    });
    ribbon.querySelector('[data-select-none]').addEventListener('click', function () {
      rows.forEach(function (r) { checkOf(r).checked = false; });
      refresh();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (menu) { closeMenu(); return; }
      if (brush.on) setBrush(false);
    });
    document.addEventListener('click', function (e) {
      if (menu && !menu.contains(e.target) && !e.target.closest('[data-field]')) closeMenu();
    });

    // Start-up: show the JavaScript tools, then restore the selection and brush after a save.
    ribbon.querySelector('[data-js-tools]').hidden = false;
    var kept = session.get(SEL_KEY);
    session.drop(SEL_KEY);
    if (kept && kept.path === here && Array.isArray(kept.ids)) {
      rows.forEach(function (r) { checkOf(r).checked = kept.ids.indexOf(idOf(r)) >= 0; });
    }
    refresh();
    var savedBrush = session.get(BRUSH_KEY);
    if (savedBrush && savedBrush.payload && savedBrush.path === here) {
      brush.on = true;
      brushBtn.setAttribute('aria-pressed', 'true');
      arm(savedBrush.payload, savedBrush.label || '');
    }
  }

  // After a quick add the server marks the title box autofocus; focusing it
  // here as well also scrolls it into view in browsers that skip autofocus.
  var quickTitle = document.querySelector('#quick-title[autofocus]');
  if (quickTitle && document.activeElement !== quickTitle) quickTitle.focus();

  // Home: opening one task's status menu closes any other that's open.
  var picks = document.querySelectorAll('details[data-one-open]');
  picks.forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (!d.open) return;
      picks.forEach(function (other) { if (other !== d) other.open = false; });
    });
  });

  // Home, after the composer adds a task: show its details form as a sheet.
  // Nothing is saved until "Submit details"; "Add details later" just closes it.
  var panel = document.querySelector('[data-added-panel]');
  if (panel && typeof HTMLDialogElement === 'function') {
    var sheet = document.createElement('dialog');
    sheet.className = 'sheet';
    sheet.setAttribute('aria-labelledby', 'added-title');
    panel.parentNode.insertBefore(sheet, panel);
    sheet.appendChild(panel);
    var later = function () {
      sheet.close();
      sheet.remove();
      // Forget ?added= so a reload doesn't open it again.
      try { window.history.replaceState(null, '', '/home'); } catch (e) { /* the address just stays */ }
    };
    panel.querySelector('[data-later]').addEventListener('click', function (e) { e.preventDefault(); later(); });
    sheet.addEventListener('cancel', function (e) { e.preventDefault(); later(); });
    sheet.addEventListener('click', function (e) { if (e.target === sheet) later(); });

    // Choosing a date also chooses "On a date".
    var dueDate = panel.querySelector('[name="due_date"]');
    var onDate = panel.querySelector('[name="due_when"][value="date"]');
    if (dueDate && onDate) dueDate.addEventListener('change', function () { if (dueDate.value) onDate.checked = true; });

    // Someone picked from "Add someone…" becomes a ticked chip, so several can be added.
    var addPerson = panel.querySelector('[name="add_assignee"]');
    var peopleRow = panel.querySelector('[data-people]');
    if (addPerson && peopleRow) {
      addPerson.addEventListener('change', function () {
        var opt = addPerson.options[addPerson.selectedIndex];
        if (!opt || !opt.value) return;
        var chip = document.createElement('label');
        chip.className = 'pick';
        var box = document.createElement('input');
        box.className = 'sr-only';
        box.type = 'checkbox';
        box.name = 'assignees';
        box.value = opt.value;
        box.checked = true;
        var name = document.createElement('bdi');
        name.textContent = opt.text;
        chip.appendChild(box);
        chip.appendChild(name);
        peopleRow.insertBefore(chip, peopleRow.querySelector('label[for="add-person"]'));
        opt.remove();
        addPerson.selectedIndex = 0;
      });
    }

    sheet.showModal();
    panel.querySelector('#added-title').focus();
  }

  // Close form: show "who did it" only for Completed, "duplicate of" only for Duplicate.
  var closeForm = document.querySelector('[data-close-form]');
  if (closeForm) {
    var sync = function () {
      var picked = closeForm.querySelector('input[name="reason"]:checked');
      var reason = picked ? picked.value : 'completed';
      closeForm.querySelectorAll('[data-show-for]').forEach(function (block) {
        block.hidden = block.getAttribute('data-show-for') !== reason;
        // Hidden choices aren't sent, so they can't get in the way of the chosen reason.
        block.querySelectorAll('input, select, textarea').forEach(function (el) { el.disabled = block.hidden; });
      });
    };
    closeForm.addEventListener('change', sync);
    sync();
  }
})();
