/* ==========================================================================
   Talentis Consultancy — shared behaviours
   Progressive enhancement only: every page is readable and usable with JS off.
   No backend yet, so form submissions are validated and acknowledged locally.
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

        // Front end only for now: wire this to the CRM or mail endpoint later.
        status.className = "form__status form__status--ok";
        status.textContent =
          form.getAttribute("data-success-message") ||
          "Thanks. Your enquiry has been recorded and our team will reply within one working day.";
        form.reset();
        Array.prototype.forEach.call(fields, function (field) {
          showError(field, "");
        });
      });
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
