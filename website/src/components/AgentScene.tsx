"use client";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export default function AgentGateScene() {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    while (el.firstChild) el.removeChild(el.firstChild);

    const W = 1280, H = 550;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 100);
    camera.setViewOffset(W, H, 0, -100, W, H);
    camera.position.set(0, 0, 16);

    const easeOutBack = (t: number) => {
      const c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    };
    const easeInOut = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    function makeLabel(text: string) {
      const CW = 512, CH = 80;
      const canvas = document.createElement("canvas");
      canvas.width = CW; canvas.height = CH;
      const ctx = canvas.getContext("2d")!;
      ctx.font = "bold 44px monospace";
      ctx.fillStyle = "#555555";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(text, CW / 2, CH);
      const tex = new THREE.CanvasTexture(canvas);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(4.4, 0.96, 1);
      return sprite;
    }

    function updateLabel(sprite: THREE.Sprite, text: string) {
      const CW = 512, CH = 80;
      const canvas = document.createElement("canvas");
      canvas.width = CW; canvas.height = CH;
      const ctx = canvas.getContext("2d")!;
      ctx.font = "bold 44px monospace";
      ctx.fillStyle = "#555555";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(text, CW / 2, CH);
      const tex = new THREE.CanvasTexture(canvas);
      (sprite.material as THREE.SpriteMaterial).map = tex;
      (sprite.material as THREE.SpriteMaterial).needsUpdate = true;
    }

    function makeAgentNode() {
      const group = new THREE.Group();
      const C = 0x555555;
      const wireMat = new THREE.MeshBasicMaterial({ color: C, wireframe: true, transparent: true, opacity: 0 });
      const wire = new THREE.Mesh(new THREE.SphereGeometry(1.26, 10, 7), wireMat);
      group.add(wire);
      const coreMat = new THREE.MeshBasicMaterial({ color: C, transparent: true, opacity: 0 });
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(1.26 * 0.38, 12, 10),
        coreMat
      );
      group.add(core);

      const label = makeLabel("Agent-01");
      label.position.set(0, 1.96, 0);
      group.add(label);

      group.scale.setScalar(0);
      group.position.set(-10.32, -2.5, 0);
      scene.add(group);

      return { group, wire, wireMat, coreMat, core, label, labelMat: label.material };
    }

    function makeServerNode() {
      const group = new THREE.Group();
      const C = 0x555555;

      const cylCount = 4;
      const cylR = 0.91, cylH = 0.28;
      const gap = 0.21;
      const totalH = cylCount * cylH + (cylCount - 1) * gap;
      const startY = -totalH / 2 + cylH / 2;

      const mats: THREE.MeshBasicMaterial[] = [];

      for (let i = 0; i < cylCount; i++) {
        const sideMat = new THREE.MeshBasicMaterial({ color: 0x555555, transparent: true, opacity: 0 });
        const capMat = new THREE.MeshBasicMaterial({ color: 0x888888, transparent: true, opacity: 0 });
        const mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(cylR, cylR, cylH, 28, 1, false),
          [sideMat, capMat, capMat]
        );
        mesh.position.y = startY + i * (cylH + gap);
        group.add(mesh);
        mats.push(sideMat, capMat);
      }

      const padR = 0.2, padY = 0.18;
      const cageR = cylR + padR;
      const cageH = totalH + padY * 2;
      const wireMat = new THREE.MeshBasicMaterial({ color: C, wireframe: true, transparent: true, opacity: 0 });
      const cage = new THREE.Mesh(new THREE.CylinderGeometry(cageR, cageR, cageH, 6, 1, false), wireMat);
      group.add(cage);
      mats.push(wireMat);

      const label = makeLabel("Server");
      label.position.set(0, 1.96, 0);
      group.add(label);

      group.scale.setScalar(0);
      group.position.set(10.32, -2.5, 0);
      scene.add(group);

      return { group, mats, label, labelMat: label.material };
    }

    function makeLogoGroup() {
      const group = new THREE.Group();
      group.scale.setScalar(0);
      group.position.set(0, -2.5, 0);
      scene.add(group);

      const monoMat = new THREE.MeshBasicMaterial({ color: 0x555555 });
      const wireMat = new THREE.MeshBasicMaterial({
        color: 0x555555,
        wireframe: true,
        transparent: true,
        opacity: 0.2,
      });

      const wireBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), wireMat);
      group.add(wireBox);

      const allMats: THREE.Material[] = [monoMat, wireMat];
      let halfWidth = 0;
      let loaded = false;

      const loader = new GLTFLoader();
      loader.load("/key-model.gltf", (gltf) => {
        const model = gltf.scene;

        model.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            (child as THREE.Mesh).material = monoMat;
          }
        });

        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const targetSize = 2.8;
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = targetSize / maxDim;
        model.scale.setScalar(scale);
        model.position.sub(center.multiplyScalar(scale));

        const scaledSize = size.multiplyScalar(scale);
        const padX = 0.6;
        const padY = 0.6;
        const padZ = 0.6;
        wireBox.geometry.dispose();
        wireBox.geometry = new THREE.BoxGeometry(
          scaledSize.x + padX,
          scaledSize.y + padY,
          scaledSize.z + padZ
        );

        halfWidth = (scaledSize.x + padX) / 2;

        group.add(model);
        loaded = true;
      });

      return {
        group,
        wireBox,
        allMats,
        loaded: () => loaded,
        getHitX: () => -halfWidth,
        getHitXRight: () => halfWidth,
      };
    }

    // --- Coin: cylinder with $ on both faces ---
    function makeCoin() {
      const group = new THREE.Group();
      const coinR = 0.45, coinH = 0.12;
      const sideMat = new THREE.MeshBasicMaterial({ color: 0x888888 });
      const faceMat = (() => {
        const S = 256;
        const c = document.createElement("canvas");
        c.width = S; c.height = S;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "#222222";
        ctx.beginPath();
        ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.save();
        ctx.translate(S / 2, S / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.font = "bold 130px monospace";
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("$", 0, 6);
        ctx.restore();
        const tex = new THREE.CanvasTexture(c);
        return new THREE.MeshBasicMaterial({ map: tex, transparent: true });
      })();

      const inner = new THREE.Group();
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(coinR, coinR, coinH, 32, 1, false),
        [sideMat, faceMat, faceMat]
      );
      mesh.rotation.x = Math.PI / 2;
      inner.add(mesh);
      group.add(inner);

      group.visible = false;
      group.scale.setScalar(0);
      scene.add(group);

      return { group, inner, mesh, sideMat, faceMat };
    }

    // --- "Transaction Verified" text sprite ---
    function makeVerifiedText() {
      const CW = 512, CH = 64;
      const c = document.createElement("canvas");
      c.width = CW; c.height = CH;
      const ctx = c.getContext("2d")!;
      ctx.font = "bold 36px monospace";
      ctx.fillStyle = "#555555";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Transaction Verified", CW / 2, CH / 2);
      const tex = new THREE.CanvasTexture(c);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(5.5, 0.72, 1);
      sprite.visible = false;
      scene.add(sprite);
      return { sprite, mat };
    }

    function makePayServerText() {
      const CW = 512, CH = 64;
      const c = document.createElement("canvas");
      c.width = CW; c.height = CH;
      const ctx = c.getContext("2d")!;
      ctx.font = "bold 36px monospace";
      ctx.fillStyle = "#555555";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Pay Server", CW / 2, CH / 2);
      const tex = new THREE.CanvasTexture(c);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(5.5, 0.72, 1);
      sprite.visible = false;
      scene.add(sprite);
      return { sprite, mat };
    }

    const agent = makeAgentNode();
    const logo = makeLogoGroup();
    const server = makeServerNode();
    const coin = makeCoin();
    const verifiedText = makeVerifiedText();
    const payServerText = makePayServerText();

    const payServerState = {
      active: false,
      timer: 0,
      popDur: 0.35,
      holdDur: 1.5,
      fadeDur: 0.5,
      done: false,
    };

    const coinState = {
      active: false,
      timer: 0,
      duration: 1.4,
      jumpHeight: 1.8,
      spins: 2,
      done: false,
    };

    const textState = {
      active: false,
      timer: 0,
      popDur: 0.35,
      holdDur: 1.5,
      fadeDur: 0.5,
      done: false,
    };

    // --- Return line: server → logo (opposite curvature) ---
    const RETURN_SEGMENTS = 60;
    const returnPts = new Float32Array((RETURN_SEGMENTS + 1) * 3);
    const returnGeo = new THREE.BufferGeometry();
    returnGeo.setAttribute("position", new THREE.BufferAttribute(returnPts, 3));
    returnGeo.setDrawRange(0, 0);
    const returnMat = new THREE.LineBasicMaterial({ color: 0x888888, transparent: true, opacity: 0 });
    const returnLine = new THREE.Line(returnGeo, returnMat);
    scene.add(returnLine);

    const returnLineState = {
      phase: "wait" as "wait" | "drawing" | "done",
      timer: 0,
      drawDur: 0.9,
      waitDelay: 0.3,
      triggered: false,
    };

    // --- Key sprite using Keynew.svg ---
    function makeKeySprite() {
      const mat = new THREE.SpriteMaterial({ transparent: true, opacity: 0, depthTest: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(1.0, 0.525, 1);
      sprite.visible = false;
      scene.add(sprite);

      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const tex = new THREE.CanvasTexture(c);
        mat.map = tex;
        mat.needsUpdate = true;
      };
      img.src = "/Keynew.svg";

      return { sprite, mat };
    }

    const keySprite = makeKeySprite();

    const keyState = {
      active: false,
      timer: 0,
      travelDur: 1.2,
      done: false,
    };

    const keyForwardState = {
      active: false,
      timer: 0,
      pauseDur: 0.1,
      travelDur: 1.2,
      phase: "pause" as "pause" | "travel" | "done",
    };

    let agentNumber = 1;
    const AGENT_LABELS = ["Agent-01", "Agent-02", "Agent-03", "Agent-04"];

    const cycleState = {
      active: false,
      timer: 0,
      phase: "idle" as "idle" | "fadeOut" | "pause" | "popIn" | "settle",
      fadeOutDur: 0.5,
      pauseDur: 0.2,
      popInDur: 0.55,
      settleDur: 0.3,
    };

    function getReturnCurvePoint(t: number, fromX: number, fromY: number, toX: number, toY: number) {
      const cpX = (fromX + toX) / 2;
      const cpY = (fromY + toY) / 2 - 1.6;
      const mt = 1 - t;
      return {
        x: mt * mt * fromX + 2 * mt * t * cpX + t * t * toX,
        y: mt * mt * fromY + 2 * mt * t * cpY + t * t * toY,
      };
    }

    function getAgentCurvePoint(t: number, fromX: number, fromY: number, toX: number, toY: number) {
      const cpX = (fromX + toX) / 2;
      const cpY = (fromY + toY) / 2 + 1.6;
      const mt = 1 - t;
      return {
        x: mt * mt * fromX + 2 * mt * t * cpX + t * t * toX,
        y: mt * mt * fromY + 2 * mt * t * cpY + t * t * toY,
      };
    }

    const SEGMENTS = 60;
    const linePts = new Float32Array((SEGMENTS + 1) * 3);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(linePts, 3));
    lineGeo.setDrawRange(0, 0);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x888888, transparent: true, opacity: 0 });
    const lineObj = new THREE.Line(lineGeo, lineMat);
    scene.add(lineObj);

    function makeRippleSprite() {
      const S = 256;
      const canvas = document.createElement("canvas");
      canvas.width = S; canvas.height = S;
      const mat = new THREE.SpriteMaterial({ transparent: true, opacity: 0, depthTest: false });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.scale.set(1, 1, 1);
      scene.add(sprite);
      return { sprite, mat, canvas };
    }

    const ripples = [makeRippleSprite(), makeRippleSprite()];
    const rippleState = { active: false, timer: 0, triggered: false };

    function updateRipple(r: ReturnType<typeof makeRippleSprite>, t: number, delay: number) {
      const S = 256;
      const lt = Math.max(0, t - delay);
      const dur = 0.7;
      const p = Math.min(lt / dur, 1);
      if (p <= 0 || p >= 1) { r.sprite.visible = false; return; }
      r.sprite.visible = true;
      const radius = p * (S * 0.46);
      const op = p < 0.3 ? p / 0.3 : 1 - (p - 0.3) / 0.7;
      const ctx = r.canvas.getContext("2d")!;
      ctx.clearRect(0, 0, S, S);
      ctx.strokeStyle = `rgba(85,85,85,${op.toFixed(2)})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(S / 2, S / 2, radius, 0, Math.PI * 2);
      ctx.stroke();
      const tex = new THREE.CanvasTexture(r.canvas);
      r.mat.map = tex;
      r.mat.opacity = 1;
      r.mat.needsUpdate = true;
      tex.needsUpdate = true;
      const ws = (radius / (S / 2)) * 2.5;
      r.sprite.scale.set(ws, ws, 1);
    }

    const lineState = {
      phase: "wait" as "wait" | "drawing" | "done",
      timer: 0,
      drawDur: 0.9,
      waitDelay: 0.6,
    };

    const LINE_FROM_X = -10.32;
    const LINE_TO_X = 0;
    const POP_DUR = 0.55;
    const nodes = [
      { obj: agent, delay: 0.2, t: 0, done: false, type: "agent" as const },
      { obj: server, delay: 0.2, t: 0, done: false, type: "server" as const },
      { obj: logo, delay: 1.0, t: 0, done: false, type: "logo" as const, loadReady: false },
    ];

    const floats = [
      { phase: Math.random() * Math.PI * 2, speed: 0.65, amp: 0.08 },
      { phase: Math.random() * Math.PI * 2, speed: 0.7, amp: 0.07 },
      { phase: Math.random() * Math.PI * 2, speed: 0.6, amp: 0.09 },
    ];

    const cam = { radius: 16 };

    const drag = {
      active: false,
      startX: 0, startY: 0,
      offsetTheta: 0, offsetPhi: 0,
      targetTheta: 0, targetPhi: 0,
    };
    const MAX_DRAG = 28 * (Math.PI / 180);

    const canvasEl = renderer.domElement;
    canvasEl.style.cursor = "grab";

    function onPointerDown(e: MouseEvent | TouchEvent) {
      drag.active = true;
      const cx = "clientX" in e ? e.clientX : e.touches?.[0]?.clientX ?? 0;
      const cy = "clientY" in e ? e.clientY : e.touches?.[0]?.clientY ?? 0;
      drag.startX = cx;
      drag.startY = cy;
      canvasEl.style.cursor = "grabbing";
    }
    function onPointerMove(e: MouseEvent | TouchEvent) {
      if (!drag.active) return;
      const cx = "clientX" in e ? e.clientX : e.touches?.[0]?.clientX ?? 0;
      const cy = "clientY" in e ? e.clientY : e.touches?.[0]?.clientY ?? 0;
      const dx = (cx - drag.startX) / W;
      const dy = (cy - drag.startY) / H;
      drag.targetTheta = Math.max(-MAX_DRAG, Math.min(MAX_DRAG, dx * Math.PI));
      drag.targetPhi = Math.max(-MAX_DRAG, Math.min(MAX_DRAG, dy * Math.PI * 0.6));
    }
    function onPointerUp() {
      drag.active = false;
      canvasEl.style.cursor = "grab";
    }

    canvasEl.addEventListener("mousedown", onPointerDown);
    canvasEl.addEventListener("mousemove", onPointerMove);
    canvasEl.addEventListener("mouseup", onPointerUp);
    canvasEl.addEventListener("mouseleave", onPointerUp);
    canvasEl.addEventListener("touchstart", onPointerDown, { passive: true });
    canvasEl.addEventListener("touchmove", onPointerMove, { passive: true });
    canvasEl.addEventListener("touchend", onPointerUp);

    let clock = 0;
    let animId: number;
    let lastTime: number | null = null;

    type NodeEntry = typeof nodes[number];

    function setNodeOpacity(node: NodeEntry, op: number) {
      if (node.type === "agent") {
        node.obj.wireMat.opacity = op * 0.85;
        node.obj.coreMat.opacity = op;
        node.obj.labelMat.opacity = op;
      } else if (node.type === "server") {
        const allMats = node.obj.mats;
        const wireMat = allMats[allMats.length - 1];
        allMats.forEach((m) => {
          m.opacity = m === wireMat ? op * 0.45 : op;
        });
        node.obj.labelMat.opacity = op;
      } else {
        node.obj.allMats.forEach((m) => {
          if ("opacity" in m) {
            (m as THREE.MeshBasicMaterial).transparent = op < 1;
            (m as THREE.MeshBasicMaterial).opacity = op;
          }
        });
      }
    }

    function setNodeScale(node: NodeEntry, s: number) {
      node.obj.group.scale.setScalar(s);
    }

    function getNodeMesh(node: NodeEntry) {
      return node.obj.group;
    }

    function animate(now: number) {
      animId = requestAnimationFrame(animate);
      if (lastTime === null) { lastTime = now; }
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      clock += dt;

      nodes.forEach((node) => {
        if (node.done) return;
        if (node.type === "logo" && !logo.loaded()) return;
        node.t += dt;
        const elapsed = node.t - node.delay;
        if (elapsed < 0) return;

        const raw = Math.min(elapsed / POP_DUR, 1);
        const scale = easeOutBack(raw);
        const op = Math.min(elapsed / (POP_DUR * 0.4), 1);

        setNodeScale(node, scale);
        setNodeOpacity(node, op);

        if (raw >= 1) {
          node.done = true;
          setNodeScale(node, 1);
          setNodeOpacity(node, 1);
        }
      });

      nodes.forEach((node, i) => {
        if (node.t < node.delay) return;
        const f = floats[i];
        const y = Math.sin(clock * f.speed + f.phase) * f.amp;
        const mesh = getNodeMesh(node);
        mesh.position.y = y;
      });

      server.group.rotation.y = Math.sin(clock * 0.4) * 0.18;

      if (agent.wire) {
        agent.wire.rotation.y += dt * 0.3;
        agent.wire.rotation.x += dt * 0.1;
      }

      if (logo.loaded() && logo.group.scale.x > 0.05) {
        const baseAngle = (-35 * Math.PI) / 180;
        const maxOffset = (20 * Math.PI) / 180;
        const angle = baseAngle + Math.sin(clock * 0.6) * maxOffset;
        logo.group.rotation.y = angle;
        logo.wireBox.rotation.y = angle;
      }

      const allDone = nodes.every((n) => n.done);
      if (allDone) {
        lineState.timer += dt;
      }

      if (lineState.phase === "wait" && lineState.timer >= lineState.waitDelay) {
        lineState.phase = "drawing";
        lineState.timer = 0;
        lineMat.opacity = 1;
      }

      if (lineState.phase === "drawing" || lineState.phase === "done") {
        const raw =
          lineState.phase === "done"
            ? 1
            : Math.min(lineState.timer / lineState.drawDur, 1);

        const agentY = agent.group.position.y;
        const logoY = logo.group.position.y;
        const fromX = LINE_FROM_X;
        const fromY = agentY;
        const toX = logo.loaded() ? logo.getHitX() : LINE_TO_X;
        const toY = logoY;

        const cpX = (fromX + toX) / 2;
        const cpY = (fromY + toY) / 2 + 1.6;

        const tipIdx = Math.floor(raw * SEGMENTS);
        for (let i = 0; i <= tipIdx; i++) {
          const t2 = i / SEGMENTS;
          const mt = 1 - t2;
          linePts[i * 3] = mt * mt * fromX + 2 * mt * t2 * cpX + t2 * t2 * toX;
          linePts[i * 3 + 1] = mt * mt * fromY + 2 * mt * t2 * cpY + t2 * t2 * toY;
          linePts[i * 3 + 2] = 0;
        }
        lineGeo.attributes.position.needsUpdate = true;
        lineGeo.setDrawRange(0, tipIdx + 1);

        if (lineState.phase === "drawing" && raw >= 1) {
          lineState.phase = "done";
          rippleState.active = true;
          rippleState.timer = 0;
          rippleState.triggered = true;
          if (!payServerState.active && !payServerState.done) {
            payServerState.active = true;
            payServerState.timer = 0;
            payServerText.sprite.visible = true;
            payServerText.sprite.position.set(
              logo.group.position.x,
              logo.group.position.y + 2.8,
              0.2
            );
          }
        }
        if (lineState.phase === "drawing") lineState.timer += dt;
      }

      if (rippleState.active) {
        rippleState.timer += dt;
        const logoY = logo.group.position.y;
        const hitX = logo.loaded() ? logo.getHitX() : LINE_TO_X;
        ripples.forEach((r) => r.sprite.position.set(hitX, logoY, 0.2));
        updateRipple(ripples[0], rippleState.timer, 0);
        updateRipple(ripples[1], rippleState.timer, 0.25);
        if (rippleState.timer > 1.4) {
          rippleState.timer = 0;
        }
      }

      // --- "Pay Server" text: pop in, hold, fade out ---
      if (payServerState.active && !payServerState.done) {
        payServerState.timer += dt;
        const { popDur, holdDur, fadeDur } = payServerState;
        const total = popDur + holdDur + fadeDur;
        const t = payServerState.timer;

        if (t < popDur) {
          const p = t / popDur;
          payServerText.mat.opacity = easeOutBack(p);
          const s = easeOutBack(p);
          payServerText.sprite.scale.set(5.5 * s, 0.72 * s, 1);
        } else if (t < popDur + holdDur) {
          payServerText.mat.opacity = 1;
          payServerText.sprite.scale.set(5.5, 0.72, 1);
        } else if (t < total) {
          const fadeT = (t - popDur - holdDur) / fadeDur;
          payServerText.mat.opacity = 1 - fadeT;
        } else {
          payServerState.done = true;
          payServerState.active = false;
          payServerText.sprite.visible = false;
          payServerText.mat.opacity = 0;
          if (!coinState.active && !coinState.done) {
            coinState.active = true;
            coinState.timer = 0;
            coin.group.visible = true;
          }
        }

        payServerText.sprite.position.y = logo.group.position.y + 2.8;
      }

      // --- Coin Mario arc animation ---
      if (coinState.active && !coinState.done) {
        coinState.timer += dt;
        const t = Math.min(coinState.timer / coinState.duration, 1);

        const serverX = server.group.position.x;
        const serverY = server.group.position.y;
        const arcY = -4 * (t - 0.5) * (t - 0.5) + 1;
        const coinY = serverY + 1.8 + arcY * coinState.jumpHeight;

        coin.group.position.set(serverX, coinY, 0);

        const popScale = t < 0.1 ? easeOutBack(t / 0.1) : 1;
        coin.group.scale.setScalar(popScale);

        coin.inner.rotation.y = t * coinState.spins * Math.PI * 2;

        if (t >= 1) {
          coinState.done = true;
          coinState.active = false;
          coin.group.visible = false;
          if (!textState.active && !textState.done) {
            textState.active = true;
            textState.timer = 0;
            verifiedText.sprite.visible = true;
            verifiedText.sprite.position.set(
              logo.group.position.x,
              logo.group.position.y + 2.8,
              0.2
            );
          }
        }
      }

      // --- "Transaction Verified" text: pop in, hold, fade out ---
      if (textState.active && !textState.done) {
        textState.timer += dt;
        const { popDur, holdDur, fadeDur } = textState;
        const total = popDur + holdDur + fadeDur;
        const t = textState.timer;

        if (t < popDur) {
          const p = t / popDur;
          verifiedText.mat.opacity = easeOutBack(p);
          const s = easeOutBack(p);
          verifiedText.sprite.scale.set(5.5 * s, 0.72 * s, 1);
        } else if (t < popDur + holdDur) {
          verifiedText.mat.opacity = 1;
          verifiedText.sprite.scale.set(5.5, 0.72, 1);
        } else if (t < total) {
          const fadeT = (t - popDur - holdDur) / fadeDur;
          verifiedText.mat.opacity = 1 - fadeT;
        } else {
          textState.done = true;
          textState.active = false;
          verifiedText.sprite.visible = false;
          verifiedText.mat.opacity = 0;
          rippleState.active = false;
          ripples.forEach((r) => {
            r.sprite.visible = false;
          });
          if (!returnLineState.triggered) {
            returnLineState.triggered = true;
            returnLineState.phase = "wait";
            returnLineState.timer = 0;
          }
        }

        verifiedText.sprite.position.y = logo.group.position.y + 2.8;
      }

      // --- Return line: server → logo (opposite curvature, drawn right-to-left) ---
      if (returnLineState.triggered) {
        if (returnLineState.phase === "wait") {
          returnLineState.timer += dt;
          if (returnLineState.timer >= returnLineState.waitDelay) {
            returnLineState.phase = "drawing";
            returnLineState.timer = 0;
            returnMat.opacity = 1;
          }
        }

        if (returnLineState.phase === "drawing" || returnLineState.phase === "done") {
          const raw =
            returnLineState.phase === "done"
              ? 1
              : Math.min(returnLineState.timer / returnLineState.drawDur, 1);

          const serverY = server.group.position.y;
          const logoY = logo.group.position.y;
          const fromX = 10.32;
          const fromY = serverY;
          const toX = logo.loaded() ? logo.getHitXRight() : 0;
          const toY = logoY;

          const tipIdx = Math.floor(raw * RETURN_SEGMENTS);
          for (let i = 0; i <= tipIdx; i++) {
            const t2 = i / RETURN_SEGMENTS;
            const pt = getReturnCurvePoint(t2, fromX, fromY, toX, toY);
            returnPts[i * 3] = pt.x;
            returnPts[i * 3 + 1] = pt.y;
            returnPts[i * 3 + 2] = 0;
          }
          returnGeo.attributes.position.needsUpdate = true;
          returnGeo.setDrawRange(0, tipIdx + 1);

          if (returnLineState.phase === "drawing" && raw >= 1) {
            returnLineState.phase = "done";
            if (!keyState.active && !keyState.done) {
              keyState.active = true;
              keyState.timer = 0;
              keySprite.sprite.visible = true;
              keySprite.mat.opacity = 1;
            }
          }
          if (returnLineState.phase === "drawing") returnLineState.timer += dt;
        }
      }

      // --- Key traveling along the return curve (server → logo) ---
      if (keyState.active && !keyState.done) {
        keyState.timer += dt;
        const t = Math.min(keyState.timer / keyState.travelDur, 1);

        const serverY = server.group.position.y;
        const logoY = logo.group.position.y;
        const fromX = 10.32;
        const fromY = serverY;
        const toX = logo.loaded() ? logo.getHitXRight() : 0;
        const toY = logoY;

        const pt = getReturnCurvePoint(t, fromX, fromY, toX, toY);
        keySprite.sprite.position.set(pt.x, pt.y, 0.3);
        keySprite.sprite.scale.set(1.0, 0.525, 1);

        const op = t < 0.2 ? t / 0.2 : t > 0.8 ? (1 - t) / 0.2 : 1;
        keySprite.mat.opacity = op;

        if (t >= 1) {
          keyState.done = true;
          keyState.active = false;
          keyForwardState.active = true;
          keyForwardState.timer = 0;
          keyForwardState.phase = "pause";
        }
      }

      // --- Key traveling along the agent curve (logo → agent) ---
      if (keyForwardState.active && keyForwardState.phase !== "done") {
        keyForwardState.timer += dt;

        if (keyForwardState.phase === "pause") {
          if (keyForwardState.timer >= keyForwardState.pauseDur) {
            keyForwardState.phase = "travel";
            keyForwardState.timer = 0;
          }
        }

        if (keyForwardState.phase === "travel") {
          const t = Math.min(keyForwardState.timer / keyForwardState.travelDur, 1);

          const logoY = logo.group.position.y;
          const agentY = agent.group.position.y;
          const fromX = logo.loaded() ? logo.getHitX() : 0;
          const fromY = logoY;
          const toX = LINE_FROM_X;
          const toY = agentY;

          const pt = getAgentCurvePoint(t, fromX, fromY, toX, toY);
          keySprite.sprite.position.set(pt.x, pt.y, 0.3);

          const op = t < 0.2 ? t / 0.2 : t > 0.8 ? (1 - t) / 0.2 : 1;
          keySprite.mat.opacity = op;

          if (t >= 1) {
            keyForwardState.phase = "done";
            keyForwardState.active = false;
            keySprite.sprite.visible = false;
            keySprite.mat.opacity = 0;
            if (!cycleState.active) {
              cycleState.active = true;
              cycleState.timer = 0;
              cycleState.phase = "fadeOut";
            }
          }
        }
      }

      // --- Cycle: fade out lines+agent, swap label, pop in new agent, restart loop ---
      if (cycleState.active && cycleState.phase !== "idle") {
        cycleState.timer += dt;

        if (cycleState.phase === "fadeOut") {
          const p = Math.min(cycleState.timer / cycleState.fadeOutDur, 1);
          const op = 1 - p;
          lineMat.opacity = op;
          returnMat.opacity = op;
          const agentNode = nodes[0];
          setNodeOpacity(agentNode, op);

          if (p >= 1) {
            lineMat.opacity = 0;
            returnMat.opacity = 0;
            lineGeo.setDrawRange(0, 0);
            returnGeo.setDrawRange(0, 0);
            setNodeOpacity(nodes[0], 0);
            setNodeScale(nodes[0], 0);
            agent.group.scale.setScalar(0);

            agentNumber = (agentNumber % 4) + 1;
            updateLabel(agent.label, AGENT_LABELS[agentNumber - 1]);

            cycleState.phase = "pause";
            cycleState.timer = 0;
          }
        }

        if (cycleState.phase === "pause") {
          if (cycleState.timer >= cycleState.pauseDur) {
            cycleState.phase = "popIn";
            cycleState.timer = 0;
          }
        }

        if (cycleState.phase === "popIn") {
          const raw = Math.min(cycleState.timer / cycleState.popInDur, 1);
          const scale = easeOutBack(raw);
          const op = Math.min(cycleState.timer / (cycleState.popInDur * 0.4), 1);
          agent.group.scale.setScalar(scale);
          setNodeOpacity(nodes[0], op);

          if (raw >= 1) {
            agent.group.scale.setScalar(1);
            setNodeOpacity(nodes[0], 1);
            cycleState.phase = "settle";
            cycleState.timer = 0;
          }
        }

        if (cycleState.phase === "settle") {
          if (cycleState.timer >= cycleState.settleDur) {
            cycleState.phase = "idle";
            cycleState.active = false;

            lineState.phase = "wait";
            lineState.timer = 0;
            lineMat.opacity = 0;

            payServerState.active = false;
            payServerState.timer = 0;
            payServerState.done = false;
            payServerText.sprite.visible = false;
            payServerText.mat.opacity = 0;

            coinState.active = false;
            coinState.timer = 0;
            coinState.done = false;
            coin.group.visible = false;
            coin.group.scale.setScalar(0);

            textState.active = false;
            textState.timer = 0;
            textState.done = false;
            verifiedText.sprite.visible = false;
            verifiedText.mat.opacity = 0;

            returnLineState.triggered = false;
            returnLineState.phase = "wait";
            returnLineState.timer = 0;
            returnMat.opacity = 0;

            keyState.active = false;
            keyState.timer = 0;
            keyState.done = false;
            keySprite.sprite.visible = false;
            keySprite.mat.opacity = 0;

            keyForwardState.active = false;
            keyForwardState.timer = 0;
            keyForwardState.phase = "pause";

            rippleState.active = false;
            rippleState.timer = 0;
            rippleState.triggered = false;
            ripples.forEach((r) => { r.sprite.visible = false; });

            nodes[0].done = true;
            nodes[0].t = 10;

            lineState.timer = 0;
            lineState.phase = "drawing";
            lineState.timer = 0;
            lineMat.opacity = 1;
          }
        }
      }

      const lerpSpeed = drag.active ? 12 : 4;
      drag.offsetTheta += (drag.targetTheta - drag.offsetTheta) * Math.min(lerpSpeed * dt, 1);
      drag.offsetPhi += (drag.targetPhi - drag.offsetPhi) * Math.min(lerpSpeed * dt, 1);
      if (!drag.active) {
        drag.targetTheta *= 0.92;
        drag.targetPhi *= 0.92;
      }

      const theta = drag.offsetTheta;
      const phi = (10 * Math.PI / 180) + drag.offsetPhi;
      const r = cam.radius;
      camera.position.set(
        Math.sin(theta) * Math.cos(phi) * r,
        Math.sin(phi) * r,
        Math.cos(theta) * Math.cos(phi) * r
      );
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);
    }

    animate(performance.now());

    return () => {
      cancelAnimationFrame(animId);
      canvasEl.removeEventListener("mousedown", onPointerDown);
      canvasEl.removeEventListener("mousemove", onPointerMove);
      canvasEl.removeEventListener("mouseup", onPointerUp);
      canvasEl.removeEventListener("mouseleave", onPointerUp);
      canvasEl.removeEventListener("touchstart", onPointerDown);
      canvasEl.removeEventListener("touchmove", onPointerMove);
      canvasEl.removeEventListener("touchend", onPointerUp);
      renderer.dispose();
      if (el.contains(renderer.domElement)) {
        el.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div
      ref={mountRef}
      style={{
        width: "1280px",
        height: "550px",
        background: "#E8E8E8",
        overflow: "hidden",
      }}
    />
  );
}
