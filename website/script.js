// CrabDuino marketing site — vanilla JS, no dependencies.
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = matchMedia("(pointer: fine)").matches;

  /* ---- nav: shrink on scroll + mobile toggle ----------------------------- */
  const nav = $("#nav");
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 12);
  onScroll();
  addEventListener("scroll", onScroll, { passive: true });

  $("#navToggle").addEventListener("click", () => nav.classList.toggle("open"));
  $$("#navLinks a").forEach((a) =>
    a.addEventListener("click", () => nav.classList.remove("open"))
  );

  /* ---- reveal on scroll -------------------------------------------------- */
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
  );
  $$(".reveal").forEach((el) => io.observe(el));

  /* ---- pointer-following glow ------------------------------------------- */
  if (finePointer && !reduceMotion) {
    const glow = $(".cursor-glow");
    let tx = 0,
      ty = 0,
      cx = 0,
      cy = 0,
      raf = 0;
    addEventListener(
      "pointermove",
      (e) => {
        tx = e.clientX;
        ty = e.clientY;
        glow.style.opacity = "1";
        if (!raf) raf = requestAnimationFrame(tick);
      },
      { passive: true }
    );
    const tick = () => {
      cx += (tx - cx) * 0.16;
      cy += (ty - cy) * 0.16;
      glow.style.transform = `translate(${cx}px, ${cy}px)`;
      raf = Math.abs(tx - cx) + Math.abs(ty - cy) > 0.5
        ? requestAnimationFrame(tick)
        : 0;
    };
  }

  /* ---- card spotlight + subtle 3D tilt ---------------------------------- */
  if (finePointer && !reduceMotion) {
    $$(".card").forEach((card) => {
      card.addEventListener("pointermove", (e) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty("--mx", `${e.clientX - r.left}px`);
        card.style.setProperty("--my", `${e.clientY - r.top}px`);
      });
    });

    $$("[data-tilt]").forEach((el) => {
      el.style.transformStyle = "preserve-3d";
      el.style.transition = "transform 0.2s ease";
      el.addEventListener("pointermove", (e) => {
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        el.style.transform = `perspective(900px) rotateY(${px * 5}deg) rotateX(${-py * 5}deg)`;
      });
      el.addEventListener("pointerleave", () => {
        el.style.transform = "";
      });
    });
  }

  /* ---- hero: animated build/flash output + LED blink --------------------- */
  const termBody = $("#termBody");
  const led = $("#boardLed");
  const lines = [
    { cls: "t-info", text: "$ cargo build --release" },
    { cls: "t-out", text: "   Compiling firmware v0.1.0" },
    { cls: "t-ok", text: "Finished release in 2.4s" },
    { cls: "t-info", text: "$ cargo run --release  (ravedude)" },
    { cls: "t-ok", text: "Programmed /dev/ttyACM0 — running!" },
  ];

  function typeOutput() {
    termBody.innerHTML = "";
    led.classList.remove("on");
    lines.forEach((ln, i) => {
      setTimeout(() => {
        const div = document.createElement("div");
        div.className = `t-line ${ln.cls}`;
        div.textContent = ln.text;
        termBody.appendChild(div);
        if (i === lines.length - 1) startBlink();
      }, reduceMotion ? 0 : 600 * (i + 1));
    });
  }

  let blinkTimer = null;
  function startBlink() {
    if (reduceMotion) {
      led.classList.add("on");
      return;
    }
    clearInterval(blinkTimer);
    blinkTimer = setInterval(() => led.classList.toggle("on"), 500);
  }

  if (termBody) {
    // Run once it scrolls into view, then loop the demo every so often.
    const heroIO = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          typeOutput();
          if (!reduceMotion) setInterval(typeOutput, 9000);
          heroIO.disconnect();
        }
      },
      { threshold: 0.4 }
    );
    heroIO.observe(termBody);
  }

  /* ---- year in footer (kept current automatically) ---------------------- */
  const fine = $(".footer-fine");
  if (fine) fine.innerHTML = fine.innerHTML.replace("2026", new Date().getFullYear());
})();
