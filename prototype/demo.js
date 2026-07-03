/*
 * AquaRestore — "wash the grime off the screen" intro gate prototype.
 *
 * A fixed full-viewport film of gray dirty water covers the real (dummy) site.
 * The visitor drags or taps a cartoon spray nozzle to wash the grime away
 * (scratch-to-reveal via canvas `destination-out` of an accumulating mask).
 * A white suds line hugs the fresh clean edge, spray mist fans out from the
 * nozzle tip, murky drips break off and fall, and at ~50% clean a fast
 * squeegee-style sweep wipes the rest off-screen with a sparkle payoff.
 *
 * One self-contained IIFE. Internal "modules" are plain namespaces sharing the
 * closure: Config, State, Grime, Progress, Particles, FX, Sweep, Loop.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ Config */
  var Config = {
    CLEAR_THRESHOLD: 0.42, // fraction cleaned that triggers the sweep finale
    BRUSH_RADIUS: 82, // css px, erase radius — rescaled per viewport in resize()
    BRUSH_SPACING: 24, // css px between interpolated dabs on a drag
    BRUSH_SOFT: 0.78, // opaque core fraction — crisp edge with a thin wet feather
    TAP_RADIUS: 130, // main stamp of a tap splash
    TAP_MS: 250, // max press duration to count as a tap
    TAP_MOVE_PX: 8, // max pointer displacement to count as a tap
    SAMPLE_MS: 160, // progress sampling interval
    SAMPLE_W: 80,
    SAMPLE_H: 50,
    ALPHA_CLEARED: 110, // mask alpha at/above which a pixel counts as cleaned
    GRIME_ALPHA_TOP: 0.9, // master translucency knobs — site should tease through
    GRIME_ALPHA_BOTTOM: 0.94,
    TEASE_ALPHA: 0.04, // clarity window (kept off the headline — bait, not a read)
    MAX_PARTICLES: 140,
    MIST_PER_FRAME: 6, // while dragging
    MIST_IDLE_PER_FRAME: 2, // while pressing without moving (spray keeps spitting)
    DRIP_PER_FRAME: 2, // while erasing
    MIST_LIFE_MIN: 240, // ms
    MIST_LIFE_MAX: 420,
    DRIP_LIFE_MIN: 600,
    DRIP_LIFE_MAX: 900,
    MIST_SPEED_MIN: 380, // px/s
    MIST_SPEED_MAX: 620,
    MIST_CONE_DEG: 22,
    GRAVITY_MIST: 300, // px/s^2
    GRAVITY_DRIP: 900,
    TIP: { x: 18, y: -22 }, // spray tip offset from the pointer contact point
    EDGE_DECAY: 0.12, // suds line pops then vanishes
    SWEEP_MS: 800,
    SWEEP_ANGLE: (-18 * Math.PI) / 180,
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
  var nozzleInner = gate.querySelector(".nozzle-inner");
  var progressFill = gate.querySelector("[data-progress-fill]");
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
    phase: "idle", // idle -> playing -> sweeping -> done
    pointerDown: false,
    nozzle: { x: -999, y: -999 }, // current css-px pointer/nozzle position
    lastDab: null, // last dab point for segment interpolation
    moving: false, // nozzle moved this frame (drives spawn rate)
    moveDir: { x: 0, y: -1 }, // unit vector of recent motion
    speed01: 0, // normalized recent scrub speed (mist inheritance + audio)
    holdMs: 0, // how long the press has been held still (soak-through)
    cleared: 0, // 0..1 fraction cleaned (from Progress)
    downT: 0, // pointerdown timestamp (tap detection)
    downX: 0,
    downY: 0,
    maxDisp: 0, // max displacement since pointerdown (tap detection)
  };

  // Deterministic PRNG (mulberry32) so the grime pattern is identical on every
  // rebuild — otherwise the dirt would visibly reshuffle on window resize.
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------------------------------------------------------- Geometry */
  var dpr = 1;
  var W = 0; // css px width
  var H = 0; // css px height
  var ctx = canvas.getContext("2d");
  var edgeIdleFrames = 99; // frames since the last suds stamp (99 = fully idle)

  // Offscreen layers.
  var grimeCanvas = document.createElement("canvas"); // painted grime texture
  var grimeCtx = grimeCanvas.getContext("2d");
  var maskCanvas = document.createElement("canvas"); // accumulates cleaned area
  var maskCtx = maskCanvas.getContext("2d");
  var edgeCanvas = document.createElement("canvas"); // trailing suds glow
  var edgeCtx = edgeCanvas.getContext("2d");
  var sampleCanvas = document.createElement("canvas"); // tiny downscaled sampler
  var sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
  sampleCanvas.width = Config.SAMPLE_W;
  sampleCanvas.height = Config.SAMPLE_H;

  // Pre-rendered sprites (built once) so the hot path never allocates gradients.
  var brushSprite = document.createElement("canvas"); // erase dab (crisp + feather)
  var edgeSprite = document.createElement("canvas"); // white suds rim ring
  var sweepSprite = document.createElement("canvas"); // soft leading edge of the sweep
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
    // White suds band just outside the erase radius: it only survives where
    // grime remains, so it always reads as foam on dirt, never as more dirt.
    // Kept subtle — a hot ring reads as a flashlight, not soap.
    eg.addColorStop(0.0, "rgba(255,255,255,0)");
    eg.addColorStop(0.76, "rgba(255,255,255,0)");
    eg.addColorStop(0.85, "rgba(255,255,255,0.55)");
    eg.addColorStop(0.93, "rgba(235,245,250,0.22)");
    eg.addColorStop(1.0, "rgba(235,245,250,0)");
    ec.fillStyle = eg;
    ec.fillRect(0, 0, S, S);

    // Horizontal opaque->transparent strip; scaled at stamp time to soften the
    // squeegee sweep's leading edge.
    sweepSprite.width = 64;
    sweepSprite.height = 2;
    var sc = sweepSprite.getContext("2d");
    var sg = sc.createLinearGradient(0, 0, 64, 0);
    sg.addColorStop(0, "rgba(255,255,255,1)");
    sg.addColorStop(1, "rgba(255,255,255,0)");
    sc.fillStyle = sg;
    sc.fillRect(0, 0, 64, 2);
  }

  /* ----------------------------------------------------------------- Grime */
  var Grime = {
    buildTexture: function () {
      var c = grimeCtx;
      var rng = mulberry32(0xa9c1e5);
      grimeCanvas.width = Math.max(1, Math.round(W * dpr));
      grimeCanvas.height = Math.max(1, Math.round(H * dpr));
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, H);

      // 1. Base wash — the master translucency layer. Warm gray (dirty water is
      //    brown-gray, not blue fog); grime settles downward.
      var base = c.createLinearGradient(0, 0, 0, H);
      base.addColorStop(0, "rgba(96, 94, 88, " + Config.GRIME_ALPHA_TOP + ")");
      base.addColorStop(1, "rgba(74, 72, 66, " + Config.GRIME_ALPHA_BOTTOM + ")");
      c.fillStyle = base;
      c.fillRect(0, 0, W, H);

      // 2. Mottled blobs — organic density variation (taupe dirt / slate filth).
      for (var b = 0; b < 12; b++) {
        var bx = rng() * W;
        var by = rng() * H;
        var br = (0.15 + rng() * 0.3) * Math.max(W, H);
        var taupe = b % 2 === 0;
        var rg = c.createRadialGradient(bx, by, 0, bx, by, br);
        rg.addColorStop(0, taupe ? "rgba(112, 100, 82, 0.2)" : "rgba(52, 56, 62, 0.13)");
        rg.addColorStop(1, "rgba(0,0,0,0)");
        c.fillStyle = rg;
        c.fillRect(0, 0, W, H);
      }

      // 3. Fine noise film — gritty texture, one pattern fill.
      var tile = document.createElement("canvas");
      tile.width = tile.height = 160;
      var tc = tile.getContext("2d");
      var img = tc.createImageData(160, 160);
      for (var p = 0; p < img.data.length; p += 4) {
        var v = 60 + rng() * 50;
        img.data[p] = v;
        img.data[p + 1] = v;
        img.data[p + 2] = v;
        img.data[p + 3] = rng() * 28;
      }
      tc.putImageData(img, 0, 0);
      c.fillStyle = c.createPattern(tile, "repeat");
      c.fillRect(0, 0, W, H);

      // 4. Vertical drip streaks — the "dirty water ran down this screen" read.
      //    Long, plentiful, and some bleeding down from the top edge.
      for (var s = 0; s < 56; s++) {
        var sx = rng() * W;
        var sy = s % 3 === 0 ? -10 : rng() * H * 0.55;
        var len = 120 + rng() * 420;
        var w = 3 + rng() * 8;
        var light = s % 4 === 3; // every 4th is a rain-thinned lighter track
        var col = light ? "176, 180, 178" : "58, 60, 58";
        var alpha = light ? 0.14 : 0.3;
        var lg = c.createLinearGradient(sx, sy, sx, sy + len);
        lg.addColorStop(0, "rgba(" + col + ", " + alpha + ")");
        lg.addColorStop(1, "rgba(" + col + ", 0)");
        c.strokeStyle = lg;
        c.lineWidth = w;
        c.lineCap = "round";
        c.beginPath();
        c.moveTo(sx, sy);
        c.lineTo(sx, sy + len);
        c.stroke();
        // Hanging drip head at the tail.
        c.fillStyle = "rgba(" + col + ", " + alpha * 0.9 + ")";
        c.beginPath();
        c.arc(sx, sy + len, w * 0.9, 0, Math.PI * 2);
        c.fill();
      }

      // 5. Smudge arcs — old half-hearted rag wipes.
      for (var m = 0; m < 10; m++) {
        var mx = rng() * W;
        var my = rng() * H;
        var mr = 80 + rng() * 180;
        var a0 = rng() * Math.PI * 2;
        c.strokeStyle = "rgba(125, 132, 142, 0.08)";
        c.lineWidth = 24 + rng() * 36;
        c.lineCap = "round";
        c.beginPath();
        c.arc(mx, my, mr, a0, a0 + 0.6 + rng() * 0.9);
        c.stroke();
      }

      // 6. Corner vignette — grime heaviest at the edges (satisfying to finish).
      var corners = [[0, 0], [W, 0], [0, H], [W, H]];
      for (var k = 0; k < 4; k++) {
        var cg = c.createRadialGradient(corners[k][0], corners[k][1], 0, corners[k][0], corners[k][1], 0.45 * Math.max(W, H));
        cg.addColorStop(0, "rgba(40, 46, 54, 0.15)");
        cg.addColorStop(1, "rgba(0,0,0,0)");
        c.fillStyle = cg;
        c.fillRect(0, 0, W, H);
      }

      // 7. Clarity tease window — a hint of the page ghosts through near the
      //    CTA zone (off the headline: bait the clean, don't give the read).
      var tg = c.createRadialGradient(W * 0.42, H * 0.62, 0, W * 0.42, H * 0.62, W * 0.28);
      tg.addColorStop(0, "rgba(255,255,255," + Config.TEASE_ALPHA + ")");
      tg.addColorStop(1, "rgba(255,255,255,0)");
      c.globalCompositeOperation = "destination-out";
      c.fillStyle = tg;
      c.fillRect(0, 0, W, H);
      c.globalCompositeOperation = "source-over";

      // 8. Faint top film sheen — reads as a dirty window, not matte paint.
      var sheen = c.createLinearGradient(0, 0, 0, H * 0.35);
      sheen.addColorStop(0, "rgba(200, 206, 214, 0.10)");
      sheen.addColorStop(1, "rgba(200, 206, 214, 0)");
      c.fillStyle = sheen;
      c.fillRect(0, 0, W, H * 0.35);
    },

    // Crisp-with-feather dab stamped into the mask (white = cleaned area),
    // via the pre-rendered sprite so no gradient is allocated on the hot path.
    stampMask: function (x, y, radius) {
      maskCtx.drawImage(brushSprite, x - radius, y - radius, radius * 2, radius * 2);
    },

    // White suds rim stamped into the edge layer, just outside the cleaned hole.
    stampEdge: function (x, y, radius) {
      var r = (radius || Config.BRUSH_RADIUS) * 1.18;
      edgeCtx.drawImage(edgeSprite, x - r, y - r, r * 2, r * 2);
      edgeIdleFrames = 0;
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
      // Fade the suds so foam only lingers where we just cleaned.
      edgeCtx.save();
      edgeCtx.setTransform(1, 0, 0, 1, 0, 0);
      edgeCtx.globalCompositeOperation = "destination-out";
      edgeCtx.fillStyle = "rgba(0,0,0," + Config.EDGE_DECAY + ")";
      edgeCtx.fillRect(0, 0, edgeCanvas.width, edgeCanvas.height);
      edgeCtx.restore();
    },

    draw: function () {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      // Grime base.
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(grimeCanvas, 0, 0, W, H);
      // Suds line added over the grime (additive), before the hole is cut —
      // it can only ever brighten remaining grime, so it always reads as foam.
      // Skipped entirely once the layer has decayed to nothing.
      if (edgeIdleFrames < 40) {
        ctx.globalCompositeOperation = "lighter";
        ctx.drawImage(edgeCanvas, 0, 0, W, H);
      }
      // Subtract the cleaned area in a single drawImage.
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
      // Downscale the MASK (cleaned area) — robust against grime alpha noise.
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
      // Honest bar: reads full exactly when the sweep fires. Near the end it
      // heats up — telegraphing the finale so the sweep reads as earned.
      if (progressFill) {
        var f = Math.min(1, State.cleared / Config.CLEAR_THRESHOLD);
        progressFill.style.transform = "scaleX(" + f + ")";
        if (progressFill.parentNode) {
          progressFill.parentNode.classList.toggle("is-hot", f > 0.85);
        }
      }
      if (State.phase === "playing" && State.cleared >= Config.CLEAR_THRESHOLD) {
        startSweep();
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
        this.pool.push({ active: false, type: "mist", x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 0, size: 0 });
      }
    },
    // Low-cost deterministic "random" stream for spawn variation. Prime
    // modulus so consecutive draws aren't lock-stepped (uniform + uncorrelated
    // enough for particle jitter).
    rand: function () {
      var k = ++this.seq;
      return ((k * 2654435761) % 997) / 997;
    },
    spawnMist: function (count) {
      var tipX = State.nozzle.x + Config.TIP.x;
      var tipY = State.nozzle.y + Config.TIP.y;
      // Base direction: from the spray tip toward the contact point.
      var baseAng = Math.atan2(-Config.TIP.y, -Config.TIP.x);
      var cone = (Config.MIST_CONE_DEG * Math.PI) / 180;
      var made = 0;
      for (var i = 0; i < this.pool.length && made < count; i++) {
        var p = this.pool[i];
        if (p.active) continue;
        var r1 = this.rand();
        var r2 = this.rand();
        var r3 = this.rand();
        var ang = baseAng + (r1 - 0.5) * 2 * cone;
        var speed = Config.MIST_SPEED_MIN + r2 * (Config.MIST_SPEED_MAX - Config.MIST_SPEED_MIN);
        p.type = "mist";
        p.x = tipX + (r3 - 0.5) * 6;
        p.y = tipY + (r1 - 0.5) * 6;
        // Inherit scrub velocity so mist visibly trails a fast wipe.
        p.vx = Math.cos(ang) * speed + State.moveDir.x * State.speed01 * 420;
        p.vy = Math.sin(ang) * speed + State.moveDir.y * State.speed01 * 420;
        p.life = 0;
        p.max = Config.MIST_LIFE_MIN + r3 * (Config.MIST_LIFE_MAX - Config.MIST_LIFE_MIN);
        p.size = 1 + r2 * 1.5;
        p.active = true;
        made++;
      }
    },
    spawnDrips: function (count, ox, oy, vxBias) {
      var made = 0;
      for (var i = 0; i < this.pool.length && made < count; i++) {
        var p = this.pool[i];
        if (p.active) continue;
        var r1 = this.rand();
        var r2 = this.rand();
        p.type = "drip";
        // Bias to the lower half of the cleaned dab so murky drops render
        // over the light revealed site, not over dark grime.
        p.x = ox + (r1 - 0.5) * Config.BRUSH_RADIUS * 1.4;
        p.y = oy + r2 * Config.BRUSH_RADIUS * 0.7;
        p.vx = (r1 - 0.5) * 80 + (vxBias || 0);
        p.vy = 20 + r2 * 60;
        p.life = 0;
        p.max = Config.DRIP_LIFE_MIN + r1 * (Config.DRIP_LIFE_MAX - Config.DRIP_LIFE_MIN);
        p.size = 2 + r2 * 2;
        p.active = true;
        made++;
      }
    },
    // Radial mist fan for tap splashes.
    burstMist: function (count, ox, oy) {
      var made = 0;
      for (var i = 0; i < this.pool.length && made < count; i++) {
        var p = this.pool[i];
        if (p.active) continue;
        var k = ++this.seq;
        var ang = (k * 2.39963) % (Math.PI * 2);
        var r = ((k * 41) % 100) / 100;
        var speed = 260 + r * 320;
        p.type = "mist";
        p.x = ox;
        p.y = oy;
        p.vx = Math.cos(ang) * speed;
        p.vy = Math.sin(ang) * speed;
        p.life = 0;
        p.max = Config.MIST_LIFE_MIN + r * (Config.MIST_LIFE_MAX - Config.MIST_LIFE_MIN);
        p.size = 1 + r * 1.8;
        p.active = true;
        made++;
      }
    },
    update: function (dt) {
      var dts = dt / 1000;
      for (var i = 0; i < this.pool.length; i++) {
        var p = this.pool[i];
        if (!p.active) continue;
        p.life += dt;
        if (p.life >= p.max) {
          p.active = false;
          continue;
        }
        var g = p.type === "mist" ? Config.GRAVITY_MIST : Config.GRAVITY_DRIP;
        p.vy = Math.min(700, p.vy + g * dts);
        if (p.type === "mist") {
          p.vx *= 0.9;
          p.vy *= 0.94;
        }
        p.x += p.vx * dts;
        p.y += p.vy * dts;
      }
    },
    draw: function () {
      ctx.globalCompositeOperation = "source-over";
      ctx.lineCap = "round";
      for (var i = 0; i < this.pool.length; i++) {
        var p = this.pool[i];
        if (!p.active) continue;
        var t = p.life / p.max;
        var alpha = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
        alpha = Math.max(0, alpha);
        var speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        var len = Math.min(14, speed * 0.016);
        if (p.type === "mist") {
          ctx.globalAlpha = alpha * 0.8;
          ctx.strokeStyle = "rgba(222, 238, 252, 1)";
          ctx.fillStyle = "rgba(222, 238, 252, 1)";
        } else {
          ctx.globalAlpha = alpha * 0.85;
          ctx.strokeStyle = "rgba(96, 88, 78, 1)";
          ctx.fillStyle = "rgba(96, 88, 78, 1)";
        }
        if (len > p.size && speed > 1) {
          var ux = p.vx / speed;
          var uy = p.vy / speed;
          ctx.lineWidth = p.size;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - ux * len, p.y - uy * len);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * 0.7, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    },
  };

  /* ------------------------------------------------------------------- FX */
  var FX = {
    on: false,
    userMuted: false, // visitor explicitly muted — never auto-arm again
    actx: null,
    noiseBuf: null,
    src: null,
    gain: null,
    bp: null,
    lastVib: 0,
    ensure: function () {
      if (this.actx) return;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.actx = new AC();
      // White noise buffer — bandpassed live into a spray hiss.
      var len = Math.floor(this.actx.sampleRate * 1.5);
      this.noiseBuf = this.actx.createBuffer(1, len, this.actx.sampleRate);
      var d = this.noiseBuf.getChannelData(0);
      var x = 1234567;
      for (var i = 0; i < len; i++) {
        // xorshift — cheap deterministic white noise
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        d[i] = ((x >>> 0) / 4294967296 - 0.5) * 0.9;
      }
    },
    setEnabled: function (yes) {
      this.on = yes;
      soundBtn.setAttribute("aria-pressed", yes ? "true" : "false");
      if (soundLabel) soundLabel.textContent = yes ? "Sound on" : "Sound off";
      if (yes) {
        this.ensure();
        if (this.actx && this.actx.state === "suspended") this.actx.resume();
      } else {
        this.setSpray(false);
      }
    },
    // Looping spray hiss while the trigger is held.
    setSpray: function (active) {
      if (!this.on || !this.actx) {
        if (!active && this.src) this.stopSrc();
        return;
      }
      if (active && !this.src) {
        this.src = this.actx.createBufferSource();
        this.src.buffer = this.noiseBuf;
        this.src.loop = true;
        this.bp = this.actx.createBiquadFilter();
        this.bp.type = "bandpass";
        this.bp.frequency.value = 2500;
        this.bp.Q.value = 0.8;
        this.gain = this.actx.createGain();
        this.gain.gain.value = 0.0;
        this.src.connect(this.bp).connect(this.gain).connect(this.actx.destination);
        this.src.start();
        this.gain.gain.linearRampToValueAtTime(0.12, this.actx.currentTime + 0.06);
      } else if (!active && this.src) {
        this.stopSrc();
      }
    },
    // Couple the hiss to scrub speed — a frantic wipe should sound frantic.
    updateSpray: function (speed01) {
      if (!this.src || !this.bp || !this.gain) return;
      this.bp.frequency.value = 2400 + speed01 * 900;
      this.gain.gain.value = 0.1 + speed01 * 0.06;
    },
    stopSrc: function () {
      if (!this.src) return;
      try {
        if (this.gain) this.gain.gain.linearRampToValueAtTime(0, this.actx.currentTime + 0.1);
        var s = this.src;
        window.setTimeout(function () {
          try { s.stop(); } catch (e) {}
        }, 120);
      } catch (e) {}
      this.src = null;
      this.gain = null;
      this.bp = null;
    },
    // Short one-shot psshh for tap splashes.
    burstHiss: function () {
      if (!this.on || !this.actx) return;
      var t = this.actx.currentTime;
      var o = this.actx.createBufferSource();
      o.buffer = this.noiseBuf;
      var bp = this.actx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 3200;
      bp.Q.value = 0.9;
      var g = this.actx.createGain();
      g.gain.setValueAtTime(0.22, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      o.connect(bp).connect(g).connect(this.actx.destination);
      o.start(t);
      o.stop(t + 0.2);
    },
    // Rising filtered whoosh under the squeegee sweep.
    sweepWhoosh: function () {
      if (!this.on || !this.actx) return;
      var t = this.actx.currentTime;
      var o = this.actx.createBufferSource();
      o.buffer = this.noiseBuf;
      var bp = this.actx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.setValueAtTime(1200, t);
      bp.frequency.exponentialRampToValueAtTime(4000, t + 0.5);
      bp.Q.value = 1.1;
      var g = this.actx.createGain();
      g.gain.setValueAtTime(0.24, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
      o.connect(bp).connect(g).connect(this.actx.destination);
      o.start(t);
      o.stop(t + 0.6);
    },
    // "All clean" triad blip — the earned payoff.
    ding: function () {
      if (!this.on || !this.actx) return;
      var t0 = this.actx.currentTime;
      var freqs = [1318.5, 1661.2, 1975.5]; // E6 / G#6 / B6
      for (var i = 0; i < freqs.length; i++) {
        var o = this.actx.createOscillator();
        o.type = "sine";
        o.frequency.value = freqs[i];
        var g = this.actx.createGain();
        var t = t0 + i * 0.03;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.17, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        o.connect(g).connect(this.actx.destination);
        o.start(t);
        o.stop(t + 0.4);
      }
    },
    // Throttled: pointermove fires up to 120Hz — restarting the vibration
    // pattern every event reads as one long buzz and drains battery.
    vibrate: function () {
      var t = performance.now();
      if (t - this.lastVib < 90) return;
      this.lastVib = t;
      if (navigator.vibrate) navigator.vibrate(Config.VIBRATE_MS);
    },
  };

  /* ---------------------------------------------------------------- Sweep */
  var Sweep = {
    elapsed: 0,
    dingFired: false,
    dir: { x: 0, y: 0 }, // sweep travel direction in screen coords
    start: function () {
      this.elapsed = 0;
      this.dingFired = false;
      this.dir.x = Math.cos(Config.SWEEP_ANGLE);
      this.dir.y = Math.sin(Config.SWEEP_ANGLE);
      FX.setSpray(false);
      FX.sweepWhoosh();
    },
    tick: function (dt) {
      this.elapsed += dt;
      var t = Math.min(1, this.elapsed / Config.SWEEP_MS);
      var ease = t * t * (3 - 2 * t);
      var diag = Math.sqrt(W * W + H * H);

      // Progressively clear a rotated full-height band, left -> right, with a
      // soft gradient leading edge. It's just aggressive mask stamping, so the
      // destination-out composite and progress sampling need no changes.
      maskCtx.save();
      maskCtx.translate(W / 2, H / 2);
      maskCtx.rotate(Config.SWEEP_ANGLE);
      var x0 = -diag / 2;
      var bandW = ease * diag;
      maskCtx.fillStyle = "rgba(255,255,255,1)";
      if (bandW > 0) maskCtx.fillRect(x0, -diag / 2, bandW, diag);
      maskCtx.drawImage(sweepSprite, x0 + bandW, -diag / 2, 150, diag);
      maskCtx.restore();

      // Trailing drips flung along the squeegee edge.
      var edgeBase = x0 + bandW;
      for (var i = 0; i < 4; i++) {
        var fy = (((this.elapsed * 7 + i * 251) % 997) / 997 - 0.5) * diag;
        // Rotate the edge-local point back into screen coords.
        var ex = W / 2 + edgeBase * this.dir.x - fy * this.dir.y;
        var ey = H / 2 + edgeBase * this.dir.y + fy * this.dir.x;
        if (ex > -40 && ex < W + 40 && ey > -40 && ey < H + 40) {
          Particles.spawnDrips(1, ex, ey, this.dir.x * 250);
        }
      }

      // Sparkle payoff RIDING the squeegee edge — the "clean!" glints track
      // the wipe like they do in PowerWash, flickering per-sparkle.
      if (t > 0.3 && t < 0.98) {
        var bloom = Math.sin(((t - 0.3) / 0.68) * Math.PI);
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = "rgba(255, 255, 255, 1)";
        ctx.strokeStyle = "rgba(255, 255, 255, 1)";
        for (var j = 0; j < 8; j++) {
          var fy2 = (((j * 193) % 997) / 997 - 0.5) * diag * 0.92;
          var back = 30 + ((j * 67) % 120); // trail just behind the edge
          var px = W / 2 + (edgeBase - back) * this.dir.x - fy2 * this.dir.y;
          var py = H / 2 + (edgeBase - back) * this.dir.y + fy2 * this.dir.x;
          if (px < -20 || px > W + 20 || py < -20 || py > H + 20) continue;
          var flicker = 0.55 + 0.45 * Math.sin(this.elapsed * 0.045 + j * 1.9);
          ctx.globalAlpha = bloom * 0.75 * flicker;
          ctx.beginPath();
          ctx.arc(px, py, 2 + (j % 3) * 1.6, 0, Math.PI * 2);
          ctx.fill();
          // Every third sparkle gets a 4-point glint.
          if (j % 3 === 0) {
            var gl = 8 + 12 * bloom * flicker;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(px - gl, py);
            ctx.lineTo(px + gl, py);
            ctx.moveTo(px, py - gl);
            ctx.lineTo(px, py + gl);
            ctx.stroke();
          }
        }
        ctx.restore();
        ctx.globalAlpha = 1;
      }

      if (!this.dingFired && t >= 0.65) {
        this.dingFired = true;
        FX.ding();
        if (navigator.vibrate) navigator.vibrate([12, 40, 12]);
      }
      // A brief white flash lands WITH the ding so muted users get the hit too.
      if (this.dingFired && t < 0.78) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.22 * (1 - (t - 0.65) / 0.13);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
        ctx.globalAlpha = 1;
      }

      // Fade + slight scale pull over the back half.
      if (t > 0.5) {
        var f = (t - 0.5) / 0.5;
        gate.style.opacity = String(1 - f);
        gate.style.transform = "scale(" + (1 + f * 0.04) + ")";
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

      // Skip the suds passes once the layer has fully decayed (~40 frames
      // after the last stamp) — saves 2 of 4 full-screen passes at rest.
      if (edgeIdleFrames < 40) {
        Grime.decayEdge();
        edgeIdleFrames++;
      }
      Grime.draw();
      if (State.phase === "sweeping") Sweep.tick(dt);
      if (State.phase === "playing" && State.pointerDown) {
        // Spray keeps spitting while held; heavier while actually scrubbing.
        Particles.spawnMist(State.moving ? Config.MIST_PER_FRAME : Config.MIST_IDLE_PER_FRAME);
        if (State.moving && State.lastDab) {
          Particles.spawnDrips(Config.DRIP_PER_FRAME, State.lastDab.x, State.lastDab.y, 0);
        }
        if (!State.moving) {
          // Held-still press "soaks through": the clean spot slowly grows and
          // keeps foaming, so a held trigger is never dead input.
          State.holdMs += dt;
          var soakR = Config.BRUSH_RADIUS * (0.35 + 0.65 * Math.min(1, State.holdMs / 1800));
          Grime.stampMask(State.nozzle.x, State.nozzle.y, soakR);
          Grime.stampEdge(State.nozzle.x, State.nozzle.y, soakR * 0.92);
        }
      }
      Particles.update(dt);
      Particles.draw();
      Progress.tick(dt);

      // Ease the scrub-speed signal back down and couple it to the hiss.
      FX.updateSpray(State.speed01);
      State.speed01 *= 0.92;
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
    // First touch is a user gesture — arm the spray sound (biggest juice layer)
    // unless the visitor explicitly muted it. The toggle stays visible.
    if (!FX.on && !FX.userMuted) FX.setEnabled(true);
    gate.classList.add("is-spraying");
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    var p = pointerToCss(e);
    State.nozzle.x = p.x;
    State.nozzle.y = p.y;
    State.lastDab = { x: p.x, y: p.y };
    State.downT = performance.now();
    State.downX = p.x;
    State.downY = p.y;
    State.maxDisp = 0;
    State.holdMs = 0;
    moveNozzleEl(p.x, p.y, 0, true);
    Grime.stampMask(p.x, p.y, Config.BRUSH_RADIUS);
    Grime.stampEdge(p.x, p.y);
    FX.setSpray(true);
    if (e.cancelable) e.preventDefault();
  }

  function onPointerMove(e) {
    var rect = canvas.getBoundingClientRect();
    // Walk every coalesced sample so fast flicks erase curves, not chords.
    var events = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (!events || !events.length) events = [e];
    var p = { x: 0, y: 0 };
    for (var i = 0; i < events.length; i++) {
      p = { x: events[i].clientX - rect.left, y: events[i].clientY - rect.top };
      if (State.pointerDown && State.phase === "playing" && State.lastDab) {
        var mdx = p.x - State.lastDab.x;
        var mdy = p.y - State.lastDab.y;
        var moved = Math.abs(mdx) + Math.abs(mdy);
        if (moved > 0.5) {
          var ml = Math.sqrt(mdx * mdx + mdy * mdy) || 1;
          State.moveDir.x = mdx / ml;
          State.moveDir.y = mdy / ml;
        }
        Grime.eraseSegment(State.lastDab.x, State.lastDab.y, p.x, p.y);
        if (moved > 6) {
          State.moving = true;
          State.holdMs = 0;
          State.speed01 = Math.max(State.speed01, Math.min(1, moved / 28));
          FX.vibrate();
        }
        State.lastDab = { x: p.x, y: p.y };
      }
    }
    var pdx = p.x - State.nozzle.x;
    State.nozzle.x = p.x;
    State.nozzle.y = p.y;
    moveNozzleEl(p.x, p.y, pdx, State.pointerDown);
    if (State.pointerDown && State.phase === "playing") {
      var ddx = p.x - State.downX;
      var ddy = p.y - State.downY;
      State.maxDisp = Math.max(State.maxDisp, Math.sqrt(ddx * ddx + ddy * ddy));
      if (e.cancelable) e.preventDefault();
    }
  }

  function onPointerUp(e) {
    var wasDown = State.pointerDown;
    State.pointerDown = false;
    gate.classList.remove("is-spraying");
    FX.setSpray(false);
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}

    // Tap splash: short AND still, never on pointercancel, only mid-game.
    if (
      wasDown &&
      e.type !== "pointercancel" &&
      State.phase === "playing" &&
      performance.now() - State.downT <= Config.TAP_MS &&
      State.maxDisp <= Config.TAP_MOVE_PX
    ) {
      tapSplash(State.downX, State.downY);
    }
    State.lastDab = null;
  }

  function tapSplash(x, y) {
    // Organic two-lobe splash rather than a perfect circle.
    var k = ++Particles.seq;
    var a = (k * 2.39963) % (Math.PI * 2);
    Grime.stampMask(x, y, Config.TAP_RADIUS);
    Grime.stampMask(x + Math.cos(a) * 30, y + Math.sin(a) * 30, Config.TAP_RADIUS * 0.7);
    // Expanding foam ring: staggered suds stamps + per-frame decay read as a
    // splash ring blooming outward and dissolving. Zero new assets.
    Grime.stampEdge(x, y, Config.TAP_RADIUS * 0.6);
    [70, 130].forEach(function (delay, i) {
      window.setTimeout(function () {
        if (State.phase === "playing" || State.phase === "sweeping") {
          Grime.stampEdge(x, y, Config.TAP_RADIUS * (0.85 + i * 0.3));
        }
      }, delay);
    });
    Particles.burstMist(16, x + Config.TIP.x * 0.4, y + Config.TIP.y * 0.4);
    Particles.spawnDrips(8, x, y, 0);
    FX.burstHiss();
    FX.vibrate();
    if (nozzleInner) {
      nozzleInner.classList.add("is-burst");
      window.setTimeout(function () {
        nozzleInner.classList.remove("is-burst");
      }, 260);
    }
  }

  function moveNozzleEl(x, y, vx, leaning) {
    // Lean the nozzle into horizontal motion while scrubbing.
    var lean = leaning ? Math.max(-10, Math.min(10, (vx || 0) * 0.5)) : 0;
    nozzleEl.style.transform = "translate(" + x + "px," + y + "px) rotate(" + lean + "deg)";
  }

  function onSoundClick() {
    var next = !FX.on;
    FX.userMuted = !next; // an explicit off means never auto-arm again
    FX.setEnabled(next);
  }

  /* ----------------------------------------------------- State transitions */
  function startSweep() {
    if (State.phase !== "playing") return;
    State.phase = "sweeping";
    State.pointerDown = false;
    gate.classList.remove("is-spraying");
    gate.classList.add("is-sweeping");
    Sweep.start();
  }

  var torndown = false;
  function finish() {
    if (torndown) return;
    torndown = true;
    Loop.stop();
    FX.setSpray(false);
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
    State.phase = "sweeping"; // block further play/erase
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
    FX.setSpray(false);
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
      // Preserve cleaned progress across resize by copying the old mask.
      prevMask = document.createElement("canvas");
      prevMask.width = maskCanvas.width;
      prevMask.height = maskCanvas.height;
      prevMask.getContext("2d").drawImage(maskCanvas, 0, 0);
    }

    dpr = Math.min(Config.MAX_DPR, window.devicePixelRatio || 1);
    W = gate.clientWidth;
    H = gate.clientHeight;
    // Scale the brush with the viewport so big screens don't take forever
    // and phones aren't trivially instant.
    Config.BRUSH_RADIUS = Math.max(82, Math.min(120, Math.min(W, H) * 0.11));

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

    Grime.buildTexture();
  }

  /* ----------------------------------------------------------- Listeners */
  function onKey(e) {
    if (e.key === "Escape") skip();
  }

  // Debounced: the grime rebuild costs ~10-30ms, and desktop drag-resize
  // fires continuously. CSS keeps the canvas stretched in the interim.
  var resizeTimer = 0;
  function onResize() {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () {
      if (torndown) return;
      resize();
      // Idle keeps the RAF loop off, so repaint the static frame ourselves —
      // otherwise a resize before the first interaction blanks the gate canvas.
      if (!Loop.running) Grime.draw();
    }, 120);
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
    // Park the nozzle above the hint so the two don't overlap at center.
    State.nozzle.x = W * 0.5;
    State.nozzle.y = H * 0.4;
    moveNozzleEl(W * 0.5, H * 0.4, 0, false);
    // Focus the gate container (not Skip) so keyboard users are one Tab from
    // the controls without spotlighting "Skip intro" with a ring on load.
    gate.setAttribute("tabindex", "-1");
    gate.focus({ preventScroll: true });
    // Draw one static frame; the canvas RAF loop starts on first interaction
    // (CSS animations keep the idle gate alive without burning GPU).
    Grime.draw();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
