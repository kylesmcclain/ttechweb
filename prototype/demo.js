/*
 * AquaRestore — "vacuum sucks up the water" intro gate prototype.
 *
 * A fixed full-viewport overlay of clean blue water sits on top of the real
 * (dummy) site. The visitor drags a vacuum nozzle to suck the water away
 * (scratch-to-reveal via canvas `destination-out` of an accumulating mask).
 * A trailing wet-edge glow hugs the cleared boundary, droplet particles streak
 * into the nozzle, and at ~36% cleared the rest auto-drains with a sparkle
 * finale and the gate tears down, revealing the live page beneath.
 *
 * One self-contained IIFE. Internal "modules" are plain namespaces sharing the
 * closure: Config, State, Water, Progress, Particles, Hose, FX, Drain, Loop.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ Config */
  var Config = {
    CLEAR_THRESHOLD: 0.4, // fraction cleared that triggers the drain finale
    BRUSH_RADIUS: 82, // css px, soft erase radius
    BRUSH_SPACING: 24, // css px between interpolated dabs on a drag
    BRUSH_SOFT: 0.42, // inner solid stop of the brush gradient (0..1)
    SAMPLE_MS: 160, // progress sampling interval
    SAMPLE_W: 80,
    SAMPLE_H: 50,
    ALPHA_CLEARED: 110, // mask alpha at/above which a pixel counts as cleared
    MAX_PARTICLES: 110,
    SPAWN_PER_FRAME: 4,
    PARTICLE_LIFE: 720, // ms
    ATTRACT: 2800, // suction strength toward the nozzle
    ATTRACT_K: 36, // softening so accel stays finite at the nozzle
    SWIRL: 0.3, // perpendicular curve factor for particle paths
    EDGE_DECAY: 0.1, // alpha removed from the wet-edge glow each frame
    DRAIN_MS: 980,
    SAG_BASE: 130, // hose droop in px
    MAX_DPR: 2,
    VIBRATE_MS: 6,
    STORAGE_KEY: "aquaGateDone",
  };

  /* ------------------------------------------------------------- DOM handles */
  var gate = document.querySelector("[data-gate]");
  if (!gate) return;

  var siteEl = document.querySelector(".site");
  var canvas = gate.querySelector("[data-water]");
  var nozzleEl = gate.querySelector("[data-nozzle]");
  var vacuumEl = gate.querySelector("[data-vacuum]");
  var gaugeFill = gate.querySelector("[data-gauge-fill]");
  var skipBtn = gate.querySelector("[data-skip]");
  var soundBtn = gate.querySelector("[data-sound]");
  var soundLabel = gate.querySelector("[data-sound-label]");

  var motionMq = window.matchMedia("(prefers-reduced-motion: reduce)");
  var alreadyDone = false;
  try {
    alreadyDone = window.sessionStorage.getItem(Config.STORAGE_KEY) === "1";
  } catch (e) {
    /* sessionStorage may throw in private mode — treat as not-done */
  }

  /* If the visitor can't or shouldn't play, never build the gate. */
  if (motionMq.matches || alreadyDone) {
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
    moveDir: { x: 0, y: -1 }, // unit vector of recent motion (spawn bias)
    vx: 0, // recent horizontal velocity (nozzle lean)
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
  var edgeCanvas = document.createElement("canvas"); // trailing wet-edge glow
  var edgeCtx = edgeCanvas.getContext("2d");
  var sampleCanvas = document.createElement("canvas"); // tiny downscaled sampler
  var sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
  sampleCanvas.width = Config.SAMPLE_W;
  sampleCanvas.height = Config.SAMPLE_H;

  // Pre-rendered sprites (built once) so the hot path never allocates gradients.
  var brushSprite = document.createElement("canvas"); // soft erase dab
  var edgeSprite = document.createElement("canvas"); // bright rim ring
  function buildSprites() {
    var S = 256;
    brushSprite.width = brushSprite.height = S;
    var bc = brushSprite.getContext("2d");
    var bg = bc.createRadialGradient(S / 2, S / 2, (S / 2) * Config.BRUSH_SOFT, S / 2, S / 2, S / 2);
    bg.addColorStop(0, "rgba(255,255,255,1)");
    bg.addColorStop(1, "rgba(255,255,255,0)");
    bc.fillStyle = bg;
    bc.fillRect(0, 0, S, S);

    edgeSprite.width = edgeSprite.height = S;
    var ec = edgeSprite.getContext("2d");
    var eg = ec.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    // Bright band sits just outside the erase radius so it survives the mask
    // and reads as a wet rim hugging the cleared edge.
    eg.addColorStop(0.0, "rgba(220,248,255,0)");
    eg.addColorStop(0.74, "rgba(220,248,255,0)");
    eg.addColorStop(0.84, "rgba(228,250,255,0.95)");
    eg.addColorStop(0.92, "rgba(190,236,255,0.35)");
    eg.addColorStop(1.0, "rgba(190,236,255,0)");
    ec.fillStyle = eg;
    ec.fillRect(0, 0, S, S);
  }

  /* --------------------------------------------------------- Water + shimmer */
  var Water = {
    buildTexture: function () {
      var c = waterCtx;
      waterCanvas.width = Math.max(1, Math.round(W * dpr));
      waterCanvas.height = Math.max(1, Math.round(H * dpr));
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, H);

      // Base clean-blue gradient. Opaque so the site is fully hidden until the
      // water is vacuumed away; depth comes from the radial pools layered on top.
      var g = c.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, "rgb(26, 146, 222)");
      g.addColorStop(0.5, "rgb(13, 116, 206)");
      g.addColorStop(1, "rgb(7, 88, 172)");
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

    // Soft round dab stamped into the mask (white = erased area), via the
    // pre-rendered sprite so no gradient is allocated on the hot path.
    stampMask: function (x, y, radius) {
      maskCtx.drawImage(brushSprite, x - radius, y - radius, radius * 2, radius * 2);
    },

    // Bright rim stamped into the edge layer, sized so the band lands just
    // outside the cleared hole and survives the destination-out mask.
    stampEdge: function (x, y) {
      var r = Config.BRUSH_RADIUS * 1.18;
      edgeCtx.drawImage(edgeSprite, x - r, y - r, r * 2, r * 2);
    },

    // Erase along the segment from a->b so fast drags leave no gaps.
    eraseSegment: function (ax, ay, bx, by) {
      var dx = bx - ax;
      var dy = by - ay;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var steps = Math.max(1, Math.floor(dist / Config.BRUSH_SPACING));
      for (var i = 1; i <= steps; i++) {
        var t = i / steps;
        var px = ax + dx * t;
        var py = ay + dy * t;
        this.stampMask(px, py, Config.BRUSH_RADIUS);
        this.stampEdge(px, py);
      }
    },

    decayEdge: function () {
      // Fade the wet-edge glow so it only lingers where we just vacuumed.
      edgeCtx.save();
      edgeCtx.setTransform(1, 0, 0, 1, 0, 0);
      edgeCtx.globalCompositeOperation = "destination-out";
      edgeCtx.fillStyle = "rgba(0,0,0," + Config.EDGE_DECAY + ")";
      edgeCtx.fillRect(0, 0, edgeCanvas.width, edgeCanvas.height);
      edgeCtx.restore();
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
      // Wet-edge glow added over the water (additive), before the hole is cut.
      ctx.globalCompositeOperation = "lighter";
      ctx.drawImage(edgeCanvas, 0, 0, W, H);
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
      // Honest gauge: the tank reads full exactly when the drain fires.
      if (gaugeFill) {
        var pct = Math.min(100, (State.cleared / Config.CLEAR_THRESHOLD) * 100);
        gaugeFill.style.height = pct + "%";
      }
      if (State.phase === "playing" && State.cleared >= Config.CLEAR_THRESHOLD) {
        startDrain();
      }
    },
  };

  /* ----------------------------------------------------------- Particles */
  var Particles = {
    pool: [],
    seq: 0,
    init: function () {
      this.pool.length = 0;
      for (var i = 0; i < Config.MAX_PARTICLES; i++) {
        this.pool.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 0, size: 0, swirl: 1 });
      }
    },
    reset: function (p, ox, oy, sizeBias) {
      var k = ++this.seq; // monotonic so spread/angle actually distribute
      var ang = (k * 2.39963) % (Math.PI * 2); // golden angle
      var spread = ((k * 41) % 100) / 100;
      p.x = ox;
      p.y = oy;
      p.vx = Math.cos(ang) * 12 * spread;
      p.vy = Math.sin(ang) * 12 * spread;
      p.life = 0;
      p.max = Config.PARTICLE_LIFE * (0.6 + spread * 0.7);
      p.size = (1.5 + spread * 3.4) * (sizeBias || 1);
      p.swirl = k % 2 === 0 ? 1 : -1;
      p.active = true;
    },
    spawn: function () {
      var spawned = 0;
      for (var i = 0; i < this.pool.length && spawned < Config.SPAWN_PER_FRAME; i++) {
        var p = this.pool[i];
        if (p.active) continue;
        // Bias the spawn toward the uncleared water ahead of the drag, so
        // droplets visibly tear off the waterline and get sucked back in.
        var k = this.seq + 1;
        var jitter = (((k * 53) % 100) / 100 - 0.5) * Config.BRUSH_RADIUS * 1.4;
        var perpx = -State.moveDir.y;
        var perpy = State.moveDir.x;
        var reach = Config.BRUSH_RADIUS * 1.15;
        var ox = State.nozzle.x + State.moveDir.x * reach + perpx * jitter;
        var oy = State.nozzle.y + State.moveDir.y * reach + perpy * jitter;
        this.reset(p, ox, oy, 1);
        spawned++;
      }
    },
    burst: function (count) {
      // A heavy convergent gulp for the drain finale.
      var made = 0;
      for (var i = 0; i < this.pool.length && made < count; i++) {
        var p = this.pool[i];
        if (p.active) continue;
        var k = this.seq + 1;
        var ang = (k * 2.39963) % (Math.PI * 2);
        var rad = (((k * 29) % 100) / 100) * Math.min(W, H) * 0.5;
        this.reset(p, State.nozzle.x + Math.cos(ang) * rad, State.nozzle.y + Math.sin(ang) * rad, 1.5);
        made++;
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
      ctx.globalCompositeOperation = "lighter"; // luminous water spray
      for (var i = 0; i < this.pool.length; i++) {
        var p = this.pool[i];
        if (!p.active) continue;
        var t = p.life / p.max;
        var alpha = t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8;
        alpha = Math.max(0, alpha);
        var speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        // Stretch the droplet into a streak along its velocity when moving fast.
        var len = Math.min(20, speed * 0.018);
        ctx.globalAlpha = alpha * 0.85;
        ctx.strokeStyle = "rgba(206, 242, 255, 1)";
        ctx.lineCap = "round";
        ctx.lineWidth = p.size;
        if (len > p.size) {
          var ux = p.vx / (speed || 1);
          var uy = p.vy / (speed || 1);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - ux * len, p.y - uy * len);
          ctx.stroke();
        } else {
          ctx.fillStyle = "rgba(230, 249, 255, 1)";
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * 0.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
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
      var len = this.actx.sampleRate * 1.5;
      this.noiseBuf = this.actx.createBuffer(1, len, this.actx.sampleRate);
      var d = this.noiseBuf.getChannelData(0);
      var last = 0;
      for (var i = 0; i < len; i++) {
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
        window.setTimeout(function () {
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
      g.gain.setValueAtTime(0.32, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
      o.connect(lp).connect(g).connect(this.actx.destination);
      o.start(t);
      o.stop(t + 0.6);
    },
    vibrate: function () {
      if (navigator.vibrate) navigator.vibrate(Config.VIBRATE_MS);
    },
  };

  /* ---------------------------------------------------------------- Drain */
  var Drain = {
    elapsed: 0,
    seeds: [],
    start: function () {
      this.elapsed = 0;
      this.seeds = [
        { x: State.nozzle.x, y: State.nozzle.y },
        { x: W * 0.25, y: H * 0.35 },
        { x: W * 0.75, y: H * 0.4 },
        { x: W * 0.5, y: H * 0.72 },
        { x: W * 0.5, y: H * 0.5 },
      ];
      FX.finalSlurp();
      FX.setSuction(false);
      Particles.burst(56);
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
      // "All clean" sparkle bloom peaking mid-drain — a payoff even when muted.
      if (t > 0.35 && t < 0.95) {
        var bloom = Math.sin(((t - 0.35) / 0.6) * Math.PI); // 0..1..0
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = bloom * 0.5;
        var cx = State.nozzle.x;
        var cy = State.nozzle.y;
        for (var j = 0; j < 9; j++) {
          var a = (j * 2.39963) % (Math.PI * 2);
          var rr = (0.16 + (j % 4) * 0.12) * Math.min(W, H) * bloom;
          var sx = cx + Math.cos(a) * rr;
          var sy = cy + Math.sin(a) * rr;
          var size = 2 + (j % 3) * 2;
          ctx.fillStyle = "rgba(235, 251, 255, 1)";
          ctx.beginPath();
          ctx.arc(sx, sy, size, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
        ctx.globalAlpha = 1;
      }
      // Fade + a slight scale "pull" over the back half of the drain.
      if (t > 0.45) {
        var f = (t - 0.45) / 0.55;
        gate.style.opacity = String(1 - f);
        gate.style.transform = "scale(" + (1 + f * 0.05) + ")";
      }
      if (t >= 1) finish();
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

      Water.decayEdge();
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
      Loop.start(); // canvas loop starts on first interaction (idle stays cheap)
    }
    gate.classList.add("is-suction");
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    var p = pointerToCss(e);
    State.nozzle.x = p.x;
    State.nozzle.y = p.y;
    State.lastDab = { x: p.x, y: p.y };
    moveNozzleEl(p.x, p.y, 0, true);
    Water.stampMask(p.x, p.y, Config.BRUSH_RADIUS);
    Water.stampEdge(p.x, p.y);
    FX.setSuction(true);
    if (e.cancelable) e.preventDefault();
  }

  function onPointerMove(e) {
    var p = pointerToCss(e);
    var pdx = p.x - State.nozzle.x;
    var pdy = p.y - State.nozzle.y;
    State.vx = pdx;
    State.nozzle.x = p.x;
    State.nozzle.y = p.y;
    moveNozzleEl(p.x, p.y, pdx, State.pointerDown);
    if (State.pointerDown && State.phase === "playing") {
      if (State.lastDab) {
        var mdx = p.x - State.lastDab.x;
        var mdy = p.y - State.lastDab.y;
        var moved = Math.abs(mdx) + Math.abs(mdy);
        if (moved > 0.5) {
          var ml = Math.sqrt(mdx * mdx + mdy * mdy) || 1;
          State.moveDir.x = mdx / ml;
          State.moveDir.y = mdy / ml;
        }
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

  function moveNozzleEl(x, y, vx, leaning) {
    // Lean the nozzle into horizontal motion; pop slightly while suctioning.
    var lean = leaning ? Math.max(-14, Math.min(14, (vx || 0) * 0.6)) : 0;
    var scale = leaning && State.pointerDown ? 1.08 : 1;
    nozzleEl.style.transform =
      "translate(" + x + "px," + y + "px) rotate(" + lean + "deg) scale(" + scale + ")";
  }

  function onSoundClick() {
    FX.setEnabled(!FX.on);
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
    restoreSite();
    focusSite(); // move focus to content immediately (no silent gap for AT)
    gate.classList.add("is-fading");
    State.phase = "done";
    // Remove the node after the CSS opacity transition finishes.
    window.setTimeout(function () {
      gate.setAttribute("hidden", "");
      if (gate.parentNode) gate.parentNode.removeChild(gate);
    }, 560);
  }

  // Fast teardown for Skip / Esc — works in any non-done phase.
  function skip() {
    if (State.phase === "done") return;
    State.phase = "draining"; // block further play/erase
    Loop.stop();
    finish();
  }

  // Immediate, no-animation reveal (reduced-motion / once-per-session).
  function teardownImmediate() {
    if (gate) {
      gate.setAttribute("hidden", "");
      if (gate.parentNode) gate.parentNode.removeChild(gate);
    }
    restoreSite();
    document.body.classList.remove("gate-active");
  }

  // Mid-session reduce-motion flip: tear everything down instantly, no leak.
  function abortToReveal() {
    if (torndown) return;
    torndown = true;
    Loop.stop();
    FX.setSuction(false);
    try { window.sessionStorage.setItem(Config.STORAGE_KEY, "1"); } catch (e) {}
    removeListeners();
    teardownImmediate();
    focusSite();
  }

  function restoreSite() {
    if (siteEl) {
      siteEl.removeAttribute("inert");
      siteEl.removeAttribute("aria-hidden");
    }
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

    edgeCanvas.width = canvas.width;
    edgeCanvas.height = canvas.height;
    edgeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

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
    // Idle keeps the RAF loop off, so repaint the static frame ourselves —
    // otherwise a resize before the first interaction blanks the gate canvas.
    if (!Loop.running) {
      Water.draw(0);
      Hose.draw();
    }
  }

  function onMotionChange(e) {
    if (e.matches) abortToReveal();
  }

  function addListeners() {
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    skipBtn.addEventListener("click", skip);
    soundBtn.addEventListener("click", onSoundClick);
    if (motionMq.addEventListener) motionMq.addEventListener("change", onMotionChange);
    else if (motionMq.addListener) motionMq.addListener(onMotionChange);
  }

  function removeListeners() {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onResize);
    skipBtn.removeEventListener("click", skip);
    soundBtn.removeEventListener("click", onSoundClick);
    if (motionMq.removeEventListener) motionMq.removeEventListener("change", onMotionChange);
    else if (motionMq.removeListener) motionMq.removeListener(onMotionChange);
  }

  /* -------------------------------------------------------------- Bootstrap */
  function init() {
    gate.removeAttribute("hidden");
    document.body.classList.add("gate-active");
    // Contain focus/AT to the gate: the site beneath is inert until reveal.
    if (siteEl) {
      siteEl.setAttribute("inert", "");
      siteEl.setAttribute("aria-hidden", "true");
    }
    buildSprites();
    Particles.init();
    resize();
    addListeners();
    // Park the nozzle near center so the hint reads as "grab this".
    State.nozzle.x = W / 2;
    State.nozzle.y = H / 2;
    moveNozzleEl(W / 2, H / 2, 0, false);
    // Give keyboard users an immediate escape hatch.
    skipBtn.focus({ preventScroll: true });
    // Draw one static frame; the canvas RAF loop starts on first interaction
    // (CSS animations keep the idle gate alive without burning GPU).
    Water.draw(0);
    Hose.draw();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
