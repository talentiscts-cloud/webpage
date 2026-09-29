/* ==========================================================================
   Talentis Consultancy — admin fee dashboard

   FEE MODEL
     1. Registration  = flat amount (default Rs 5,000), non-refundable.
     2. Placement fee = a PERCENTAGE of annual CTC, due after the first salary.
     3. The registration is SEPARATE and never deducted from the percentage.
     4. The fee may be split into equal EMIs. Any rounding remainder goes onto
        instalment 1, so the parts always sum to the fee exactly.

   THE PERCENTAGE IS ADMIN-EDITABLE.
     Held as integer BASIS POINTS: 10% = 1000, 12.5% = 1250, 7.25% = 725.
     Basis points keep the arithmetic in whole numbers, so a rate like 12.5%
     stays exact and no float can round money the wrong way.
     A global default applies to new candidates; each candidate also stores
     their own rate, so changing the default never re-prices earlier records.

   TWO MODES
     Server mode  — talks to the PHP API, data in MySQL, real accounts,
                    shared across devices. Used when API_BASE is set and
                    reachable.
     Browser mode — data in this browser's localStorage only, sign-in checked
                    against the constants below. The fallback, and what runs
                    when the file is opened directly.
   ========================================================================== */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * 1. CONFIGURE HERE                                                  *
   * ------------------------------------------------------------------ */

  /**
   * Path to the PHP API, relative to this page. Leave as "api" once the server
   * is deployed; set to "" to force browser-only mode.
   * If the API cannot be reached, the dashboard falls back to browser mode and
   * says so rather than failing.
   */
  var API_BASE = "api";

  /**
   * Browser-mode sign-in only. Ignored entirely in server mode, where real
   * accounts live in the database as bcrypt hashes.
   *
   * A static file cannot keep a secret: anyone can read this with View Source.
   * It is a screen lock, not access control. What protects browser-mode data is
   * that it never leaves the machine.
   */
  var ADMIN_EMAIL = "admin@talentis.example";
  var ADMIN_PASSWORD = "change-me-before-use";

  /* --- Fallback business defaults (server settings win when connected) --- */
  var DEFAULTS = {
    registrationAmount: 5000,
    defaultFeeBp: 1000, // 10%
    gstPercent: 0
  };

  var MAX_BP = 10000; // 100%. A fee above the salary is a typo, not a policy.

  var STORE_KEY = "talentis.admin.candidates.v2";
  var LEGACY_KEY = "talentis.admin.candidates.v1";
  var SETTINGS_KEY = "talentis.admin.settings.v1";
  var SESSION_KEY = "talentis.admin.session";

  /* --- Runtime state ---------------------------------------------------- */
  var state = {
    candidates: [],
    settings: {
      registrationAmount: DEFAULTS.registrationAmount,
      defaultFeeBp: DEFAULTS.defaultFeeBp,
      gstPercent: DEFAULTS.gstPercent
    },
    mode: "local", // "server" once the API answers
    csrf: "",
    email: ""
  };

  /* ==================================================================== *
   * Storage, defensively                                                 *
   * Browsers throw rather than return null when storage is off limits:    *
   * Safari does it for file:// pages and private windows can refuse       *
   * writes. An unguarded access here once aborted setup before the login  *
   * handler was attached, so the form submitted natively and the page      *
   * reloaded with empty fields and no error.                              *
   * ==================================================================== */

  function probeStorage(kind) {
    try {
      var store = window[kind];
      if (!store) return null;
      var probe = "__talentis_probe__";
      store.setItem(probe, "1");
      store.removeItem(probe);
      return store;
    } catch (err) {
      return null;
    }
  }

  var memoryCells = {};

  function memoryStore(prefix) {
    return {
      getItem: function (key) {
        var k = prefix + key;
        return Object.prototype.hasOwnProperty.call(memoryCells, k)
          ? memoryCells[k]
          : null;
      },
      setItem: function (key, value) {
        memoryCells[prefix + key] = String(value);
      },
      removeItem: function (key) {
        delete memoryCells[prefix + key];
      }
    };
  }

  var realLocal = probeStorage("localStorage");
  var realSession = probeStorage("sessionStorage");
  var persistentStore = realLocal || memoryStore("local:");
  var sessionStore = realSession || memoryStore("session:");
  var storageBlocked = !realLocal;

  /* ==================================================================== *
   * Money and fee arithmetic                                             *
   * Mirrors server/api/lib/fees.php exactly. The server recomputes        *
   * everything it stores, so this copy exists only to update the screen   *
   * as you type.                                                         *
   * ==================================================================== */

  var inr = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  });

  function money(n) {
    return inr.format(Math.round(Number(n) || 0));
  }

  /** Clamp a basis-point value from any source. */
  function cleanBp(bp) {
    var n = Number(bp);
    if (!isFinite(n)) return 0;
    return Math.max(0, Math.min(MAX_BP, Math.round(n)));
  }

  /** "12.5" -> 1250 basis points. */
  function bpFromPercent(percent) {
    var n = Number(percent);
    if (!isFinite(n)) return 0;
    return cleanBp(Math.round(n * 100));
  }

  /** 1250 -> "12.5", 1000 -> "10". */
  function percentFromBp(bp) {
    bp = cleanBp(bp);
    if (bp % 100 === 0) return String(bp / 100);
    return String(Math.round(bp) / 100);
  }

  /**
   * Placement fee in whole rupees: ctc * bp / 10000, rounded half up.
   * Integer arithmetic throughout. Deliberately not `ctc * 0.1`, because 0.1
   * has no exact binary representation.
   */
  function placementFeeFor(ctc, bp, gstPercent) {
    var c = Math.max(0, Math.round(Number(ctc) || 0));
    var b = cleanBp(bp);
    if (c <= 0 || b <= 0) return 0;

    var numerator = c * b;
    var fee = Math.floor(numerator / 10000);
    if ((numerator % 10000) * 2 >= 10000) fee++;

    var gst = Number(gstPercent) || 0;
    if (gst > 0) {
      var gn = fee * gst;
      var g = Math.floor(gn / 100);
      if ((gn % 100) * 2 >= 100) g++;
      fee += g;
    }
    return fee;
  }

  /** Equal whole-rupee split, remainder onto instalment 1. */
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
    var parts = String(isoDate).split("-");
    if (parts.length !== 3) return "";
    var y = Number(parts[0]);
    var m = Number(parts[1]) - 1;
    var d = Number(parts[2]);
    var target = new Date(y, m + months, 1);
    var lastDay = new Date(
      target.getFullYear(),
      target.getMonth() + 1,
      0
    ).getDate();
    target.setDate(Math.min(d, lastDay));
    return (
      target.getFullYear() +
      "-" +
      String(target.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(target.getDate()).padStart(2, "0")
    );
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
        "'": "&#39;"
      }[ch];
    });
  }

  /* --- Derived figures -------------------------------------------------- */

  function bpOf(c) {
    return cleanBp(
      c && c.feeBp != null ? c.feeBp : state.settings.defaultFeeBp
    );
  }

  function feeOf(c) {
    return placementFeeFor(c.ctc, bpOf(c), state.settings.gstPercent);
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

  function registrationAmountOf(c) {
    return Math.round(
      Number(c && c.registrationAmount != null
        ? c.registrationAmount
        : state.settings.registrationAmount) || 0
    );
  }

  /** Rebuild a schedule, keeping payments recorded against surviving numbers. */
  function buildSchedule(candidate, count, startDate) {
    var fee = feeOf(candidate);
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
        paidAmount: old.paid
          ? Math.round(Number(old.paidAmount) || amount)
          : amount,
        paidDate: old.paidDate || ""
      };
    });
    candidate.emiCount = amounts.length;
    candidate.emiStart = start;
  }

  /* ==================================================================== *
   * Backends                                                             *
   * Both expose the same promise-based interface, so the UI never needs   *
   * to know where the data lives.                                        *
   * ==================================================================== */

  function apiUrl(file, action) {
    var url = API_BASE.replace(/\/$/, "") + "/" + file;
    return action ? url + "?action=" + encodeURIComponent(action) : url;
  }

  function apiCall(file, action, body) {
    var options = {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    };
    if (body) {
      options.headers["Content-Type"] = "application/json";
      if (state.csrf) options.headers["X-CSRF-Token"] = state.csrf;
      options.body = JSON.stringify(body);
    }

    return window
      .fetch(apiUrl(file, action), options)
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            throw new Error(
              "The server replied with something that was not JSON (HTTP " +
                response.status +
                ")."
            );
          })
          .then(function (data) {
            if (!response.ok || !data || data.ok !== true) {
              var err = new Error(
                (data && (data.message || data.error)) ||
                  "Request failed with HTTP " + response.status
              );
              err.code = data && data.error;
              err.status = response.status;
              throw err;
            }
            return data;
          });
      });
  }

  function applyServerSettings(payload) {
    if (!payload) return;
    if (payload.default_fee_bp != null) {
      state.settings.defaultFeeBp = cleanBp(payload.default_fee_bp);
    }
    if (payload.registration_amount != null) {
      state.settings.registrationAmount = Math.round(
        Number(payload.registration_amount) || 0
      );
    }
    if (payload.gst_percent != null) {
      state.settings.gstPercent = Number(payload.gst_percent) || 0;
    }
  }

  var ServerBackend = {
    name: "server",

    probe: function () {
      return apiCall("auth.php", "me", null).then(function (data) {
        if (data.settings) applyServerSettings(data.settings);
        if (data.signed_in) {
          state.csrf = data.csrf || "";
          state.email = (data.admin && data.admin.email) || "";
        }
        return !!data.signed_in;
      });
    },

    login: function (email, password) {
      return apiCall("auth.php", "login", {
        email: email,
        password: password
      }).then(function (data) {
        state.csrf = data.csrf || "";
        state.email = (data.admin && data.admin.email) || email;
        if (data.settings) applyServerSettings(data.settings);
        return state.email;
      });
    },

    logout: function () {
      return apiCall("auth.php", "logout", {}).catch(function () {
        // A failed sign-out should still clear the screen.
      });
    },

    list: function () {
      return apiCall("candidates.php", "list", null).then(function (data) {
        if (data.settings) applyServerSettings(data.settings);
        state.candidates = (data.candidates || []).map(normaliseFromServer);
        return state.candidates;
      });
    },

    saveCandidate: function (candidate) {
      return apiCall("candidates.php", "save", toServerPayload(candidate)).then(
        function (data) {
          return normaliseFromServer(data.candidate);
        }
      );
    },

    deleteCandidate: function (id) {
      return apiCall("candidates.php", "delete", { id: id });
    },

    savePayments: function (candidate) {
      return apiCall("payments.php", "save", {
        candidateId: candidate.id,
        instalments: (candidate.emis || []).map(function (e) {
          return {
            n: e.n,
            paid: !!e.paid,
            paidAmount: Math.round(Number(e.paidAmount) || 0),
            paidDate: e.paidDate || null,
            dueDate: e.dueDate || null
          };
        })
      }).then(function (data) {
        if (data.emis) candidate.emis = data.emis.map(normaliseEmi);
        return candidate;
      });
    },

    saveSettings: function (settings) {
      return apiCall("settings.php", "save", settings).then(function (data) {
        applyServerSettings(data.settings);
        return data;
      });
    }
  };

  function normaliseEmi(e) {
    return {
      n: Number(e.n) || 0,
      amount: Math.round(Number(e.amount) || 0),
      dueDate: e.dueDate || "",
      paid: !!e.paid,
      paidAmount: Math.round(Number(e.paidAmount) || 0),
      paidDate: e.paidDate || ""
    };
  }

  function normaliseFromServer(c) {
    if (!c) return c;
    return {
      id: c.id,
      name: c.name || "",
      phone: c.phone || "",
      email: c.email || "",
      track: c.track || "",
      status: c.status || "training",
      admissionDate: c.admissionDate || "",
      registrationAmount: Math.round(Number(c.registrationAmount) || 0),
      registrationPaid: !!c.registrationPaid,
      registrationDate: c.registrationDate || "",
      employer: c.employer || "",
      joiningDate: c.joiningDate || "",
      firstSalaryDate: c.firstSalaryDate || "",
      ctc: Math.round(Number(c.ctc) || 0),
      feeBp: cleanBp(c.feeBp),
      emiCount: Number(c.emiCount) || 1,
      emiStart: c.emiStart || "",
      notes: c.notes || "",
      createdAt: c.createdAt || "",
      emis: (c.emis || []).map(normaliseEmi)
    };
  }

  function toServerPayload(c) {
    return {
      id: c.id || null,
      name: c.name,
      phone: c.phone,
      email: c.email,
      track: c.track,
      status: c.status,
      admissionDate: c.admissionDate,
      registrationPaid: !!c.registrationPaid,
      registrationDate: c.registrationDate,
      employer: c.employer,
      joiningDate: c.joiningDate,
      firstSalaryDate: c.firstSalaryDate,
      ctc: c.ctc,
      feeBp: cleanBp(c.feeBp),
      emiCount: c.emiCount,
      emiStart: c.emiStart,
      notes: c.notes
    };
  }

  var LocalBackend = {
    name: "local",

    probe: function () {
      return Promise.resolve(!!sessionStore.getItem(SESSION_KEY));
    },

    login: function (email, password) {
      if (
        email.toLowerCase() === ADMIN_EMAIL.toLowerCase() &&
        password === ADMIN_PASSWORD
      ) {
        sessionStore.setItem(SESSION_KEY, email);
        state.email = email;
        return Promise.resolve(email);
      }
      var err = new Error(
        "Those details don't match. The password is case-sensitive \u2014 tick " +
          "\u201cShow password\u201d to check what you typed."
      );
      return Promise.reject(err);
    },

    logout: function () {
      sessionStore.removeItem(SESSION_KEY);
      return Promise.resolve();
    },

    list: function () {
      readLocal();
      return Promise.resolve(state.candidates);
    },

    saveCandidate: function (candidate) {
      if (!candidate.id) {
        candidate.id = "c" + Date.now().toString(36) +
          Math.random().toString(36).slice(2, 7);
        candidate.createdAt = new Date().toISOString();
        state.candidates.push(candidate);
      }
      if (candidate.registrationAmount == null) {
        candidate.registrationAmount = state.settings.registrationAmount;
      }
      writeLocal();
      return Promise.resolve(candidate);
    },

    deleteCandidate: function (id) {
      state.candidates = state.candidates.filter(function (c) {
        return c.id !== id;
      });
      writeLocal();
      return Promise.resolve();
    },

    savePayments: function (candidate) {
      writeLocal();
      return Promise.resolve(candidate);
    },

    saveSettings: function (settings) {
      if (settings.feePercent != null) {
        state.settings.defaultFeeBp = bpFromPercent(settings.feePercent);
      }
      if (settings.registrationAmount != null) {
        state.settings.registrationAmount =
          Math.round(Number(settings.registrationAmount)) || 0;
      }
      if (settings.gstPercent != null) {
        state.settings.gstPercent = Number(settings.gstPercent) || 0;
      }
      writeLocal();
      return Promise.resolve({ settings: state.settings });
    }
  };

  function readLocal() {
    try {
      var raw = persistentStore.getItem(STORE_KEY);

      // Carry over anything saved by the pre-percentage version.
      if (!raw) {
        var legacy = persistentStore.getItem(LEGACY_KEY);
        if (legacy) {
          var old = JSON.parse(legacy);
          if (old && Array.isArray(old.candidates)) {
            state.candidates = old.candidates.map(function (c) {
              // Those records were all billed at a flat 10%.
              if (c.feeBp == null) c.feeBp = 1000;
              return c;
            });
            writeLocal();
            toast("Imported " + state.candidates.length +
              " record(s) saved by the earlier version.");
            return;
          }
        }
      }

      var settingsRaw = persistentStore.getItem(SETTINGS_KEY);
      if (settingsRaw) {
        var s = JSON.parse(settingsRaw);
        if (s && typeof s === "object") {
          if (s.defaultFeeBp != null) {
            state.settings.defaultFeeBp = cleanBp(s.defaultFeeBp);
          }
          if (s.registrationAmount != null) {
            state.settings.registrationAmount =
              Math.round(Number(s.registrationAmount)) || 0;
          }
          if (s.gstPercent != null) {
            state.settings.gstPercent = Number(s.gstPercent) || 0;
          }
        }
      }

      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.candidates)) {
        state.candidates = parsed.candidates;
      }
    } catch (err) {
      console.error("Could not read saved records:", err);
      toast("Saved records could not be read. Starting with an empty list.");
    }
  }

  function writeLocal() {
    try {
      persistentStore.setItem(
        STORE_KEY,
        JSON.stringify({
          version: 2,
          savedAt: new Date().toISOString(),
          candidates: state.candidates
        })
      );
      persistentStore.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch (err) {
      console.error("Could not save:", err);
      toast("Could not save. Browser storage may be full or blocked.");
    }
  }

  /** Whichever backend is in play. Reassigned during startup. */
  var backend = LocalBackend;

  function findCandidate(id) {
    for (var i = 0; i < state.candidates.length; i++) {
      /* eslint-disable-next-line eqeqeq */
      if (String(state.candidates[i].id) === String(id)) {
        return state.candidates[i];
      }
    }
    return null;
  }

  /* ==================================================================== *
   * Toast                                                                *
   * ==================================================================== */

  var toastTimer = null;
  function toast(message) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      el.hidden = true;
    }, 4500);
  }

  function describeError(err) {
    if (!err) return "Something went wrong.";
    if (err.status === 401 || err.code === "not_signed_in") {
      return "Your session expired. Sign in again.";
    }
    return err.message || String(err);
  }

  /* ==================================================================== *
   * Login                                                                *
   * ==================================================================== */

  function initLogin() {
    var screenEl = document.getElementById("login-screen");
    var appEl = document.getElementById("app");
    var form = document.getElementById("login-form");
    var error = document.getElementById("login-error");
    var who = document.getElementById("who-label");
    var submit = form.querySelector('button[type="submit"]');

    function enter(email) {
      screenEl.hidden = true;
      appEl.hidden = false;
      if (who) {
        who.textContent =
          "Signed in as " + email +
          (state.mode === "server" ? "" : " \u00b7 this browser only");
      }
      refresh();
    }

    function leave() {
      appEl.hidden = true;
      screenEl.hidden = false;
      state.candidates = [];
      document.getElementById("login-email").focus();
    }

    // Attached FIRST, before anything that could throw. If setup fails after
    // this point the worst case is cosmetic, rather than a form that submits
    // natively and reloads the page.
    form.addEventListener("submit", function (event) {
      event.preventDefault();

      var email = document.getElementById("login-email").value.trim();
      // Trimmed on purpose: copying a password drags whitespace along, and a
      // silent mismatch on an invisible character is miserable to debug.
      var password = document.getElementById("login-password").value.trim();

      if (!email || !password) {
        error.textContent = "Enter both your email and password.";
        return;
      }

      submit.disabled = true;
      error.textContent = "";

      backend
        .login(email, password)
        .then(function (signedInAs) {
          document.getElementById("login-password").value = "";
          enter(signedInAs || email);
        })
        .catch(function (err) {
          error.textContent = describeError(err);
          document.getElementById("login-password").select();
        })
        .then(function () {
          submit.disabled = false;
        });
    });

    var showToggle = document.getElementById("login-show");
    if (showToggle) {
      showToggle.addEventListener("change", function () {
        document.getElementById("login-password").type = showToggle.checked
          ? "text"
          : "password";
      });
    }

    document.getElementById("sign-out").addEventListener("click", function () {
      backend.logout().then(leave, leave);
    });

    if (storageBlocked && state.mode !== "server") {
      var warn = document.getElementById("login-storage-warn");
      if (warn) warn.hidden = false;
    }

    // Session restore last, so a failure cannot stop the form working.
    backend
      .probe()
      .then(function (signedIn) {
        if (signedIn) {
          enter(state.email || sessionStore.getItem(SESSION_KEY) || "admin");
        } else {
          screenEl.hidden = false;
          appEl.hidden = true;
        }
      })
      .catch(function () {
        screenEl.hidden = false;
        appEl.hidden = true;
      });
  }

  /* ==================================================================== *
   * Rendering                                                            *
   * ==================================================================== */

  function refresh() {
    return backend
      .list()
      .then(render)
      .catch(function (err) {
        toast(describeError(err));
        render();
      });
  }

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
      if (sort === "recent") {
        return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
      }
      return (a.name || "").localeCompare(b.name || "");
    });

    return list;
  }

  function statusBadge(status) {
    var map = {
      training: ["badge--training", "In training"],
      placed: ["badge--placed", "Placed"],
      withdrawn: ["badge--withdrawn", "Withdrawn"]
    };
    var pair = map[status] || map.training;
    return '<span class="badge ' + pair[0] + '">' + pair[1] + "</span>";
  }

  function renderTiles() {
    var all = state.candidates;
    var regCollected = all.reduce(function (sum, c) {
      return sum + (c.registrationPaid ? registrationAmountOf(c) : 0);
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

  function renderRateBadge() {
    var el = document.getElementById("rate-label");
    if (!el) return;
    el.textContent = percentFromBp(state.settings.defaultFeeBp) + "%";
    var modeEl = document.getElementById("mode-label");
    if (modeEl) {
      modeEl.textContent =
        state.mode === "server"
          ? "Saved to the server"
          : "Saved in this browser only";
      modeEl.className =
        "badge " + (state.mode === "server" ? "badge--placed" : "badge--due");
    }
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
          '<td class="num">' +
          (c.ctc
            ? money(fee) +
              '<small style="display:block;color:var(--ink-muted)">at ' +
              percentFromBp(bpOf(c)) + "%</small>"
            : "\u2014") +
          "</td>" +
          '<td class="num">' + (c.ctc ? money(paid) : "\u2014") + "</td>" +
          '<td class="num">' + pendingCell + "</td>" +
          "<td>" + emiLabel + "</td>" +
          '<td><div class="row-actions">' +
          '<button class="btn btn--sm btn--outline" type="button" data-edit="' +
          escapeHTML(c.id) + '">Edit</button>' +
          (c.ctc
            ? '<button class="btn btn--sm btn--secondary" type="button" data-pay="' +
              escapeHTML(c.id) + '">Payments</button>'
            : "") +
          "</div></td>" +
          "</tr>"
        );
      })
      .join("");
  }

  function render() {
    renderTiles();
    renderRateBadge();
    renderRows();
  }

  /* ==================================================================== *
   * Candidate dialog                                                     *
   * ==================================================================== */

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
      var el = document.getElementById(elId);
      if (el) el.value = value == null ? "" : value;
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
    v("f-rate", percentFromBp(c ? bpOf(c) : state.settings.defaultFeeBp));
    v("f-emi-count", String((c && c.emiCount) || 1));
    v("f-emi-start", (c && c.emiStart) || "");
    v("f-notes", c && c.notes);

    document.getElementById("f-name-error").textContent = "";
    document.getElementById("f-ctc-error").textContent = "";
    document.getElementById("f-rate-error").textContent = "";

    var hint = document.getElementById("f-rate-hint");
    if (hint) {
      hint.textContent =
        "Default is " + percentFromBp(state.settings.defaultFeeBp) +
        "%. Change it here for this candidate only.";
    }

    updateCalc();
    dialog.showModal();
    document.getElementById("f-name").focus();
  }

  function currentFormBp() {
    var raw = document.getElementById("f-rate").value.trim();
    if (raw === "") return state.settings.defaultFeeBp;
    return bpFromPercent(raw);
  }

  function updateCalc() {
    var ctc = Number(document.getElementById("f-ctc").value) || 0;
    var bp = currentFormBp();
    var fee = placementFeeFor(ctc, bp, state.settings.gstPercent);
    var count = Number(document.getElementById("f-emi-count").value) || 1;
    var registration = state.settings.registrationAmount;

    document.getElementById("calc-ctc").textContent = money(ctc);
    document.getElementById("calc-fee").textContent = money(fee);
    document.getElementById("calc-rate").textContent =
      percentFromBp(bp) + "% of CTC";
    document.getElementById("calc-reg").textContent = money(registration);
    document.getElementById("calc-total").textContent = money(registration + fee);

    var gstNote = document.getElementById("calc-gst");
    if (gstNote) {
      gstNote.textContent = state.settings.gstPercent
        ? "Includes " + state.settings.gstPercent + "% GST."
        : "No GST applied.";
    }

    var preview = document.getElementById("emi-preview");
    if (!fee) {
      preview.textContent = "Enter a CTC to see the instalment split.";
      return;
    }
    var parts = splitAmount(fee, count);
    if (count === 1) {
      preview.textContent = "One payment of " + money(parts[0]) + ".";
    } else {
      var allSame = parts.every(function (p) {
        return p === parts[0];
      });
      preview.textContent =
        count + " instalments: " +
        parts.slice(0, 3).map(money).join(" + ") +
        (count > 3 ? " + \u2026" : "") +
        " (" +
        (allSame
          ? money(parts[0]) + " each"
          : "instalment 1 carries the rounding") +
        ").";
    }
  }

  function saveCandidate(event) {
    event.preventDefault();

    var name = document.getElementById("f-name").value.trim();
    var nameError = document.getElementById("f-name-error");
    var ctcRaw = document.getElementById("f-ctc").value.trim();
    var ctcError = document.getElementById("f-ctc-error");
    var rateRaw = document.getElementById("f-rate").value.trim();
    var rateError = document.getElementById("f-rate-error");
    var submit = document.getElementById("save-candidate");

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

    if (rateRaw !== "") {
      var pct = Number(rateRaw);
      if (isNaN(pct) || pct < 0 || pct > 100) {
        rateError.textContent = "Enter a rate between 0 and 100, for example 10.";
        document.getElementById("f-rate").focus();
        return;
      }
    }
    rateError.textContent = "";

    var existing = editingId ? findCandidate(editingId) : null;
    var isNew = !existing;
    var candidate = existing || { emis: [] };

    candidate.name = name;
    candidate.phone = document.getElementById("f-phone").value.trim();
    candidate.email = document.getElementById("f-email").value.trim();
    candidate.track = document.getElementById("f-track").value;
    candidate.admissionDate = document.getElementById("f-admission").value;
    candidate.status = document.getElementById("f-status").value;
    candidate.registrationPaid = document.getElementById("f-reg-paid").checked;
    candidate.registrationDate = document.getElementById("f-reg-date").value;
    candidate.employer = document.getElementById("f-employer").value.trim();
    candidate.joiningDate = document.getElementById("f-joining").value;
    candidate.firstSalaryDate = document.getElementById("f-first-salary").value;
    candidate.ctc = ctcRaw ? Math.round(Number(ctcRaw)) : 0;
    candidate.feeBp = currentFormBp();
    candidate.notes = document.getElementById("f-notes").value.trim();
    if (candidate.registrationAmount == null) {
      candidate.registrationAmount = state.settings.registrationAmount;
    }

    var count = Number(document.getElementById("f-emi-count").value) || 1;
    var start = document.getElementById("f-emi-start").value;

    if (candidate.ctc > 0) {
      buildSchedule(candidate, count, start);
    } else {
      candidate.emis = [];
      candidate.emiCount = count;
    }

    submit.disabled = true;

    backend
      .saveCandidate(candidate)
      .then(function () {
        return backend.list();
      })
      .then(function () {
        render();
        document.getElementById("candidate-dialog").close();
        var saved = findCandidate(candidate.id) || candidate;
        toast(
          name + (isNew ? " added." : " updated.") +
            (saved.ctc
              ? " Fee " + money(feeOf(saved)) +
                " at " + percentFromBp(bpOf(saved)) + "%."
              : "")
        );
      })
      .catch(function (err) {
        toast(describeError(err));
      })
      .then(function () {
        submit.disabled = false;
      });
  }

  function deleteCandidate() {
    if (!editingId) return;
    var c = findCandidate(editingId);
    if (!c) return;

    var ok = window.confirm(
      "Delete " + (c.name || "this candidate") +
        " and all recorded payments? This cannot be undone."
    );
    if (!ok) return;

    backend
      .deleteCandidate(c.id)
      .then(function () {
        return backend.list();
      })
      .then(function () {
        render();
        document.getElementById("candidate-dialog").close();
        toast((c.name || "Candidate") + " deleted.");
      })
      .catch(function (err) {
        toast(describeError(err));
      });
  }

  /* ==================================================================== *
   * Payments dialog                                                      *
   * ==================================================================== */

  var payingId = null;

  function openPayments(id) {
    var c = findCandidate(id);
    if (!c) return;
    payingId = id;

    document.getElementById("ed-title").textContent =
      "Payments \u2014 " + (c.name || "candidate");
    document.getElementById("ed-sub").textContent =
      "CTC " + money(c.ctc) +
      " \u00b7 " + percentFromBp(bpOf(c)) + "% = " + money(feeOf(c)) +
      " \u00b7 " + (c.emis || []).length +
      ((c.emis || []).length === 1 ? " payment" : " instalments");

    renderPaymentRows(c);
    document.getElementById("emi-dialog").showModal();
  }

  function renderPaymentRows(c) {
    var tbody = document.getElementById("emi-rows");
    tbody.innerHTML = (c.emis || [])
      .map(function (e, i) {
        return (
          '<tr class="' + (e.paid ? "is-paid" : "") + '">' +
          "<td>" + e.n + "</td>" +
          '<td><input type="date" data-field="dueDate" data-i="' + i +
          '" value="' + escapeHTML(e.dueDate) +
          '" aria-label="Due date for instalment ' + e.n + '"></td>' +
          '<td class="num">' + money(e.amount) + "</td>" +
          '<td class="paid-cell"><input type="checkbox" data-field="paid" data-i="' +
          i + '"' + (e.paid ? " checked" : "") +
          ' aria-label="Instalment ' + e.n + ' paid"></td>' +
          '<td><input type="number" min="0" step="1" data-field="paidAmount" data-i="' +
          i + '" value="' +
          (e.paid ? Math.round(Number(e.paidAmount) || e.amount) : "") +
          '" aria-label="Amount received for instalment ' + e.n + '"></td>' +
          '<td><input type="date" data-field="paidDate" data-i="' + i +
          '" value="' + escapeHTML(e.paidDate) +
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
      if (!c) return;
      var button = document.getElementById("emi-save");
      button.disabled = true;

      backend
        .savePayments(c)
        .then(function () {
          return backend.list();
        })
        .then(function () {
          render();
          document.getElementById("emi-dialog").close();
          var fresh = findCandidate(payingId) || c;
          var pending = pendingOf(fresh);
          toast(
            pending === 0
              ? (fresh.name || "Candidate") + " is fully paid up."
              : money(pending) + " still pending for " +
                (fresh.name || "candidate") + "."
          );
        })
        .catch(function (err) {
          toast(describeError(err));
        })
        .then(function () {
          button.disabled = false;
        });
    });
  }

  /* ==================================================================== *
   * Settings dialog — where the percentage is changed                    *
   * ==================================================================== */

  function openSettings() {
    document.getElementById("s-rate").value = percentFromBp(
      state.settings.defaultFeeBp
    );
    document.getElementById("s-registration").value =
      state.settings.registrationAmount;
    document.getElementById("s-gst").value = state.settings.gstPercent;
    document.getElementById("s-error").textContent = "";
    document.getElementById("settings-dialog").showModal();
  }

  function initSettingsDialog() {
    var openBtn = document.getElementById("open-settings");
    if (openBtn) openBtn.addEventListener("click", openSettings);

    document
      .getElementById("settings-form")
      .addEventListener("submit", function (event) {
        event.preventDefault();

        var rate = document.getElementById("s-rate").value.trim();
        var registration = document.getElementById("s-registration").value.trim();
        var gst = document.getElementById("s-gst").value.trim();
        var error = document.getElementById("s-error");
        var button = document.getElementById("save-settings");

        var pct = Number(rate);
        if (rate === "" || isNaN(pct) || pct < 0 || pct > 100) {
          error.textContent =
            "Enter the fee rate as a number between 0 and 100, for example 10 or 12.5.";
          return;
        }
        var reg = Number(registration);
        if (registration === "" || isNaN(reg) || reg < 0) {
          error.textContent = "Enter the registration amount in rupees.";
          return;
        }
        var gstNum = Number(gst);
        if (gst === "" || isNaN(gstNum) || gstNum < 0 || gstNum > 100) {
          error.textContent = "Enter GST as a number between 0 and 100.";
          return;
        }
        error.textContent = "";
        button.disabled = true;

        backend
          .saveSettings({
            feePercent: rate,
            registrationAmount: reg,
            gstPercent: gstNum
          })
          .then(function () {
            return backend.list();
          })
          .then(function () {
            render();
            document.getElementById("settings-dialog").close();
            toast(
              "Default fee rate is now " +
                percentFromBp(state.settings.defaultFeeBp) +
                "%. Existing candidates keep their own rate."
            );
          })
          .catch(function (err) {
            error.textContent = describeError(err);
          })
          .then(function () {
            button.disabled = false;
          });
      });
  }

  /* ==================================================================== *
   * Export / import                                                      *
   * ==================================================================== */

  function initBackup() {
    document.getElementById("export").addEventListener("click", function () {
      var payload = {
        exportedAt: new Date().toISOString(),
        version: 2,
        mode: state.mode,
        settings: state.settings,
        candidates: state.candidates
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json"
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

          var incoming = data.candidates.map(function (c) {
            if (c.feeBp == null) c.feeBp = 1000; // older exports were flat 10%
            return c;
          });

          if (state.mode === "server") {
            var proceed = window.confirm(
              "Upload " + incoming.length +
                " record(s) from this file to the server?\n\n" +
                "Records already on the server are left alone; these are added " +
                "as new entries."
            );
            if (!proceed) {
              fileInput.value = "";
              return;
            }
            var chain = Promise.resolve();
            incoming.forEach(function (c) {
              chain = chain.then(function () {
                var copy = JSON.parse(JSON.stringify(c));
                delete copy.id;
                return backend.saveCandidate(copy);
              });
            });
            chain
              .then(function () {
                return backend.list();
              })
              .then(function () {
                render();
                toast("Uploaded " + incoming.length + " record(s) to the server.");
              })
              .catch(function (err) {
                toast(describeError(err));
              });
          } else {
            var replace = window.confirm(
              "That file holds " + incoming.length + " candidate record(s).\n\n" +
                "OK replaces your current " + state.candidates.length +
                " record(s).\nCancel merges them in instead, keeping both."
            );
            if (replace) {
              state.candidates = incoming;
            } else {
              var seen = {};
              state.candidates.forEach(function (c) {
                seen[c.id] = true;
              });
              incoming.forEach(function (c) {
                if (seen[c.id]) {
                  c.id = "c" + Date.now().toString(36) +
                    Math.random().toString(36).slice(2, 7);
                }
                state.candidates.push(c);
              });
            }
            if (data.settings) {
              if (data.settings.defaultFeeBp != null) {
                state.settings.defaultFeeBp = cleanBp(data.settings.defaultFeeBp);
              }
              if (data.settings.registrationAmount != null) {
                state.settings.registrationAmount =
                  Math.round(Number(data.settings.registrationAmount)) || 0;
              }
            }
            writeLocal();
            render();
            toast(
              (replace ? "Replaced with " : "Merged in ") +
                incoming.length + " record(s)."
            );
          }
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

  /* ==================================================================== *
   * Wiring                                                               *
   * ==================================================================== */

  function step(name, fn) {
    try {
      fn();
    } catch (err) {
      console.error("admin dashboard: " + name + " failed to initialise", err);
    }
  }

  function initControls() {
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

    document
      .getElementById("candidate-form")
      .addEventListener("submit", saveCandidate);
    document
      .getElementById("delete-candidate")
      .addEventListener("click", deleteCandidate);

    document.getElementById("f-ctc").addEventListener("input", updateCalc);
    document.getElementById("f-rate").addEventListener("input", updateCalc);
    document.getElementById("f-emi-count").addEventListener("change", updateCalc);

    document
      .getElementById("f-first-salary")
      .addEventListener("change", function () {
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

  /**
   * Decide which backend to use. If an API is configured and answers, use it;
   * otherwise fall back to the browser and say so plainly rather than looking
   * like it saved something it did not.
   */
  function chooseBackend() {
    if (!API_BASE || typeof window.fetch !== "function") {
      backend = LocalBackend;
      state.mode = "local";
      return Promise.resolve();
    }

    return apiCall("auth.php", "me", null)
      .then(function (data) {
        backend = ServerBackend;
        state.mode = "server";
        if (data.settings) applyServerSettings(data.settings);
      })
      .catch(function () {
        backend = LocalBackend;
        state.mode = "local";
        var note = document.getElementById("login-server-warn");
        if (note) note.hidden = false;
      });
  }

  function init() {
    step("payments dialog", initPaymentsDialog);
    step("settings dialog", initSettingsDialog);
    step("backup", initBackup);
    step("controls", initControls);

    chooseBackend().then(function () {
      step("local data", function () {
        if (state.mode === "local") readLocal();
      });
      step("login", initLogin);
      step("rate badge", renderRateBadge);
      window.__adminReady = true;
    });
  }

  // Exposed so the arithmetic can be checked from the console.
  window.TalentisFees = {
    placementFee: placementFeeFor,
    splitAmount: splitAmount,
    bpFromPercent: bpFromPercent,
    percentFromBp: percentFromBp,
    state: state
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
