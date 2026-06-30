/*
 * AquaRestore — "vacuum sucks up the water" intro gate prototype.
 *
 * A fixed full-viewport overlay of clean blue water sits on top of the real
 * (dummy) site. The visitor drags a vacuum nozzle to suck the water away
 * (scratch-to-reveal via canvas `destination-out`). At ~50% cleared the rest
 * auto-drains and the gate tears down, revealing the live page beneath.
 *
 * One self-contained IIFE. Internal "modules" are plain namespaces sharing the
 * closure: Config, State, Water, Progress, Particles, Hose, Nozzle, FX, Loop.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ Config */
  var Config = {
    CLEAR_THRESHOLD: 0.5, // fraction cleared that triggers the drain finale
    BRUSH_RADIUS: 72, // css px, soft erase radius
    BRUSH_SPACING: 22, // css px between interpolated dabs on a drag
    BRUSH_SOFT: 0.45, // inner solid stop of the brush gradient (0..1)
    SAMPLE_MS: 180, // progress sampling interval
    SAMPLE_W: 80,
    SAMPLE_H: 50,
    ALPHA_CLEARED: 110, // mask alpha at/below which a pixel counts as cleared
    MAX_PARTICLES: 90,
    SPAWN_PER_FRAME: 3,
    PARTICLE_LIFE: 720, // ms
    ATTRACT: 2600, // suction strength toward the nozzle
    ATTRACT_K: 36, // softening so accel stays finite at the nozzle
    SWIRL: 0.32, // perpendicular curve factor for particle paths
    DRAIN_MS: 1150,
    SAG_BASE: 130, // hose droop in px
    MAX_DPR: 2,
    VIBRATE_MS: 7,
    STORAGE_KEY: "aquaGateDone",
  };

  /* ------------------------------------------------------------- DOM handles */
  var gate = document.querySelector("[data-gate]");
  if (!gate) return;

  var canvas = gate.querySelector("[data-water]");
  var nozzleEl = gate.querySelector("[data-nozzle]");
  var vacuumEl = gate.querySelector("[data-vacuum]");
  var gaugeFill = gate.querySelector("[data-gauge-fill]");
  var skipBtn = gate.querySelector("[data-skip]");
  var soundBtn = gate.querySelector("[data-sound]");
  var soundLabel = gate.querySelector("[data-sound-label]");

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var alreadyDone = false;
  try {
    alreadyDone = window.sessionStorage.getItem(Config.STORAGE_KEY) === "1";
  } catch (e) {
    /* sessionStorage may throw in private mode — treat as not-done */
  }

  /* If the visitor can't or shouldn't play, never build the gate. */
  if (reduceMotion || alreadyDone) {
    teardownImmediate();
    return;
  }

  /* ------------------------------------------------------------------- State */
  var State = {
    phase: "idle", // idle -> playing -> draining -> done
    pointerDown: false,
    nozzle: { x: -999, y: -999 }, // current css-px pointer/nozzle position
    lastDab: null, // last dab point for segment interpolation
    moving: false, // nozzle moved this frame (drives spawn + glow)
    cleared: 0, // 0..1 fraction cleared (from Progress)
  };

  /* ---------------------------------------------------------------- Geometry */
  var dpr = 1;
  var W = 0; // css px width
  var H = 0; // css px height
  var ctx = canvas.getContext("2d");

  // Offscreen layers.
  var waterCanvas = document.createElement("canvas"); // painted water texture
  var waterCtx = waterCanvas.getContext("2d");
  var shimmerCanvas = document.createElement("canvas"); // animated caustics strip
  var shimmerCtx = shimmerCanvas.getContext("2d");
  var maskCanvas = document.createElement("canvas"); // accumulates erased area
  var maskCtx = maskCanvas.getContext("2d");
  var sampleCanvas = document.createElement("canvas"); // tiny downscaled sampler
  var sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
  sampleCanvas.width = Config.SAMPLE_W;
  sampleCanvas.height = Config.SAMPLE_H;

  /* --------------------------------------------------------- Water + shimmer */
  var Water = {
    buildTexture: function () {
      var c = waterCtx;
      waterCanvas.width = Math.max(1, Math.round(W * dpr));
      waterCanvas.height = Math.max(1, Math.round(H * dpr));
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, H);

      // Base clean-blue gradient. Near-opaque so the site stays hidden until
      // the water is vacuumed away, but with a hair of translucency for depth.
      var g = c.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, "rgba(26, 146, 222, 0.985)");
      g.addColorStop(0.5, "rgba(13, 116, 206, 0.985)");
      g.addColorStop(1, "rgba(7, 88, 172, 0.99)");
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);

      // Depth pools — a few soft radial highlights/darks (deterministic).
      var pools = [
        [0.2, 0.28, 0.42, "rgba(120, 214, 255, 0.30)"],
        [0.78, 0.22, 0.36, "rgba(150, 226, 255, 0.26)"],
        [0.62, 0.74, 0.5, "rgba(4, 58, 116, 0.34)"],
        [0.32, 0.82, 0.4, "rgba(5, 66, 130, 0.28)"],
      ];
      for (var i = 0; i < pools.length; i++) {
        var p = pools[i];
        var r = p[2] * Math.max(W, H);
        var rg = c.createRadialGradient(p[0] * W, p[1] * H, 0, p[0] * W, p[1] * H, r);
        rg.addColorStop(0, p[3]);
        rg.addColorStop(1, "rgba(0,0,0,0)");
        c.fillStyle = rg;
        c.fillRect(0, 0, W, H);
      }

      // A top sheen so the surface reads as wet/glossy.
      var sheen = c.createLinearGradient(0, 0, 0, H * 0.4);
      sheen.addColorStop(0, "rgba(255,255,255,0.16)");
      sheen.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = sheen;
      c.fillRect(0, 0, W, H * 0.4);
    },

    buildShimmer: function () {
      // A horizontal caustics strip (2x width) scrolled each frame for movement.
      var sw = Math.max(2, Math.round(W * 2 * dpr));
      var sh = Math.max(1, Math.round(H * dpr));
      shimmerCanvas.width = sw;
      shimmerCanvas.height = sh;
      var c = shimmerCtx;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W * 2, H);
      c.lineWidth = 2;
      // Wavy light streaks.
      for (var s = 0; s < 26; s++) {
        var baseY = (s / 26) * H;
        var amp = 8 + ((s * 37) % 22);
        var phase = (s * 53) % 360;
        c.beginPath();
        for (var x = 0; x <= W * 2; x += 14) {
          var y = baseY + Math.sin((x / 60) + (phase * Math.PI) / 180) * amp;
          if (x === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        }
        c.strokeStyle = "rgba(190, 236, 255, " + (0.04 + (s % 3) * 0.018) + ")";
        c.stroke();
      }
    },

    // Soft round dab stamped into the mask (white = erased area).
    stampMask: function (x, y, radius) {
      var c = maskCtx;
      var grd = c.createRadialGradient(x, y, radius * Config.BRUSH_SOFT, x, y, radius);
      grd.addColorStop(0, "rgba(255,255,255,1)");
      grd.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = grd;
      c.beginPath();
      c.arc(x, y, radius, 0, Math.PI * 2);
      c.fill();
    },

    // Erase along the segment from a->b so fast drags leave no gaps.
    eraseSegment: function (ax, ay, bx, by) {
      var dx = bx - ax;
      var dy = by - ay;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var steps = Math.max(1, Math.floor(dist / Config.BRUSH_SPACING));
      for (var i = 1; i <= steps; i++) {
        var t = i / steps;
        Water.stampMask(ax + dx * t, ay + dy * t, Config.BRUSH_RADIUS);
      }
    },

    draw: function (time) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      // Water base.
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(waterCanvas, 0, 0, W, H);
      // Animated shimmer scrolled horizontally, wrapping.
      var scroll = (time * 0.012) % W;
      ctx.globalAlpha = 0.9;
      ctx.drawImage(shimmerCanvas, -scroll, 0, W * 2, H);
      ctx.globalAlpha = 1;
      // Subtract the erased area in a single drawImage.
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(maskCanvas, 0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";
    },
  };

  /* ------------------------------------------------------------ Progress */
  var Progress = {
    acc: 0,
    sample: function () {
      sampleCtx.clearRect(0, 0, Config.SAMPLE_W, Config.SAMPLE_H);
      // Downscale the MASK (cleared area) — robust against water gradient noise.
      sampleCtx.drawImage(maskCanvas, 0, 0, Config.SAMPLE_W, Config.SAMPLE_H);
      var data = sampleCtx.getImageData(0, 0, Config.SAMPLE_W, Config.SAMPLE_H).data;
      var total = Config.SAMPLE_W * Config.SAMPLE_H;
      var cleared = 0;
      for (var i = 3; i < data.length; i += 4) {
        if (data[i] >= Config.ALPHA_CLEARED) cleared++;
      }
      return cleared / total;
    },
    tick: function (dt) {
      this.acc += dt;
      if (this.acc < Config.SAMPLE_MS) return;
      this.acc = 0;
      State.cleared = this.sample();
      if (gaugeFill) gaugeFill.style.height = Math.min(100, State.cleared * 100) + "%";
      if (State.phase === "playing" && State.cleared >= Config.CLEAR_THRESHOLD) {
        startDrain();
      }
    },
  };

  /* ----------------------------------------------------------- Particles */
  var Particles = {
    pool: [],
    init: function () {
      this.pool.length = 0;
      for (var i = 0; i < Config.MAX_PARTICLES; i++) {
        this.pool.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 0, size: 0, swirl: 1 });
      }
    },
    spawn: function () {
      var n = Config.MAX_PARTICLES;
      var spawned = 0;
      for (var i = 0; i < n && spawned < Config.SPAWN_PER_FRAME; i++) {
        var p = this.pool[i];
        if (p.active) continue;
        // Spawn on a ring just outside the nozzle (the wet edge being pulled in).
        var ang = (i * 2.39963) % (Math.PI * 2); // golden-angle spread, no RNG
        var spread = ((i * 41) % 100) / 100;
        var rr = Config.BRUSH_RADIUS * (1.05 + spread * 0.9);
        p.x = State.nozzle.x + Math.cos(ang) * rr;
        p.y = State.nozzle.y + Math.sin(ang) * rr;
        p.vx = 0;
        p.vy = 0;
        p.life = 0;
        p.max = Config.PARTICLE_LIFE * (0.7 + spread * 0.6);
        p.size = 1.6 + spread * 2.6;
        p.swirl = (i % 2 === 0) ? 1 : -1;
        p.active = true;
        spawned++;
      }
    },
    update: function (dt) {
      var dts = dt / 1000;
      var nx = State.nozzle.x;
      var ny = State.nozzle.y;
      for (var i = 0; i < this.pool.length; i++) {
        var p = this.pool[i];
        if (!p.active) continue;
        p.life += dt;
        var dx = nx - p.x;
        var dy = ny - p.y;
        var d = Math.sqrt(dx * dx + dy * dy) || 0.001;
        if (p.life >= p.max || d < 8) {
          p.active = false;
          continue;
        }
        var ux = dx / d;
        var uy = dy / d;
        var accel = Config.ATTRACT / (d + Config.ATTRACT_K);
        // Toward nozzle + a perpendicular swirl for a curved suck.
        p.vx += (ux * accel - uy * accel * Config.SWIRL * p.swirl) * dts;
        p.vy += (uy * accel + ux * accel * Config.SWIRL * p.swirl) * dts;
        p.vx *= 0.96;
        p.vy *= 0.96;
        p.x += p.vx * dts;
        p.y += p.vy * dts;
      }
    },
    draw: function () {
      ctx.globalCompositeOperation = "source-over";
      for (var i = 0; i < this.pool.length; i++) {
        var p = this.pool[i];
        if (!p.active) continue;
        var t = p.life / p.max;
        var alpha = t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8;
        ctx.globalAlpha = Math.max(0, alpha) * 0.9;
        ctx.fillStyle = "rgba(224, 247, 255, 1)";
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    },
  };

  /* ----------------------------------------------------------------- Hose */
  var Hose = {
    anchor: { x: 0, y: 0 }, // corner vacuum inlet, in css px
    measure: function () {
      var r = vacuumEl.getBoundingClientRect();
      var g = gate.getBoundingClientRect();
      this.anchor.x = r.left - g.left + r.width * 0.5;
      this.anchor.y = r.top - g.top + 14;
    },
    draw: function () {
      var p0x = State.nozzle.x;
      var p0y = State.nozzle.y;
      var p2x = this.anchor.x;
      var p2y = this.anchor.y;
      var mx = (p0x + p2x) / 2;
      var my = (p0y + p2y) / 2;
      var dx = p2x - p0x;
      var dy = p2y - p0y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var maxDist = Math.sqrt(W * W + H * H);
      var sag = Config.SAG_BASE * (0.5 + 0.8 * (1 - dist / maxDist));
      var c1x = mx;
      var c1y = my + sag;

      ctx.globalCompositeOperation = "source-over";
      ctx.lineCap = "round";
      // Outer rubbery tube.
      ctx.beginPath();
      ctx.moveTo(p0x, p0y);
      ctx.quadraticCurveTo(c1x, c1y, p2x, p2y);
      ctx.lineWidth = 15;
      ctx.strokeStyle = "rgba(8, 44, 84, 0.85)";
      ctx.stroke();
      // Inner highlight.
      ctx.beginPath();
      ctx.moveTo(p0x, p0y);
      ctx.quadraticCurveTo(c1x, c1y, p2x, p2y);
      ctx.lineWidth = 6;
      ctx.strokeStyle = "rgba(150, 198, 232, 0.6)";
      ctx.stroke();
      // Coupling at the nozzle end.
      ctx.beginPath();
      ctx.arc(p0x, p0y, 9, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(20, 60, 104, 0.9)";
      ctx.fill();
    },
  };

  /* ------------------------------------------------------------------- FX */
  var FX = {
    on: false,
    actx: null,
    noiseBuf: null,
    src: null,
    gain: null,
    ensure: function () {
      if (this.actx) return;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.actx = new AC();
      // Pre-render a short looping noise buffer for the suction hiss.
      var len = this.actx.sampleRate * 1.5;
      this.noiseBuf = this.actx.createBuffer(1, len, this.actx.sampleRate);
      var d = this.noiseBuf.getChannelData(0);
      var last = 0;
      for (var i = 0; i < len; i++) {
        // Brown-ish noise for a softer "whoosh".
        var wn = (i % 97) / 97 - 0.5 + (i % 13) / 13 - 0.5;
        last = (last + 0.02 * wn) / 1.02;
        d[i] = last * 3.2;
      }
    },
    setEnabled: function (yes) {
      this.on = yes;
      soundBtn.setAttribute("aria-pressed", yes ? "true" : "false");
      if (soundLabel) soundLabel.textContent = yes ? "🔊 Sound" : "🔇 Sound";
      if (yes) {
        this.ensure();
        if (this.actx && this.actx.state === "suspended") this.actx.resume();
      } else {
        this.setSuction(false);
      }
    },
    setSuction: function (active) {
      if (!this.on || !this.actx) {
        if (!active && this.src) this.stopSrc();
        return;
      }
      if (active && !this.src) {
        this.src = this.actx.createBufferSource();
        this.src.buffer = this.noiseBuf;
        this.src.loop = true;
        var lp = this.actx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 900;
        this.gain = this.actx.createGain();
        this.gain.gain.value = 0.0;
        this.src.connect(lp).connect(this.gain).connect(this.actx.destination);
        this.src.start();
        this.gain.gain.linearRampToValueAtTime(0.18, this.actx.currentTime + 0.08);
      } else if (!active && this.src) {
        this.stopSrc();
      }
    },
    stopSrc: function () {
      if (!this.src) return;
      try {
        if (this.gain) this.gain.gain.linearRampToValueAtTime(0, this.actx.currentTime + 0.12);
        var s = this.src;
        setTimeout(function () {
          try { s.stop(); } catch (e) {}
        }, 140);
      } catch (e) {}
      this.src = null;
      this.gain = null;
    },
    finalSlurp: function () {
      if (!this.on || !this.actx) return;
      var t = this.actx.currentTime;
      var o = this.actx.createBufferSource();
      o.buffer = this.noiseBuf;
      var lp = this.actx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(1600, t);
      lp.frequency.exponentialRampToValueAtTime(220, t + 0.5);
      var g = this.actx.createGain();
      g.gain.setValueAtTime(0.28, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
      o.connect(lp).connect(g).connect(this.actx.destination);
      o.start(t);
      o.stop(t + 0.6);
    },
    vibrate: function () {
      if (navigator.vibrate) navigator.vibrate(Config.VIBRATE_MS);
    },
  };

  /* ----------------------------------------------------------------- Loop */
  var Loop = {
    raf: 0,
    last: 0,
    running: false,
    start: function () {
      if (this.running) return;
      this.running = true;
      this.last = 0;
      var self = this;
      this.raf = requestAnimationFrame(function (t) { self.frame(t); });
    },
    stop: function () {
      this.running = false;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    },
    frame: function (time) {
      if (!this.running) return;
      if (!this.last) this.last = time;
      var dt = Math.min(50, time - this.last);
      this.last = time;

      Water.draw(time);
      if (State.phase === "draining") Drain.tick(dt);
      Hose.draw();
      if (State.phase === "playing" && State.moving) Particles.spawn();
      Particles.update(dt);
      Particles.draw();
      Progress.tick(dt);

      State.moving = false;
      var self = this;
      this.raf = requestAnimationFrame(function (t) { self.frame(t); });
    },
  };

  /* ---------------------------------------------------------------- Drain */
  var Drain = {
    elapsed: 0,
    seeds: [],
    start: function () {
      this.elapsed = 0;
      // Drain seeds: the nozzle plus a few spread points, growing outward.
      this.seeds = [
        { x: State.nozzle.x, y: State.nozzle.y },
        { x: W * 0.25, y: H * 0.35 },
        { x: W * 0.75, y: H * 0.4 },
        { x: W * 0.5, y: H * 0.7 },
        { x: W * 0.5, y: H * 0.5 },
      ];
      FX.finalSlurp();
      FX.setSuction(false);
    },
    tick: function (dt) {
      this.elapsed += dt;
      var t = Math.min(1, this.elapsed / Config.DRAIN_MS);
      var ease = t * t * (3 - 2 * t);
      var maxR = Math.sqrt(W * W + H * H) * 0.62;
      for (var i = 0; i < this.seeds.length; i++) {
        var s = this.seeds[i];
        var r = ease * maxR * (0.7 + (i % 3) * 0.18);
        if (r > 0) Water.stampMask(s.x, s.y, r);
      }
      // Fade the whole gate over the back half of the drain.
      if (t > 0.5) gate.style.opacity = String(1 - (t - 0.5) / 0.5);
      if (t >= 1) finish();
    },
  };

  /* ------------------------------------------------------- Pointer handling */
  function pointerToCss(e) {
    var rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e) {
    if (State.phase !== "idle" && State.phase !== "playing") return;
    State.pointerDown = true;
    if (State.phase === "idle") {
      State.phase = "playing";
      gate.classList.add("is-engaged");
      Loop.start();
    }
    gate.classList.add("is-suction");
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    var p = pointerToCss(e);
    State.nozzle.x = p.x;
    State.nozzle.y = p.y;
    State.lastDab = { x: p.x, y: p.y };
    moveNozzleEl(p.x, p.y);
    Water.stampMask(p.x, p.y, Config.BRUSH_RADIUS);
    FX.setSuction(true);
    if (e.cancelable) e.preventDefault();
  }

  function onPointerMove(e) {
    var p = pointerToCss(e);
    State.nozzle.x = p.x;
    State.nozzle.y = p.y;
    moveNozzleEl(p.x, p.y);
    if (State.pointerDown && State.phase === "playing") {
      if (State.lastDab) {
        var moved = Math.abs(p.x - State.lastDab.x) + Math.abs(p.y - State.lastDab.y);
        Water.eraseSegment(State.lastDab.x, State.lastDab.y, p.x, p.y);
        if (moved > 6) {
          State.moving = true;
          FX.vibrate();
        }
      }
      State.lastDab = { x: p.x, y: p.y };
      if (e.cancelable) e.preventDefault();
    }
  }

  function onPointerUp(e) {
    State.pointerDown = false;
    State.lastDab = null;
    gate.classList.remove("is-suction");
    FX.setSuction(false);
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
  }

  function moveNozzleEl(x, y) {
    nozzleEl.style.transform = "translate(" + x + "px," + y + "px)";
  }

  /* ----------------------------------------------------- State transitions */
  function startDrain() {
    if (State.phase !== "playing") return;
    State.phase = "draining";
    State.pointerDown = false;
    gate.classList.remove("is-suction");
    gate.classList.add("is-draining");
    Drain.start();
  }

  var torndown = false;
  function finish() {
    if (torndown) return;
    torndown = true;
    Loop.stop();
    FX.setSuction(false);
    try { window.sessionStorage.setItem(Config.STORAGE_KEY, "1"); } catch (e) {}
    document.body.classList.remove("gate-active");
    removeListeners();
    gate.classList.add("is-fading");
    State.phase = "done";
    // Remove after the CSS opacity transition so focus/scroll return cleanly.
    window.setTimeout(function () {
      gate.setAttribute("hidden", "");
      gate.parentNode && gate.parentNode.removeChild(gate);
      focusSite();
    }, 540);
  }

  // Fast teardown for Skip / Esc.
  function skip() {
    if (State.phase === "draining" || State.phase === "done") return;
    State.phase = "draining"; // block further play
    Loop.stop();
    finish();
  }

  // Immediate, no-animation reveal (reduced-motion / once-per-session).
  function teardownImmediate() {
    if (gate) {
      gate.setAttribute("hidden", "");
      if (gate.parentNode) gate.parentNode.removeChild(gate);
    }
    document.body.classList.remove("gate-active");
  }

  function focusSite() {
    var h1 = document.querySelector("h1");
    if (h1) {
      h1.setAttribute("tabindex", "-1");
      h1.focus({ preventScroll: true });
    }
  }

  /* --------------------------------------------------------------- Resize */
  function resize() {
    var prevMask = null;
    if (W > 0 && H > 0) {
      // Preserve cleared progress across resize by copying the old mask.
      prevMask = document.createElement("canvas");
      prevMask.width = maskCanvas.width;
      prevMask.height = maskCanvas.height;
      prevMask.getContext("2d").drawImage(maskCanvas, 0, 0);
    }

    dpr = Math.min(Config.MAX_DPR, window.devicePixelRatio || 1);
    W = gate.clientWidth;
    H = gate.clientHeight;

    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));

    maskCanvas.width = canvas.width;
    maskCanvas.height = canvas.height;
    maskCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (prevMask) {
      maskCtx.setTransform(1, 0, 0, 1, 0, 0);
      maskCtx.drawImage(prevMask, 0, 0, prevMask.width, prevMask.height, 0, 0, maskCanvas.width, maskCanvas.height);
      maskCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    Water.buildTexture();
    Water.buildShimmer();
    Hose.measure();
  }

  /* ----------------------------------------------------------- Listeners */
  function onKey(e) {
    if (e.key === "Escape") skip();
  }

  function onResize() {
    resize();
  }

  function addListeners() {
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    skipBtn.addEventListener("click", skip);
    soundBtn.addEventListener("click", function () { FX.setEnabled(!FX.on); });
  }

  function removeListeners() {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onResize);
  }

  /* -------------------------------------------------------------- Bootstrap */
  function init() {
    gate.removeAttribute("hidden");
    document.body.classList.add("gate-active");
    Particles.init();
    resize();
    addListeners();
    // Park the nozzle near center so the hint reads as "grab this".
    State.nozzle.x = W / 2;
    State.nozzle.y = H / 2;
    moveNozzleEl(W / 2, H / 2);
    // Give keyboard users an immediate escape hatch.
    skipBtn.focus({ preventScroll: true });
    // Run the loop from the start so the water shimmers invitingly while idle.
    Loop.start();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
