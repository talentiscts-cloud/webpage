/* ==========================================================================
   Talentis Consultancy — shared behaviours
   Progressive enhancement only: every page is readable and usable with JS off.
   The callback forms validate here, then submit to the Hostinger API, and only
   report success once the server confirms the enquiry was stored.
   ========================================================================== */
(function () {
  "use strict";

  /* --- Mobile navigation ------------------------------------------------- */
  function initNav() {
    var toggle = document.querySelector("[data-nav-toggle]");
    var nav = document.getElementById("primary-nav");
    if (!toggle || !nav) return;

    function setOpen(open) {
      nav.classList.toggle("is-open", open);
      toggle.setAttribute("aria-expanded", String(open));
    }

    toggle.addEventListener("click", function () {
      setOpen(toggle.getAttribute("aria-expanded") !== "true");
    });

    // Close on Escape and return focus to the toggle.
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && nav.classList.contains("is-open")) {
        setOpen(false);
        toggle.focus();
      }
    });

    // Reset state when moving up to the desktop layout.
    var wide = window.matchMedia("(min-width: 920px)");
    var onChange = function (event) {
      if (event.matches) setOpen(false);
    };
    if (typeof wide.addEventListener === "function") {
      wide.addEventListener("change", onChange);
    } else if (typeof wide.addListener === "function") {
      wide.addListener(onChange);
    }
  }

  /* --- Accordions -------------------------------------------------------- */
  function initAccordions() {
    var triggers = document.querySelectorAll("[data-accordion-trigger]");
    Array.prototype.forEach.call(triggers, function (trigger) {
      var panel = document.getElementById(
        trigger.getAttribute("aria-controls")
      );
      if (!panel) return;

      // Collapse everything not explicitly marked as open in the markup.
      var startOpen = trigger.getAttribute("aria-expanded") === "true";
      panel.hidden = !startOpen;

      trigger.addEventListener("click", function () {
        var isOpen = trigger.getAttribute("aria-expanded") === "true";
        trigger.setAttribute("aria-expanded", String(!isOpen));
        panel.hidden = isOpen;
      });
    });
  }

  /* --- Testimonial deck -------------------------------------------------- */
  function initQuoteDeck() {
    var deck = document.querySelector("[data-quote-deck]");
    if (!deck) return;

    var quotes = deck.querySelectorAll("[data-quote]");
    var dots = deck.querySelectorAll("[data-quote-dot]");
    if (quotes.length < 2 || dots.length !== quotes.length) return;

    var current = 0;
    var timer = null;
    var reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    function show(index) {
      current = (index + quotes.length) % quotes.length;
      Array.prototype.forEach.call(quotes, function (quote, i) {
        quote.hidden = i !== current;
      });
      Array.prototype.forEach.call(dots, function (dot, i) {
        dot.setAttribute("aria-selected", String(i === current));
      });
    }

    function stop() {
      if (timer) {
        window.clearInterval(timer);
        timer = null;
      }
    }

    function start() {
      if (reduceMotion) return;
      stop();
      timer = window.setInterval(function () {
        show(current + 1);
      }, 7000);
    }

    Array.prototype.forEach.call(dots, function (dot, i) {
      dot.addEventListener("click", function () {
        show(i);
        start();
      });
    });

    // Pause rotation while the visitor is reading or tabbing through.
    deck.addEventListener("mouseenter", stop);
    deck.addEventListener("mouseleave", start);
    deck.addEventListener("focusin", stop);
    deck.addEventListener("focusout", start);

    show(0);
    start();
  }

  /* --- Success-story filter --------------------------------------------- */
  function initStoryFilter() {
    var bar = document.querySelector("[data-filter-bar]");
    var grid = document.querySelector("[data-filter-grid]");
    if (!bar || !grid) return;

    var buttons = bar.querySelectorAll("button[data-filter]");
    var items = grid.querySelectorAll("[data-track]");
    var empty = document.querySelector("[data-filter-empty]");
    var live = document.querySelector("[data-filter-count]");

    function apply(value) {
      var shown = 0;
      Array.prototype.forEach.call(items, function (item) {
        var match = value === "all" || item.getAttribute("data-track") === value;
        item.hidden = !match;
        if (match) shown++;
      });
      Array.prototype.forEach.call(buttons, function (button) {
        button.setAttribute(
          "aria-pressed",
          String(button.getAttribute("data-filter") === value)
        );
      });
      if (empty) empty.hidden = shown !== 0;
      if (live) {
        live.textContent =
          shown + (shown === 1 ? " story shown" : " stories shown");
      }
    }

    Array.prototype.forEach.call(buttons, function (button) {
      button.addEventListener("click", function () {
        apply(button.getAttribute("data-filter"));
      });
    });

    apply("all");
  }

  /* --- Form validation --------------------------------------------------- */
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var PHONE_RE = /^[0-9+()\-\s]{8,18}$/;

  function fieldError(field) {
    var value = (field.value || "").trim();
    var label = field.getAttribute("data-label") || "This field";

    if (field.type === "checkbox") {
      return field.required && !field.checked
        ? "Please tick this box to continue."
        : "";
    }
    if (field.required && !value) {
      return label + " is required.";
    }
    if (!value) return "";
    if (field.type === "email" && !EMAIL_RE.test(value)) {
      return "Enter a valid email address, for example name@company.com.";
    }
    if (field.type === "tel" && !PHONE_RE.test(value)) {
      return "Enter a valid phone number (digits, spaces, + and - only).";
    }
    if (field.tagName === "TEXTAREA" && value.length < 15) {
      return "Please add a little more detail (at least 15 characters).";
    }
    return "";
  }

  function showError(field, message) {
    var slot = document.getElementById(field.id + "-error");
    if (message) {
      field.setAttribute("aria-invalid", "true");
      if (slot) {
        slot.textContent = message;
        field.setAttribute("aria-describedby", slot.id);
      }
    } else {
      field.removeAttribute("aria-invalid");
      if (slot) slot.textContent = "";
    }
  }

  function initForms() {
    var forms = document.querySelectorAll("form[data-validate]");
    Array.prototype.forEach.call(forms, function (form) {
      var fields = form.querySelectorAll("input, select, textarea");
      var status = form.querySelector("[data-form-status]");

      Array.prototype.forEach.call(fields, function (field) {
        field.addEventListener("blur", function () {
          showError(field, fieldError(field));
        });
        field.addEventListener("input", function () {
          if (field.getAttribute("aria-invalid") === "true") {
            showError(field, fieldError(field));
          }
        });
      });

      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var firstInvalid = null;

        Array.prototype.forEach.call(fields, function (field) {
          var message = fieldError(field);
          showError(field, message);
          if (message && !firstInvalid) firstInvalid = field;
        });

        if (!status) return;

        if (firstInvalid) {
          status.className = "form__status form__status--error";
          status.textContent =
            "Some details need attention. Please review the highlighted fields.";
          firstInvalid.focus();
          return;
        }

        // Forms without a data-kind are not wired to the server.
        var kind = form.getAttribute("data-kind");
        if (!kind) {
          status.className = "form__status form__status--ok";
          status.textContent =
            form.getAttribute("data-success-message") || "Thanks.";
          return;
        }

        sendEnquiry(form, kind, fields, status);
      });
    });
  }

  /* --- Sending an enquiry ------------------------------------------------ */

  /**
   * Where the callback forms submit. The website is on GitHub Pages and the
   * database is on Hostinger, so this is a cross-site request; the server only
   * accepts it from mytalentis.in.
   */
  var ENQUIRY_ENDPOINT = "https://admin.mytalentis.in/api/enquire.php";

  var FALLBACK_CONTACT =
    "Please try again in a moment, or email hello@mytalentis.in.";

  function collectPayload(form, kind) {
    var payload = { kind: kind, page: window.location.pathname };
    var elements = form.elements;
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (!el.name || el.disabled) continue;
      if (el.type === "checkbox") {
        payload[el.name] = el.checked;
      } else if (el.type !== "submit" && el.type !== "button") {
        payload[el.name] = (el.value || "").trim();
      }
    }
    return payload;
  }

  function setBusy(form, busy) {
    var button = form.querySelector('button[type="submit"]');
    if (!button) return;
    if (busy) {
      button.setAttribute("data-label", button.textContent);
      button.textContent = "Sending\u2026";
      button.disabled = true;
    } else {
      button.textContent = button.getAttribute("data-label") || button.textContent;
      button.disabled = false;
    }
    form.setAttribute("aria-busy", busy ? "true" : "false");
  }

  function sendEnquiry(form, kind, fields, status) {
    var endpoint = form.getAttribute("data-endpoint") || ENQUIRY_ENDPOINT;
    var payload = collectPayload(form, kind);

    status.className = "form__status";
    status.textContent = "Sending your request\u2026";
    setBusy(form, true);

    // Give up after 20 seconds rather than leave someone staring at a spinner.
    var controller = "AbortController" in window ? new AbortController() : null;
    var timer = window.setTimeout(function () {
      if (controller) controller.abort();
    }, 20000);

    window
      .fetch(endpoint, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller ? controller.signal : undefined
      })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return { ok: false };
          })
          .then(function (data) {
            return { http: response.status, data: data || {} };
          });
      })
      .then(function (result) {
        var data = result.data;

        if (data.ok === true) {
          // Only now, with the server's confirmation in hand, tell the visitor
          // their request is in.
          status.className = "form__status form__status--ok";
          status.textContent =
            data.message ||
            form.getAttribute("data-success-message") ||
            "Thanks. Your request is in.";
          form.reset();
          Array.prototype.forEach.call(fields, function (field) {
            showError(field, "");
          });
          return;
        }

        // The server named a field it did not like: show it against that field.
        if (data.field) {
          var target = form.querySelector('[name="' + data.field + '"]');
          if (target) {
            showError(target, data.message || "Please check this field.");
            target.focus();
          }
        }

        status.className = "form__status form__status--error";
        status.textContent =
          data.message ||
          "We couldn't send your request just now. " + FALLBACK_CONTACT;
      })
      .catch(function () {
        // Network failure or timeout. Their typing is kept so they can retry.
        status.className = "form__status form__status--error";
        status.textContent =
          "We couldn't reach our server, so your request has not been sent. " +
          FALLBACK_CONTACT;
      })
      .then(function () {
        window.clearTimeout(timer);
        setBusy(form, false);
      });
  }

  /* --- Footer year ------------------------------------------------------- */
  function initYear() {
    var slots = document.querySelectorAll("[data-year]");
    var year = String(new Date().getFullYear());
    Array.prototype.forEach.call(slots, function (slot) {
      slot.textContent = year;
    });
  }

  function init() {
    initNav();
    initAccordions();
    initQuoteDeck();
    initStoryFilter();
    initForms();
    initYear();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
