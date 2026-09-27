/* ==========================================================================
   Talentis — admin fee dashboard logic

   Fee model (agreed with the client):
     1. Registration  = flat Rs 5,000 per candidate, non-refundable.
     2. Placement fee = 10% of annual CTC, due AFTER the first salary.
     3. The Rs 5,000 is SEPARATE and is never deducted from the 10%.
     4. No GST at present (GST_RATE is here so it can be switched on later
        without touching the rest of the code).
     5. The 10% may be split into equal EMIs. Any rounding remainder is added
        to the FIRST instalment, so the schedule always sums to the fee exactly.

   Storage: this browser's localStorage. Nothing is uploaded anywhere.
   ========================================================================== */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * 1. CONFIGURE SIGN-IN HERE                                          *
   *                                                                    *
   * Replace these two values with the credentials you want to use.     *
   *                                                                    *
   * Be clear-eyed about what this is: a static site cannot keep a      *
   * secret, so anyone who opens View Source can read this password.    *
   * It is a screen lock to stop casual snooping, not access control.   *
   * What actually protects the data is that records never leave this   *
   * browser. Use a password you do not use anywhere else.              *
   * ------------------------------------------------------------------ */
  var ADMIN_EMAIL = "admin@talentis.example";
  var ADMIN_PASSWORD = "change-me-before-use";

  /* --- Business constants ------------------------------------------- */
  var REGISTRATION_FEE = 5000; // rupees, flat, non-refundable
  var PLACEMENT_RATE = 0.10; // 10% of CTC
  var GST_RATE = 0; // no GST today; set to 0.18 if that changes

  var STORE_KEY = "talentis.admin.candidates.v1";
  var SESSION_KEY = "talentis.admin.session";

  /* --- Money helpers ------------------------------------------------ */

  // Indian digit grouping, whole rupees: 453100 -> "Rs 4,53,100".
  var inr = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  });

  function money(n) {
    return inr.format(Math.round(Number(n) || 0));
  }

  /**
   * Placement fee = 10% of CTC, in whole rupees.
   * Uses integer division rather than `ctc * 0.1` to sidestep binary floating
   * point drift (0.1 is not exactly representable).
   *   453100 -> 45310
   */
  function placementFee(ctc) {
    var c = Math.max(0, Math.round(Number(ctc) || 0));
    var fee = Math.round(c / (1 / PLACEMENT_RATE));
    return GST_RATE ? Math.round(fee * (1 + GST_RATE)) : fee;
  }

  /**
   * Split an amount into `count` equal whole-rupee instalments, giving the
   * rounding remainder to the first one so the parts always sum to the total.
   *   45310 over 3 -> [15104, 15103, 15103]
   */
  function splitAmount(total, count) {
    var t = Math.max(0, Math.round(Number(total) || 0));
    var n = Math.max(1, Math.round(Number(count) || 1));
    var base = Math.floor(t / n);
    var remainder = t - base * n;
    var parts = [];
    for (var i = 0; i < n; i++) {
      parts.push(i === 0 ? base + remainder : base);
    }
    return parts;
  }

  function addMonths(isoDate, months) {
    if (!isoDate) return "";
    var parts = isoDate.split("-");
    if (parts.length !== 3) return "";
    var y = Number(parts[0]);
    var m = Number(parts[1]) - 1;
    var d = Number(parts[2]);
    var target = new Date(y, m + months, 1);
    // Clamp to the last valid day of the target month (31 Jan + 1 month).
    var lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(d, lastDay));
    var mm = String(target.getMonth() + 1).padStart(2, "0");
    var dd = String(target.getDate()).padStart(2, "0");
    return target.getFullYear() + "-" + mm + "-" + dd;
  }

  function prettyDate(iso) {
    if (!iso) return "\u2014";
    var parts = iso.split("-");
    if (parts.length !== 3) return "\u2014";
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (isNaN(d.getTime())) return "\u2014";
    return d.toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }

  function todayISO() {
    var d = new Date();
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }

  function escapeHTML(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (ch) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[ch];
    });
  }

  /* --- Derived candidate figures ------------------------------------ */

  function feeOf(c) {
    return placementFee(c.ctc);
  }

  function paidOf(c) {
    return (c.emis || []).reduce(function (sum, e) {
      return sum + (e.paid ? Math.round(Number(e.paidAmount) || 0) : 0);
    }, 0);
  }

  function pendingOf(c) {
    return Math.max(0, feeOf(c) - paidOf(c));
  }

  function paidCountOf(c) {
    return (c.emis || []).filter(function (e) {
      return e.paid;
    }).length;
  }

  /* --- Store -------------------------------------------------------- */

  var state = { candidates: [] };

  function load() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.candidates)) {
        state.candidates = parsed.candidates;
      }
    } catch (err) {
      // Corrupt or unreadable payload: start clean rather than crash, and say so.
      console.error("Could not read saved records:", err);
      toast("Saved records could not be read. Starting with an empty list.");
    }
  }

  function save() {
    try {
      window.localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ version: 1, savedAt: new Date().toISOString(), candidates: state.candidates })
      );
    } catch (err) {
      console.error("Could not save:", err);
      toast("Could not save. Browser storage may be full or blocked.");
    }
  }

  function newId() {
    return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function findCandidate(id) {
    for (var i = 0; i < state.candidates.length; i++) {
      if (state.candidates[i].id === id) return state.candidates[i];
    }
    return null;
  }

  /* --- EMI schedule building ---------------------------------------- */

  /**
   * Rebuild a candidate's schedule for `count` instalments starting `startDate`,
   * carrying over any payment already recorded against an instalment number
   * that still exists.
   */
  function buildSchedule(candidate, count, startDate) {
    var fee = placementFee(candidate.ctc);
    var amounts = splitAmount(fee, count);
    var previous = candidate.emis || [];
    var start = startDate || candidate.firstSalaryDate || todayISO();

    candidate.emis = amounts.map(function (amount, index) {
      var old = previous[index] || {};
      return {
        n: index + 1,
        amount: amount,
        dueDate: old.dueDate || addMonths(start, index),
        paid: !!old.paid,
        // A part payment already recorded is kept; otherwise default to due.
        paidAmount: old.paid ? Math.round(Number(old.paidAmount) || amount) : amount,
        paidDate: old.paidDate || "",
      };
    });
    candidate.emiCount = amounts.length;
    candidate.emiStart = start;
  }

  /* --- Toast -------------------------------------------------------- */

  var toastTimer = null;
  function toast(message) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      el.hidden = true;
    }, 4000);
  }

  /* --- Login -------------------------------------------------------- */

  function initLogin() {
    var screen = document.getElementById("login-screen");
    var app = document.getElementById("app");
    var form = document.getElementById("login-form");
    var error = document.getElementById("login-error");
    var who = document.getElementById("who-label");

    function enter(email) {
      screen.hidden = true;
      app.hidden = false;
      if (who) who.textContent = "Signed in as " + email;
      render();
    }

    // Stay signed in across reloads within this tab only.
    var active = window.sessionStorage.getItem(SESSION_KEY);
    if (active) {
      enter(active);
    } else {
      screen.hidden = false;
      app.hidden = true;
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var email = document.getElementById("login-email").value.trim();
      // Trimmed deliberately. Copying a password out of a message or document
      // very often drags a trailing space or newline along with it, and a
      // silent mismatch on invisible whitespace is a miserable thing to debug.
      var password = document.getElementById("login-password").value.trim();

      if (
        email.toLowerCase() === ADMIN_EMAIL.toLowerCase() &&
        password === ADMIN_PASSWORD
      ) {
        error.textContent = "";
        window.sessionStorage.setItem(SESSION_KEY, email);
        document.getElementById("login-password").value = "";
        enter(email);
      } else {
        error.textContent =
          "Those details don't match. The password is case-sensitive \u2014 tick " +
          "\u201cShow password\u201d to check what you typed.";
        document.getElementById("login-password").select();
      }
    });

    // Let the admin read back what they typed, which is the fastest way to
    // spot a stray capital or a keyboard-substituted character.
    var showToggle = document.getElementById("login-show");
    if (showToggle) {
      showToggle.addEventListener("change", function () {
        document.getElementById("login-password").type = showToggle.checked
          ? "text"
          : "password";
      });
    }

    document.getElementById("sign-out").addEventListener("click", function () {
      window.sessionStorage.removeItem(SESSION_KEY);
      app.hidden = true;
      screen.hidden = false;
      document.getElementById("login-email").focus();
    });
  }

  /* --- Rendering ---------------------------------------------------- */

  function visibleCandidates() {
    var term = document.getElementById("search").value.trim().toLowerCase();
    var status = document.getElementById("status-filter").value;
    var sort = document.getElementById("sort-by").value;

    var list = state.candidates.filter(function (c) {
      var matchesTerm =
        !term ||
        (c.name || "").toLowerCase().indexOf(term) !== -1 ||
        (c.employer || "").toLowerCase().indexOf(term) !== -1;
      var matchesStatus = status === "all" || c.status === status;
      return matchesTerm && matchesStatus;
    });

    list.sort(function (a, b) {
      if (sort === "pending") return pendingOf(b) - pendingOf(a);
      if (sort === "ctc") return (Number(b.ctc) || 0) - (Number(a.ctc) || 0);
      if (sort === "recent") return (b.createdAt || "").localeCompare(a.createdAt || "");
      return (a.name || "").localeCompare(b.name || "");
    });

    return list;
  }

  function statusBadge(status) {
    var map = {
      training: ["badge--training", "In training"],
      placed: ["badge--placed", "Placed"],
      withdrawn: ["badge--withdrawn", "Withdrawn"],
    };
    var pair = map[status] || map.training;
    return '<span class="badge ' + pair[0] + '">' + pair[1] + "</span>";
  }

  function renderTiles() {
    var all = state.candidates;
    var regCollected = all.reduce(function (sum, c) {
      return sum + (c.registrationPaid ? REGISTRATION_FEE : 0);
    }, 0);
    var collected = all.reduce(function (sum, c) {
      return sum + paidOf(c);
    }, 0);
    var pending = all.reduce(function (sum, c) {
      return sum + pendingOf(c);
    }, 0);

    document.getElementById("t-total").textContent = all.length;
    document.getElementById("t-training").textContent = all.filter(function (c) {
      return c.status === "training";
    }).length;
    document.getElementById("t-placed").textContent = all.filter(function (c) {
      return c.status === "placed";
    }).length;
    document.getElementById("t-reg").textContent = money(regCollected);
    document.getElementById("t-collected").textContent = money(collected);
    document.getElementById("t-pending").textContent = money(pending);
  }

  function renderRows() {
    var tbody = document.getElementById("rows");
    var wrap = document.getElementById("table-wrap");
    var empty = document.getElementById("empty");
    var list = visibleCandidates();

    document.getElementById("live-count").textContent =
      list.length + (list.length === 1 ? " candidate shown" : " candidates shown");

    if (!state.candidates.length) {
      wrap.hidden = true;
      empty.hidden = false;
      tbody.innerHTML = "";
      return;
    }

    wrap.hidden = false;
    empty.hidden = true;

    if (!list.length) {
      tbody.innerHTML =
        '<tr><td colspan="10" style="text-align:center;color:var(--ink-muted)">' +
        "No candidate matches that search or filter.</td></tr>";
      return;
    }

    tbody.innerHTML = list
      .map(function (c) {
        var fee = feeOf(c);
        var paid = paidOf(c);
        var pending = pendingOf(c);
        var emiLabel = c.ctc
          ? paidCountOf(c) + " of " + (c.emis || []).length + " paid"
          : "\u2014";
        var pendingCell = !c.ctc
          ? '<span style="color:var(--ink-muted)">\u2014</span>'
          : pending === 0
          ? '<span class="badge badge--clear">Cleared</span>'
          : '<span class="badge badge--due">' + money(pending) + "</span>";

        return (
          "<tr>" +
          '<td class="name">' +
          escapeHTML(c.name || "Unnamed") +
          (c.employer ? "<small>" + escapeHTML(c.employer) + "</small>" : "") +
          "</td>" +
          "<td>" + escapeHTML(c.track || "\u2014") + "</td>" +
          "<td>" + statusBadge(c.status) + "</td>" +
          "<td>" +
          (c.registrationPaid
            ? '<span class="badge badge--clear">Paid</span>'
            : '<span class="badge badge--due">Due</span>') +
          "</td>" +
          '<td class="num">' + (c.ctc ? money(c.ctc) : "\u2014") + "</td>" +
          '<td class="num">' + (c.ctc ? money(fee) : "\u2014") + "</td>" +
          '<td class="num">' + (c.ctc ? money(paid) : "\u2014") + "</td>" +
          '<td class="num">' + pendingCell + "</td>" +
          "<td>" + emiLabel + "</td>" +
          '<td><div class="row-actions">' +
          '<button class="btn btn--sm btn--outline" type="button" data-edit="' +
          c.id +
          '">Edit</button>' +
          (c.ctc
            ? '<button class="btn btn--sm btn--secondary" type="button" data-pay="' +
              c.id +
              '">Payments</button>'
            : "") +
          "</div></td>" +
          "</tr>"
        );
      })
      .join("");
  }

  function render() {
    renderTiles();
    renderRows();
  }

  /* --- Candidate dialog --------------------------------------------- */

  var editingId = null;

  function openCandidate(id) {
    var dialog = document.getElementById("candidate-dialog");
    var c = id ? findCandidate(id) : null;
    editingId = id || null;

    document.getElementById("cd-title").textContent = c
      ? "Edit " + (c.name || "candidate")
      : "Add candidate";
    document.getElementById("delete-candidate").hidden = !c;

    var v = function (elId, value) {
      document.getElementById(elId).value = value == null ? "" : value;
    };

    v("f-name", c && c.name);
    v("f-phone", c && c.phone);
    v("f-email", c && c.email);
    v("f-track", (c && c.track) || "");
    v("f-admission", c && c.admissionDate);
    v("f-status", (c && c.status) || "training");
    document.getElementById("f-reg-paid").checked = !!(c && c.registrationPaid);
    v("f-reg-date", c && c.registrationDate);
    v("f-employer", c && c.employer);
    v("f-joining", c && c.joiningDate);
    v("f-first-salary", c && c.firstSalaryDate);
    v("f-ctc", c && c.ctc ? c.ctc : "");
    v("f-emi-count", String((c && c.emiCount) || 1));
    v("f-emi-start", (c && c.emiStart) || "");
    v("f-notes", c && c.notes);

    document.getElementById("f-name-error").textContent = "";
    document.getElementById("f-ctc-error").textContent = "";

    updateCalc();
    dialog.showModal();
    document.getElementById("f-name").focus();
  }

  function updateCalc() {
    var ctc = Number(document.getElementById("f-ctc").value) || 0;
    var fee = placementFee(ctc);
    var count = Number(document.getElementById("f-emi-count").value) || 1;

    document.getElementById("calc-ctc").textContent = money(ctc);
    document.getElementById("calc-fee").textContent = money(fee);
    document.getElementById("calc-reg").textContent = money(REGISTRATION_FEE);
    document.getElementById("calc-total").textContent = money(REGISTRATION_FEE + fee);

    var preview = document.getElementById("emi-preview");
    if (!fee) {
      preview.textContent = "Enter a CTC to see the instalment split.";
      return;
    }
    var parts = splitAmount(fee, count);
    if (count === 1) {
      preview.textContent = "One payment of " + money(parts[0]) + ".";
    } else {
      var unique = parts
        .filter(function (p, i, arr) {
          return arr.indexOf(p) === i;
        })
        .map(money);
      preview.textContent =
        count +
        " instalments: " +
        parts.slice(0, 3).map(money).join(" + ") +
        (count > 3 ? " + \u2026" : "") +
        " (" +
        (unique.length === 1
          ? money(parts[0]) + " each"
          : "first instalment carries the rounding") +
        ").";
    }
  }

  function saveCandidate(event) {
    event.preventDefault();
    var name = document.getElementById("f-name").value.trim();
    var nameError = document.getElementById("f-name-error");
    var ctcRaw = document.getElementById("f-ctc").value.trim();
    var ctcError = document.getElementById("f-ctc-error");

    if (!name) {
      nameError.textContent = "Name is required.";
      document.getElementById("f-name").focus();
      return;
    }
    nameError.textContent = "";

    if (ctcRaw && (isNaN(Number(ctcRaw)) || Number(ctcRaw) < 0)) {
      ctcError.textContent = "Enter the CTC as digits, for example 453100.";
      document.getElementById("f-ctc").focus();
      return;
    }
    ctcError.textContent = "";

    var c = editingId ? findCandidate(editingId) : null;
    var isNew = !c;
    if (isNew) {
      c = { id: newId(), createdAt: new Date().toISOString(), emis: [] };
      state.candidates.push(c);
    }

    c.name = name;
    c.phone = document.getElementById("f-phone").value.trim();
    c.email = document.getElementById("f-email").value.trim();
    c.track = document.getElementById("f-track").value;
    c.admissionDate = document.getElementById("f-admission").value;
    c.status = document.getElementById("f-status").value;
    c.registrationPaid = document.getElementById("f-reg-paid").checked;
    c.registrationDate = document.getElementById("f-reg-date").value;
    c.employer = document.getElementById("f-employer").value.trim();
    c.joiningDate = document.getElementById("f-joining").value;
    c.firstSalaryDate = document.getElementById("f-first-salary").value;
    c.ctc = ctcRaw ? Math.round(Number(ctcRaw)) : 0;
    c.notes = document.getElementById("f-notes").value.trim();

    var count = Number(document.getElementById("f-emi-count").value) || 1;
    var start = document.getElementById("f-emi-start").value;

    if (c.ctc > 0) {
      buildSchedule(c, count, start);
    } else {
      c.emis = [];
      c.emiCount = count;
    }

    save();
    render();
    document.getElementById("candidate-dialog").close();
    toast(
      isNew
        ? name + " added." + (c.ctc ? " Placement fee " + money(feeOf(c)) + "." : "")
        : name + " updated." + (c.ctc ? " Placement fee " + money(feeOf(c)) + "." : "")
    );
  }

  function deleteCandidate() {
    if (!editingId) return;
    var c = findCandidate(editingId);
    if (!c) return;
    var ok = window.confirm(
      "Delete " +
        (c.name || "this candidate") +
        " and all recorded payments? This cannot be undone."
    );
    if (!ok) return;
    state.candidates = state.candidates.filter(function (x) {
      return x.id !== editingId;
    });
    save();
    render();
    document.getElementById("candidate-dialog").close();
    toast((c.name || "Candidate") + " deleted.");
  }

  /* --- Payments dialog ---------------------------------------------- */

  var payingId = null;

  function openPayments(id) {
    var c = findCandidate(id);
    if (!c) return;
    payingId = id;

    document.getElementById("ed-title").textContent =
      "Payments \u2014 " + (c.name || "candidate");
    document.getElementById("ed-sub").textContent =
      "CTC " +
      money(c.ctc) +
      " \u00b7 placement fee " +
      money(feeOf(c)) +
      " \u00b7 " +
      (c.emis || []).length +
      (c.emis && c.emis.length === 1 ? " payment" : " instalments");

    renderPaymentRows(c);
    document.getElementById("emi-dialog").showModal();
  }

  function renderPaymentRows(c) {
    var tbody = document.getElementById("emi-rows");
    tbody.innerHTML = (c.emis || [])
      .map(function (e, i) {
        return (
          '<tr class="' +
          (e.paid ? "is-paid" : "") +
          '">' +
          "<td>" + e.n + "</td>" +
          '<td><input type="date" data-field="dueDate" data-i="' +
          i +
          '" value="' +
          escapeHTML(e.dueDate) +
          '" aria-label="Due date for instalment ' + e.n + '"></td>' +
          '<td class="num">' + money(e.amount) + "</td>" +
          '<td class="paid-cell"><input type="checkbox" data-field="paid" data-i="' +
          i +
          '"' +
          (e.paid ? " checked" : "") +
          ' aria-label="Instalment ' + e.n + ' paid"></td>' +
          '<td><input type="number" min="0" step="1" data-field="paidAmount" data-i="' +
          i +
          '" value="' +
          (e.paid ? Math.round(Number(e.paidAmount) || e.amount) : "") +
          '" aria-label="Amount received for instalment ' + e.n + '"></td>' +
          '<td><input type="date" data-field="paidDate" data-i="' +
          i +
          '" value="' +
          escapeHTML(e.paidDate) +
          '" aria-label="Date received for instalment ' + e.n + '"></td>' +
          "</tr>"
        );
      })
      .join("");

    updatePaymentTotals(c);
  }

  function updatePaymentTotals(c) {
    var due = (c.emis || []).reduce(function (s, e) {
      return s + e.amount;
    }, 0);
    var paid = paidOf(c);
    document.getElementById("emi-total-due").textContent = money(due);
    document.getElementById("emi-total-paid").textContent = money(paid);
    var pendingCell = document.getElementById("emi-total-pending");
    var pending = Math.max(0, due - paid);
    pendingCell.textContent = pending ? money(pending) + " pending" : "Cleared";
  }

  function initPaymentsDialog() {
    var tbody = document.getElementById("emi-rows");

    tbody.addEventListener("input", function (event) {
      var input = event.target;
      var field = input.getAttribute("data-field");
      var index = Number(input.getAttribute("data-i"));
      var c = findCandidate(payingId);
      if (!c || !c.emis || !c.emis[index] || !field) return;
      var emi = c.emis[index];

      if (field === "paid") {
        emi.paid = input.checked;
        var row = input.closest("tr");
        var amountInput = row.querySelector('[data-field="paidAmount"]');
        var dateInput = row.querySelector('[data-field="paidDate"]');
        if (emi.paid) {
          if (!amountInput.value) amountInput.value = emi.amount;
          if (!dateInput.value) dateInput.value = todayISO();
          emi.paidAmount = Math.round(Number(amountInput.value) || emi.amount);
          emi.paidDate = dateInput.value;
          row.classList.add("is-paid");
        } else {
          emi.paidAmount = emi.amount;
          emi.paidDate = "";
          amountInput.value = "";
          dateInput.value = "";
          row.classList.remove("is-paid");
        }
      } else if (field === "paidAmount") {
        emi.paidAmount = Math.round(Number(input.value) || 0);
      } else {
        emi[field] = input.value;
      }

      updatePaymentTotals(c);
    });

    document.getElementById("emi-save").addEventListener("click", function () {
      var c = findCandidate(payingId);
      save();
      render();
      document.getElementById("emi-dialog").close();
      if (c) {
        var pending = pendingOf(c);
        toast(
          pending === 0
            ? (c.name || "Candidate") + " is fully paid up."
            : money(pending) + " still pending for " + (c.name || "candidate") + "."
        );
      }
    });
  }

  /* --- Export / import --------------------------------------------- */

  function initBackup() {
    document.getElementById("export").addEventListener("click", function () {
      var payload = {
        exportedAt: new Date().toISOString(),
        version: 1,
        registrationFee: REGISTRATION_FEE,
        placementRate: PLACEMENT_RATE,
        candidates: state.candidates,
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "talentis-fees-" + todayISO() + ".json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast("Backup downloaded.");
    });

    var fileInput = document.getElementById("import-file");

    document.getElementById("import").addEventListener("click", function () {
      fileInput.click();
    });

    fileInput.addEventListener("change", function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var data = JSON.parse(String(reader.result));
          if (!data || !Array.isArray(data.candidates)) {
            throw new Error("No candidates array in that file");
          }
          var incoming = data.candidates.length;
          var replace = window.confirm(
            "That file holds " +
              incoming +
              " candidate record(s).\n\nOK replaces your current " +
              state.candidates.length +
              " record(s).\nCancel merges them in instead, keeping both."
          );
          if (replace) {
            state.candidates = data.candidates;
          } else {
            var existing = {};
            state.candidates.forEach(function (c) {
              existing[c.id] = true;
            });
            data.candidates.forEach(function (c) {
              if (!existing[c.id]) state.candidates.push(c);
              else {
                c.id = newId();
                state.candidates.push(c);
              }
            });
          }
          save();
          render();
          toast(
            (replace ? "Replaced with " : "Merged in ") + incoming + " record(s)."
          );
        } catch (err) {
          console.error(err);
          toast("That file could not be read as a Talentis backup.");
        }
        fileInput.value = "";
      };
      reader.onerror = function () {
        toast("Could not read that file.");
        fileInput.value = "";
      };
      reader.readAsText(file);
    });
  }

  /* --- Wiring ------------------------------------------------------- */

  function init() {
    load();
    initLogin();
    initPaymentsDialog();
    initBackup();

    document.getElementById("add-candidate").addEventListener("click", function () {
      openCandidate(null);
    });
    document.getElementById("add-first").addEventListener("click", function () {
      openCandidate(null);
    });

    document.getElementById("rows").addEventListener("click", function (event) {
      var edit = event.target.closest("[data-edit]");
      if (edit) {
        openCandidate(edit.getAttribute("data-edit"));
        return;
      }
      var pay = event.target.closest("[data-pay]");
      if (pay) openPayments(pay.getAttribute("data-pay"));
    });

    document.getElementById("candidate-form").addEventListener("submit", saveCandidate);
    document
      .getElementById("delete-candidate")
      .addEventListener("click", deleteCandidate);

    document.getElementById("f-ctc").addEventListener("input", updateCalc);
    document.getElementById("f-emi-count").addEventListener("change", updateCalc);

    // Default the EMI start date to the first salary date when that is set.
    document.getElementById("f-first-salary").addEventListener("change", function () {
      var start = document.getElementById("f-emi-start");
      if (!start.value) start.value = this.value;
    });

    ["search", "status-filter", "sort-by"].forEach(function (id) {
      var el = document.getElementById(id);
      el.addEventListener("input", renderRows);
      el.addEventListener("change", renderRows);
    });

    Array.prototype.forEach.call(
      document.querySelectorAll("[data-close-dialog]"),
      function (button) {
        button.addEventListener("click", function () {
          var dialog = button.closest("dialog");
          if (dialog) dialog.close();
        });
      }
    );
  }

  // Exposed purely so the arithmetic can be unit-checked from the console.
  window.TalentisFees = {
    placementFee: placementFee,
    splitAmount: splitAmount,
    REGISTRATION_FEE: REGISTRATION_FEE,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
