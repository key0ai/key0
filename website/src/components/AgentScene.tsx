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

    const size = { w: 1280, h: 550 };
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(size.w, size.h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, size.w / size.h, 0.1, 100);
    camera.setViewOffset(size.w, size.h, 0, -100, size.w, size.h);
    camera.position.set(0, 0, 16);

    function onResize(entries?: ResizeObserverEntry[]) {
      const target = entries?.[0]?.target ?? el;
      if (!target || !(target instanceof HTMLElement)) return;
      const rect = target.getBoundingClientRect();
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w <= 0 || h <= 0) return;
      size.w = w;
      size.h = h;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      const viewY = Math.round(-100 * (h / 550));
      camera.setViewOffset(w, h, 0, viewY, w, h);
      camera.updateProjectionMatrix();
    }

    const ro = new ResizeObserver((entries) => onResize(entries));
    ro.observe(el);
    onResize();

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
      ctx.font = "bold 44px 'DM Mono', monospace";
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

    function makeAgentNode(labelText: string) {
      const group = new THREE.Group();
      const C = 0x3a3a3a;
      const wireMat = new THREE.MeshBasicMaterial({ color: C, wireframe: true, transparent: true, opacity: 0 });
      const wire = new THREE.Mesh(new THREE.SphereGeometry(1.26, 10, 7), wireMat);
      group.add(wire);
      const coreMat = new THREE.MeshBasicMaterial({ color: C, transparent: true, opacity: 0 });
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(1.26 * 0.38, 12, 10),
        coreMat
      );
      group.add(core);

      const label = makeLabel(labelText);
      label.position.set(0, 1.96, 0);
      group.add(label);

      group.scale.setScalar(0);
      group.position.set(-10.32, -2.5, 0);
      scene.add(group);

      return { group, wire, wireMat, coreMat, core, label, labelMat: label.material };
    }

    function makeServerNode() {
      const group = new THREE.Group();
      const C = 0x3a3a3a;

      const cylCount = 4;
      const cylR = 0.91, cylH = 0.28;
      const gap = 0.21;
      const totalH = cylCount * cylH + (cylCount - 1) * gap;
      const startY = -totalH / 2 + cylH / 2;

      const mats: THREE.MeshBasicMaterial[] = [];

      for (let i = 0; i < cylCount; i++) {
        const sideMat = new THREE.MeshBasicMaterial({ color: 0x3a3a3a, transparent: true, opacity: 0 });
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

      const monoMat = new THREE.MeshBasicMaterial({ color: 0x3a3a3a });
      const wireMat = new THREE.MeshBasicMaterial({
        color: 0x3a3a3a,
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
        ctx.fillStyle = "#101010";
        ctx.beginPath();
        ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.save();
        ctx.translate(S / 2, S / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.font = "bold 130px 'DM Mono', monospace";
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
      const c = document.createElement("canvas");
      const ctx = c.getContext("2d")!;

      // Use same font size, measure text to size the pill
      ctx.font = "bold 36px 'DM Mono', monospace";
      const metrics = ctx.measureText("Transaction Verified");
      const textWidth = metrics.width;

      const padX = 16;
      const padTop = 12;
      const padBottom = 8;
      const textHeight = 36;
      const CW = textWidth + padX * 2;
      const CH = textHeight + padTop + padBottom;

      // Setting width/height resets context state; reapply font
      c.width = CW;
      c.height = CH;
      ctx.font = "bold 36px 'DM Mono', monospace";

      // Draw rounded rectangle background
      const radius = 16;
      ctx.beginPath();
      ctx.moveTo(radius, 0);
      ctx.lineTo(CW - radius, 0);
      ctx.quadraticCurveTo(CW, 0, CW, radius);
      ctx.lineTo(CW, CH - radius);
      ctx.quadraticCurveTo(CW, CH, CW - radius, CH);
      ctx.lineTo(radius, CH);
      ctx.quadraticCurveTo(0, CH, 0, CH - radius);
      ctx.lineTo(0, radius);
      ctx.quadraticCurveTo(0, 0, radius, 0);
      ctx.closePath();

      ctx.fillStyle = "#1a1a1a";
      ctx.fill();

      // Draw text
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      const textY = padTop + textHeight * 0.8;
      ctx.fillText("Transaction Verified", CW / 2, textY);
      const tex = new THREE.CanvasTexture(c);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(5.5, 0.72, 1);
      sprite.visible = false;
      scene.add(sprite);
      return { sprite, mat };
    }

    function makePayServerText() {
      const c = document.createElement("canvas");
      const ctx = c.getContext("2d")!;
    
      // Measure first — same pattern as makeVerifiedText
      ctx.font = "bold 36px 'DM Mono', monospace";
      const metrics = ctx.measureText("Pay Server");
      const textWidth = metrics.width;
    
      const padX = 16;
      const padTop = 12;
      const padBottom = 8;
      const textHeight = 36;
      const CW = textWidth + padX * 2;
      const CH = textHeight + padTop + padBottom;
    
      // Reset canvas size (clears context state — reapply font)
      c.width = CW;
      c.height = CH;
      ctx.font = "bold 36px 'DM Mono', monospace";
    
      const radius = 8;
      ctx.beginPath();
      ctx.moveTo(radius, 0);
      ctx.lineTo(CW - radius, 0);
      ctx.quadraticCurveTo(CW, 0, CW, radius);
      ctx.lineTo(CW, CH - radius);
      ctx.quadraticCurveTo(CW, CH, CW - radius, CH);
      ctx.lineTo(radius, CH);
      ctx.quadraticCurveTo(0, CH, 0, CH - radius);
      ctx.lineTo(0, radius);
      ctx.quadraticCurveTo(0, 0, radius, 0);
      ctx.closePath();
      ctx.fillStyle = "#1a1a1a";
      ctx.fill();
    
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillText("Pay Server", CW / 2, padTop + textHeight * 0.8);
    
      const tex = new THREE.CanvasTexture(c);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false });
      const sprite = new THREE.Sprite(mat);
    
      // Derive world scale from canvas aspect — same as makeVerifiedText uses 5.5
      const worldH = 0.72;
      const worldW = worldH * (CW / CH);
      sprite.scale.set(worldW, worldH, 1);
    
      sprite.visible = false;
      scene.add(sprite);
      return { sprite, mat, worldW, worldH }; // expose for animation
    }

    const agent = makeAgentNode("Agent-01");
    const agent2 = makeAgentNode("Agent-02");
    agent2.group.visible = false;
    const agent3 = makeAgentNode("Agent-03");
    agent3.group.visible = false;
    const logo = makeLogoGroup();
    const server = makeServerNode();
    const coin = makeCoin();
    const verifiedText = makeVerifiedText();
    const payServerText = makePayServerText();

    let activeAgent = agent;

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
        ctx.globalCompositeOperation = "source-in";
        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(0, 0, c.width, c.height);
        const tex = new THREE.CanvasTexture(c);
        mat.map = tex;
        mat.needsUpdate = true;
      };
      img.src = "/Keynew.svg";

      return { sprite, mat };
    }

    const keySprite = makeKeySprite();

    function makeAgent1TransSprite() {
      const mat = new THREE.SpriteMaterial({ transparent: true, opacity: 0, depthTest: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(4.2 * 1.5, 0.72 * 1.5, 1);
      sprite.visible = false;
      scene.add(sprite);

      const img = new Image();
      let texNormal: THREE.CanvasTexture | null = null;
      let texScaled: THREE.CanvasTexture | null = null;

      function applyBgColor(c: HTMLCanvasElement, ctx: CanvasRenderingContext2D, bgHex: number) {
        const r = (bgHex >> 16) & 0xff, g = (bgHex >> 8) & 0xff, b = bgHex & 0xff;
        const imgData = ctx.getImageData(0, 0, c.width, c.height);
        const data = imgData.data;
        const tol = 25;
        for (let i = 0; i < data.length; i += 4) {
          const dr = Math.abs(data[i] - 0xD8), dg = Math.abs(data[i + 1] - 0xD8), db = Math.abs(data[i + 2] - 0xD8);
          if (dr < tol && dg < tol && db < tol && data[i + 3] > 200) {
            data[i] = r; data[i + 1] = g; data[i + 2] = b;
          }
        }
        ctx.putImageData(imgData, 0, 0);
      }

      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        texNormal = new THREE.CanvasTexture(c);
        mat.map = texNormal;
        mat.needsUpdate = true;

        const c2 = document.createElement("canvas");
        c2.width = img.naturalWidth;
        c2.height = img.naturalHeight;
        const ctx2 = c2.getContext("2d")!;
        ctx2.drawImage(img, 0, 0);
        applyBgColor(c2, ctx2, 0xbebebe);
        texScaled = new THREE.CanvasTexture(c2);
      };
      img.src = "/Agent1trans.svg";

      return { sprite, mat, setScaledBg: () => { if (texScaled) { mat.map = texScaled; mat.needsUpdate = true; } }, setNormalBg: () => { if (texNormal) { mat.map = texNormal; mat.needsUpdate = true; } } };
    }

    const agent1transSprite = makeAgent1TransSprite();

    function makeAgent2TransSprite() {
      const mat = new THREE.SpriteMaterial({ transparent: true, opacity: 0, depthTest: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(4.2 * 1.5, 0.72 * 1.5, 1);
      sprite.visible = false;
      scene.add(sprite);

      const img = new Image();
      let texNormal: THREE.CanvasTexture | null = null;
      let texScaled: THREE.CanvasTexture | null = null;

      function applyBgColor(c: HTMLCanvasElement, ctx: CanvasRenderingContext2D, bgHex: number) {
        const r = (bgHex >> 16) & 0xff, g = (bgHex >> 8) & 0xff, b = bgHex & 0xff;
        const imgData = ctx.getImageData(0, 0, c.width, c.height);
        const data = imgData.data;
        const tol = 25;
        for (let i = 0; i < data.length; i += 4) {
          const dr = Math.abs(data[i] - 0xD9), dg = Math.abs(data[i + 1] - 0xD9), db = Math.abs(data[i + 2] - 0xD9);
          if (dr < tol && dg < tol && db < tol && data[i + 3] > 200) {
            data[i] = r; data[i + 1] = g; data[i + 2] = b;
          }
        }
        ctx.putImageData(imgData, 0, 0);
      }

      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        texNormal = new THREE.CanvasTexture(c);
        mat.map = texNormal;
        mat.needsUpdate = true;

        const c2 = document.createElement("canvas");
        c2.width = img.naturalWidth;
        c2.height = img.naturalHeight;
        const ctx2 = c2.getContext("2d")!;
        ctx2.drawImage(img, 0, 0);
        applyBgColor(c2, ctx2, 0xbebebe);
        texScaled = new THREE.CanvasTexture(c2);
      };
      img.src = "/Agent2trans.svg";

      return { sprite, mat, setScaledBg: () => { if (texScaled) { mat.map = texScaled; mat.needsUpdate = true; } }, setNormalBg: () => { if (texNormal) { mat.map = texNormal; mat.needsUpdate = true; } } };
    }

    const agent2transSprite = makeAgent2TransSprite();

    function makeAgent3TransSprite() {
      const mat = new THREE.SpriteMaterial({ transparent: true, opacity: 0, depthTest: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(4.2 * 1.5, 0.72 * 1.5, 1);
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
      img.src = "/Agent3trans.svg";

      return { sprite, mat };
    }

    const agent3transSprite = makeAgent3TransSprite();

    const agent3transState = {
      active: false,
      timer: 0,
      fadeDur: 0.5,
      done: false,
    };

    const AGENT3TRANS_FULL_W = 4.2 * 1.5;
    const AGENT3TRANS_FULL_H = 0.72 * 1.5;

    const agent2transState = {
      active: false,
      timer: 0,
      fadeDur: 0.5,
      done: false,
    };

    const agent2transScaleState = {
      active: false,
      timer: 0,
      dur: 0.4,
      done: false,
    };

    const AGENT2TRANS_FULL_W = 4.2 * 1.5;
    const AGENT2TRANS_FULL_H = 0.72 * 1.5;

    const agent1transState = {
      active: false,
      timer: 0,
      fadeDur: 0.5,
      done: false,
    };

    const agent1transScaleState = {
      active: false,
      timer: 0,
      dur: 0.4,
      done: false,
    };

    const agent1transScale2State = {
      active: false,
      timer: 0,
      dur: 0.4,
      done: false,
    };

    const AGENT1TRANS_FULL_W = 4.2 * 1.5;
    const AGENT1TRANS_FULL_H = 0.72 * 1.5;

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

    const AGENT_FINAL_X = -9.5, AGENT_FINAL_Y = 4.5;
    const AGENT_FINAL_SCALE = 0.5;

    const postKeyState = {
      active: false,
      timer: 0,
      phase: "idle" as "idle" | "fadeLines" | "moveAgent" | "drawLine" | "pingPong",
      fadeLinesDur: 0.5,
      moveAgentDur: 1.0,
    };

    const directSEGMENTS = 60;
    const directPts = new Float32Array((directSEGMENTS + 1) * 3);
    const directGeo = new THREE.BufferGeometry();
    directGeo.setAttribute("position", new THREE.BufferAttribute(directPts, 3));
    directGeo.setDrawRange(0, 0);
    const directMat = new THREE.LineBasicMaterial({ color: 0x888888, transparent: true, opacity: 0 });
    const directLine = new THREE.Line(directGeo, directMat);
    scene.add(directLine);

    const directLineDrawState = { timer: 0, drawDur: 0.9, done: false };

    const pingBall = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x3a3a3a, transparent: true, opacity: 0 })
    );
    pingBall.visible = false;
    scene.add(pingBall);
    const pingState = { timer: 0, speed: 3.0, forward: true };

    function getDirectCurvePoint(t: number) {
      const fromX = AGENT_FINAL_X, fromY = AGENT_FINAL_Y;
      const toX = 10.32, toY = server.group.position.y;
      const cpX = (fromX + toX) / 2;
      const cpY = Math.max(fromY, toY) + 2.5;
      const mt = 1 - t;
      return {
        x: mt * mt * fromX + 2 * mt * t * cpX + t * t * toX,
        y: mt * mt * fromY + 2 * mt * t * cpY + t * t * toY,
      };
    }

    // --- Agent-02 post-key infrastructure ---
    const AGENT2_FINAL_X = -4.7, AGENT2_FINAL_Y = 4.5;
    const AGENT2_FINAL_SCALE = 0.5;

    const agent2PostKeyState = {
      active: false,
      timer: 0,
      phase: "idle" as "idle" | "fadeLines" | "moveAgent" | "drawLine" | "pingPong",
      fadeLinesDur: 0.5,
      moveAgentDur: 1.0,
    };

    const a2DirectSEGMENTS = 60;
    const a2DirectPts = new Float32Array((a2DirectSEGMENTS + 1) * 3);
    const a2DirectGeo = new THREE.BufferGeometry();
    a2DirectGeo.setAttribute("position", new THREE.BufferAttribute(a2DirectPts, 3));
    a2DirectGeo.setDrawRange(0, 0);
    const a2DirectMat = new THREE.LineBasicMaterial({ color: 0x888888, transparent: true, opacity: 0 });
    const a2DirectLine = new THREE.Line(a2DirectGeo, a2DirectMat);
    scene.add(a2DirectLine);

    const a2DirectLineDrawState = { timer: 0, drawDur: 0.9, done: false };

    const a2PingBall = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x3a3a3a, transparent: true, opacity: 0 })
    );
    a2PingBall.visible = false;
    scene.add(a2PingBall);
    const a2PingState = { timer: 0, speed: 3.0 };

    function getAgent2DirectCurvePoint(t: number) {
      const fromX = AGENT2_FINAL_X, fromY = AGENT2_FINAL_Y;
      const toX = 10.32, toY = server.group.position.y;
      const cpX = (fromX + toX) / 2;
      const cpY = Math.max(fromY, toY) + 2.5;
      const mt = 1 - t;
      return {
        x: mt * mt * fromX + 2 * mt * t * cpX + t * t * toX,
        y: mt * mt * fromY + 2 * mt * t * cpY + t * t * toY,
      };
    }

    const agent2SpawnState = {
      active: false,
      timer: 0,
      phase: "idle" as "idle" | "delay" | "popIn" | "done",
      delayDur: 0.2,
      popInDur: 0.55,
    };

    const agent3SpawnState = {
      active: false,
      timer: 0,
      phase: "idle" as "idle" | "delay" | "popIn" | "done",
      delayDur: 0.2,
      popInDur: 0.55,
    };

    const fullResetState = {
      active: false,
      timer: 0,
      phase: "idle" as "idle" | "wait" | "fadeAll" | "pause" | "restart",
      waitDur: 3.0,
      fadeAllDur: 0.4,
      pauseDur: 0.5,
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
      const dx = (cx - drag.startX) / size.w;
      const dy = (cy - drag.startY) / size.h;
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
        if (node.type === "agent" && postKeyState.phase !== "idle") return;
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
      if (agent2.wire && agent2.group.visible) {
        agent2.wire.rotation.y += dt * 0.3;
        agent2.wire.rotation.x += dt * 0.1;
      }
      if (agent3.wire && agent3.group.visible) {
        agent3.wire.rotation.y += dt * 0.3;
        agent3.wire.rotation.x += dt * 0.1;
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

        const agentY = activeAgent.group.position.y;
        const logoY = logo.group.position.y;
        const fromX = activeAgent.group.position.x;
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
          payServerText.sprite.scale.set(payServerText.worldW * s, payServerText.worldH * s, 1);
        } else if (t < popDur + holdDur) {
          payServerText.mat.opacity = 1;
          payServerText.sprite.scale.set(payServerText.worldW, payServerText.worldH, 1);
        } else if (t < total) {
          const fadeT = (t - popDur - holdDur) / fadeDur;
          payServerText.mat.opacity = 1 - fadeT;
        }else {
          payServerState.done = true;
          payServerState.active = false;
          payServerText.sprite.visible = false;
          payServerText.mat.opacity = 0;
          if (!coinState.active && !coinState.done) {
            coinState.active = true;
            coinState.timer = 0;
            coin.group.visible = true;
            if (activeAgent === agent) {
              agent1transState.active = true;
              agent1transState.timer = 0;
              agent1transState.done = false;
              agent1transSprite.sprite.visible = true;
              agent1transSprite.mat.opacity = 0;
            } else if (activeAgent === agent2) {
              agent2transState.active = true;
              agent2transState.timer = 0;
              agent2transState.done = false;
              agent2transSprite.sprite.visible = true;
              agent2transSprite.mat.opacity = 0;
              agent1transScaleState.active = true;
              agent1transScaleState.timer = 0;
              agent1transScaleState.done = false;
              agent1transSprite.setScaledBg?.();
            } else if (activeAgent === agent3) {
              agent3transState.active = true;
              agent3transState.timer = 0;
              agent3transState.done = false;
              agent3transSprite.sprite.visible = true;
              agent3transSprite.mat.opacity = 0;
              agent2transScaleState.active = true;
              agent2transScaleState.timer = 0;
              agent2transScaleState.done = false;
              agent2transSprite.setScaledBg?.();
              agent1transScale2State.active = true;
              agent1transScale2State.timer = 0;
              agent1transScale2State.done = false;
            }
          }
        }

        payServerText.sprite.position.y = logo.group.position.y + 2.8;
      }

      // --- Agent1trans: drop from just below server (Agent-01 only) ---
      if (agent1transState.active && !agent1transState.done && activeAgent === agent) {
        agent1transState.timer += dt;
        const t = Math.min(agent1transState.timer / agent1transState.fadeDur, 1);
        const serverX = server.group.position.x;
        const serverY = server.group.position.y;
        const startY = serverY - 1.0;
        const endY = serverY - 2.25;
        const curY = startY + (endY - startY) * t;
        agent1transSprite.sprite.position.set(serverX, curY, 0.2);
        agent1transSprite.mat.opacity = t;
        if (t >= 1) agent1transState.done = true;
      }

      // --- Agent2trans: drop from just below server (Agent-02 only), above agent1trans, lower endpoint ---
      if (agent2transState.active && !agent2transState.done && activeAgent === agent2) {
        agent2transState.timer += dt;
        const t = Math.min(agent2transState.timer / agent2transState.fadeDur, 1);
        const serverX = server.group.position.x;
        const serverY = server.group.position.y;
        const startY = serverY - 1.0;
        const endY = serverY - 2.25 - 0.25;
        const curY = startY + (endY - startY) * t;
        agent2transSprite.sprite.position.set(serverX, curY, 0.3);
        agent2transSprite.mat.opacity = t;
        if (t >= 1) agent2transState.done = true;
      }

      // --- Agent3trans: drop from just below server (Agent-03 only), above agent2trans ---
      if (agent3transState.active && !agent3transState.done && activeAgent === agent3) {
        agent3transState.timer += dt;
        const t = Math.min(agent3transState.timer / agent3transState.fadeDur, 1);
        const serverX = server.group.position.x;
        const serverY = server.group.position.y;
        const startY = serverY - 1.0;
        const endY = serverY - 2.25 - 0.5;
        const curY = startY + (endY - startY) * t;
        agent3transSprite.sprite.position.set(serverX, curY, 0.4);
        agent3transSprite.mat.opacity = t;
        if (t >= 1) agent3transState.done = true;
      }

      // --- Agent1trans: smooth scale down (runs when agent2trans starts) ---
      if (agent1transScaleState.active && !agent1transScaleState.done) {
        agent1transScaleState.timer += dt;
        const t = Math.min(agent1transScaleState.timer / agent1transScaleState.dur, 1);
        const ep = easeInOut(t);
        const s = 1 - ep * 0.15;
        agent1transSprite.sprite.scale.set(AGENT1TRANS_FULL_W * s, AGENT1TRANS_FULL_H * s, 1);
        if (t >= 1) agent1transScaleState.done = true;
      }

      // --- Agent2trans: smooth scale down (runs when agent3trans starts), move up slightly ---
      if (agent2transScaleState.active && !agent2transScaleState.done) {
        agent2transScaleState.timer += dt;
        const t = Math.min(agent2transScaleState.timer / agent2transScaleState.dur, 1);
        const ep = easeInOut(t);
        const s = 1 - ep * 0.15;
        agent2transSprite.sprite.scale.set(AGENT2TRANS_FULL_W * s, AGENT2TRANS_FULL_H * s, 1);
        const serverY = server.group.position.y;
        const baseY = serverY - 2.25 - 0.25;
        const moveUp = ep * 0.0625;
        agent2transSprite.sprite.position.y = baseY + moveUp;
        if (t >= 1) agent2transScaleState.done = true;
      }

      // --- Agent1trans: further scale down by 10% (runs when agent2trans scales down) ---
      if (agent1transScale2State.active && !agent1transScale2State.done) {
        agent1transScale2State.timer += dt;
        const t = Math.min(agent1transScale2State.timer / agent1transScale2State.dur, 1);
        const ep = easeInOut(t);
        const s = 0.85 * (1 - ep * 0.15);
        agent1transSprite.sprite.scale.set(AGENT1TRANS_FULL_W * s, AGENT1TRANS_FULL_H * s, 1);
        if (t >= 1) agent1transScale2State.done = true;
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
          const agentY = activeAgent.group.position.y;
          const fromX = logo.loaded() ? logo.getHitX() : 0;
          const fromY = logoY;
          const toX = activeAgent.group.position.x;
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
            if (activeAgent === agent) {
              if (postKeyState.phase === "idle") {
                postKeyState.active = true;
                postKeyState.timer = 0;
                postKeyState.phase = "fadeLines";
              }
            } else if (activeAgent === agent2 && agent2PostKeyState.phase === "idle") {
              agent2PostKeyState.active = true;
              agent2PostKeyState.timer = 0;
              agent2PostKeyState.phase = "fadeLines";
            } else if (activeAgent === agent3) {
              fullResetState.active = true;
              fullResetState.timer = 0;
              fullResetState.phase = "wait";
            }
          }
        }
      }

      // --- Post-key: fade lines, move agent to top-left, direct curve, ping-pong ---
      if (postKeyState.active && postKeyState.phase !== "idle") {
        postKeyState.timer += dt;

        if (postKeyState.phase === "fadeLines") {
          const p = Math.min(postKeyState.timer / postKeyState.fadeLinesDur, 1);
          lineMat.opacity = 1 - p;
          returnMat.opacity = 1 - p;

          if (p >= 1) {
            lineMat.opacity = 0;
            returnMat.opacity = 0;
            lineGeo.setDrawRange(0, 0);
            returnGeo.setDrawRange(0, 0);
            postKeyState.phase = "moveAgent";
            postKeyState.timer = 0;
          }
        }

        if (postKeyState.phase === "moveAgent") {
          const p = Math.min(postKeyState.timer / postKeyState.moveAgentDur, 1);
          const ep = easeInOut(p);
          const startX = -10.32, startY = -2.5, startScale = 1;
          const curX = startX + (AGENT_FINAL_X - startX) * ep;
          const curY = startY + (AGENT_FINAL_Y - startY) * ep;
          const curScale = startScale + (AGENT_FINAL_SCALE - startScale) * ep;
          const curOp = 1 + (0.5 - 1) * ep;
          agent.group.position.set(curX, curY, 0);
          agent.group.scale.setScalar(curScale);
          setNodeOpacity(nodes[0], curOp);

          if (p >= 1) {
            agent.group.position.set(AGENT_FINAL_X, AGENT_FINAL_Y, 0);
            agent.group.scale.setScalar(AGENT_FINAL_SCALE);
            setNodeOpacity(nodes[0], 0.5);
            agent.wireMat.opacity = 0.2;
            postKeyState.phase = "drawLine";
            postKeyState.timer = 0;
            directLineDrawState.timer = 0;
            directLineDrawState.done = false;
            directMat.opacity = 0.5;
          }
        }

        if (postKeyState.phase === "drawLine") {
          directLineDrawState.timer += dt;
          const raw = Math.min(directLineDrawState.timer / directLineDrawState.drawDur, 1);
          const tipIdx = Math.floor(raw * directSEGMENTS);
          for (let i = 0; i <= tipIdx; i++) {
            const t2 = i / directSEGMENTS;
            const pt = getDirectCurvePoint(t2);
            directPts[i * 3] = pt.x;
            directPts[i * 3 + 1] = pt.y;
            directPts[i * 3 + 2] = 0;
          }
          directGeo.attributes.position.needsUpdate = true;
          directGeo.setDrawRange(0, tipIdx + 1);

          if (raw >= 1) {
            directLineDrawState.done = true;
            postKeyState.phase = "pingPong";
            postKeyState.timer = 0;
            pingState.timer = 0;
            pingState.forward = true;
            pingBall.visible = true;
            (pingBall.material as THREE.MeshBasicMaterial).opacity = 0.3;
            if (agent2SpawnState.phase === "idle") {
              agent2SpawnState.active = true;
              agent2SpawnState.timer = 0;
              agent2SpawnState.phase = "delay";
            }
          }
        }

        if (postKeyState.phase === "pingPong") {
          pingState.timer += dt;
          const raw = (pingState.timer / pingState.speed) % 2;
          const t = raw <= 1 ? raw : 2 - raw;
          const ep = easeInOut(t);
          const pt = getDirectCurvePoint(ep);
          pingBall.position.set(pt.x, pt.y, 0.1);
        }
      }

      // --- Agent-02 spawn: delay then pop in ---
      if (agent2SpawnState.active && agent2SpawnState.phase !== "done") {
        agent2SpawnState.timer += dt;

        if (agent2SpawnState.phase === "delay") {
          if (agent2SpawnState.timer >= agent2SpawnState.delayDur) {
            agent2SpawnState.phase = "popIn";
            agent2SpawnState.timer = 0;
            agent2.group.visible = true;
            agent2.group.position.set(-10.32, 0, 0);
            agent2.group.scale.setScalar(0);
            activeAgent = agent2;

            lineState.phase = "done";
            lineState.timer = 0;
            lineMat.opacity = 0;
            lineGeo.setDrawRange(0, 0);

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
            returnGeo.setDrawRange(0, 0);

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
          }
        }

        if (agent2SpawnState.phase === "popIn") {
          const raw = Math.min(agent2SpawnState.timer / agent2SpawnState.popInDur, 1);
          const scale = easeOutBack(raw);
          const op = Math.min(agent2SpawnState.timer / (agent2SpawnState.popInDur * 0.4), 1);
          agent2.group.scale.setScalar(scale);
          agent2.wireMat.opacity = op * 0.85;
          agent2.coreMat.opacity = op;
          (agent2.labelMat as THREE.SpriteMaterial).opacity = op;

          if (raw >= 1) {
            agent2.group.scale.setScalar(1);
            agent2.wireMat.opacity = 0.85;
            agent2.coreMat.opacity = 1;
            (agent2.labelMat as THREE.SpriteMaterial).opacity = 1;
            agent2SpawnState.phase = "done";

            lineState.phase = "wait";
            lineState.timer = 0;
            lineMat.opacity = 0;
          }
        }
      }

      // --- Agent-02 float ---
      if ((agent2SpawnState.phase === "popIn" || agent2SpawnState.phase === "done") && agent2PostKeyState.phase === "idle") {
        const f = floats[0];
        const y = Math.sin(clock * f.speed + f.phase + 1.5) * f.amp;
        agent2.group.position.y = y;
      }

      // --- Agent-02 post-key: fade lines, move to bottom-left, direct curve, ping-pong ---
      if (agent2PostKeyState.active && agent2PostKeyState.phase !== "idle") {
        agent2PostKeyState.timer += dt;

        if (agent2PostKeyState.phase === "fadeLines") {
          const p = Math.min(agent2PostKeyState.timer / agent2PostKeyState.fadeLinesDur, 1);
          lineMat.opacity = 1 - p;
          returnMat.opacity = 1 - p;

          if (p >= 1) {
            lineMat.opacity = 0;
            returnMat.opacity = 0;
            lineGeo.setDrawRange(0, 0);
            returnGeo.setDrawRange(0, 0);
            agent2PostKeyState.phase = "moveAgent";
            agent2PostKeyState.timer = 0;
          }
        }

        if (agent2PostKeyState.phase === "moveAgent") {
          const p = Math.min(agent2PostKeyState.timer / agent2PostKeyState.moveAgentDur, 1);
          const ep = easeInOut(p);
          const startX = -10.32, startY = -2.5, startScale = 1;
          const curX = startX + (AGENT2_FINAL_X - startX) * ep;
          const curY = startY + (AGENT2_FINAL_Y - startY) * ep;
          const curScale = startScale + (AGENT2_FINAL_SCALE - startScale) * ep;
          const curOp = 1 + (0.5 - 1) * ep;
          agent2.group.position.set(curX, curY, 0);
          agent2.group.scale.setScalar(curScale);
          agent2.wireMat.opacity = curOp * 0.85;
          agent2.coreMat.opacity = curOp;
          (agent2.labelMat as THREE.SpriteMaterial).opacity = curOp;

          if (p >= 1) {
            agent2.group.position.set(AGENT2_FINAL_X, AGENT2_FINAL_Y, 0);
            agent2.group.scale.setScalar(AGENT2_FINAL_SCALE);
            agent2.wireMat.opacity = 0.2;
            agent2.coreMat.opacity = 0.5;
            (agent2.labelMat as THREE.SpriteMaterial).opacity = 0.5;
            agent2PostKeyState.phase = "drawLine";
            agent2PostKeyState.timer = 0;
            a2DirectLineDrawState.timer = 0;
            a2DirectLineDrawState.done = false;
            a2DirectMat.opacity = 0.5;
          }
        }

        if (agent2PostKeyState.phase === "drawLine") {
          a2DirectLineDrawState.timer += dt;
          const raw = Math.min(a2DirectLineDrawState.timer / a2DirectLineDrawState.drawDur, 1);
          const tipIdx = Math.floor(raw * a2DirectSEGMENTS);
          for (let i = 0; i <= tipIdx; i++) {
            const t2 = i / a2DirectSEGMENTS;
            const pt = getAgent2DirectCurvePoint(t2);
            a2DirectPts[i * 3] = pt.x;
            a2DirectPts[i * 3 + 1] = pt.y;
            a2DirectPts[i * 3 + 2] = 0;
          }
          a2DirectGeo.attributes.position.needsUpdate = true;
          a2DirectGeo.setDrawRange(0, tipIdx + 1);

          if (raw >= 1) {
            a2DirectLineDrawState.done = true;
            agent2PostKeyState.phase = "pingPong";
            agent2PostKeyState.timer = 0;
            a2PingState.timer = 0;
            a2PingBall.visible = true;
            (a2PingBall.material as THREE.MeshBasicMaterial).opacity = 0.3;
            if (agent3SpawnState.phase === "idle") {
              agent3SpawnState.active = true;
              agent3SpawnState.timer = 0;
              agent3SpawnState.phase = "delay";
            }
          }
        }

        if (agent2PostKeyState.phase === "pingPong") {
          a2PingState.timer += dt;
          const raw = (a2PingState.timer / a2PingState.speed) % 2;
          const t = raw <= 1 ? raw : 2 - raw;
          const ep = easeInOut(t);
          const pt = getAgent2DirectCurvePoint(ep);
          a2PingBall.position.set(pt.x, pt.y, 0.1);
        }
      }

      // --- Agent-03 spawn: delay then pop in ---
      if (agent3SpawnState.active && agent3SpawnState.phase !== "done") {
        agent3SpawnState.timer += dt;

        if (agent3SpawnState.phase === "delay") {
          if (agent3SpawnState.timer >= agent3SpawnState.delayDur) {
            agent3SpawnState.phase = "popIn";
            agent3SpawnState.timer = 0;
            agent3.group.visible = true;
            agent3.group.position.set(-10.32, 0, 0);
            agent3.group.scale.setScalar(0);
            activeAgent = agent3;

            lineState.phase = "done";
            lineState.timer = 0;
            lineMat.opacity = 0;
            lineGeo.setDrawRange(0, 0);

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
            returnGeo.setDrawRange(0, 0);

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
          }
        }

        if (agent3SpawnState.phase === "popIn") {
          const raw = Math.min(agent3SpawnState.timer / agent3SpawnState.popInDur, 1);
          const scale = easeOutBack(raw);
          const op = Math.min(agent3SpawnState.timer / (agent3SpawnState.popInDur * 0.4), 1);
          agent3.group.scale.setScalar(scale);
          agent3.wireMat.opacity = op * 0.85;
          agent3.coreMat.opacity = op;
          (agent3.labelMat as THREE.SpriteMaterial).opacity = op;

          if (raw >= 1) {
            agent3.group.scale.setScalar(1);
            agent3.wireMat.opacity = 0.85;
            agent3.coreMat.opacity = 1;
            (agent3.labelMat as THREE.SpriteMaterial).opacity = 1;
            agent3SpawnState.phase = "done";

            lineState.phase = "wait";
            lineState.timer = 0;
            lineMat.opacity = 0;
          }
        }
      }

      // --- Agent-03 float ---
      if ((agent3SpawnState.phase === "popIn" || agent3SpawnState.phase === "done") && fullResetState.phase === "idle") {
        const f = floats[0];
        const y = Math.sin(clock * f.speed + f.phase + 3.0) * f.amp;
        agent3.group.position.y = y;
      }

      // --- Full reset: fade everything out and restart ---
      if (fullResetState.active && fullResetState.phase !== "idle") {
        fullResetState.timer += dt;

        if (fullResetState.phase === "wait") {
          if (fullResetState.timer >= fullResetState.waitDur) {
            fullResetState.phase = "fadeAll";
            fullResetState.timer = 0;
          }
        }

        if (fullResetState.phase === "fadeAll") {
          const p = Math.min(fullResetState.timer / fullResetState.fadeAllDur, 1);
          const op = 1 - p;

          setNodeOpacity(nodes[0], op * 0.5);
          agent.group.scale.setScalar(AGENT_FINAL_SCALE * op);
          directMat.opacity = 0.5 * op;
          (pingBall.material as THREE.MeshBasicMaterial).opacity = 0.3 * op;

          agent2.wireMat.opacity = op * 0.2;
          agent2.coreMat.opacity = op * 0.5;
          (agent2.labelMat as THREE.SpriteMaterial).opacity = op * 0.5;
          agent2.group.scale.setScalar(AGENT2_FINAL_SCALE * op);
          a2DirectMat.opacity = 0.5 * op;
          (a2PingBall.material as THREE.MeshBasicMaterial).opacity = 0.3 * op;

          agent3.wireMat.opacity = op * 0.85;
          agent3.coreMat.opacity = op;
          (agent3.labelMat as THREE.SpriteMaterial).opacity = op;
          agent3.group.scale.setScalar(op);

          setNodeOpacity(nodes[1], op);
          nodes[1].obj.group.scale.setScalar(op);

          logo.allMats.forEach((m) => {
            if ("opacity" in m) {
              (m as THREE.MeshBasicMaterial).transparent = true;
              (m as THREE.MeshBasicMaterial).opacity = op;
            }
          });
          logo.group.scale.setScalar(op);

          agent1transSprite.mat.opacity = op;
          agent2transSprite.mat.opacity = op;
          agent3transSprite.mat.opacity = op;

          lineMat.opacity = op;
          returnMat.opacity = op;

          if (p >= 1) {
            fullResetState.phase = "pause";
            fullResetState.timer = 0;
          }
        }

        if (fullResetState.phase === "pause") {
          if (fullResetState.timer >= fullResetState.pauseDur) {
            fullResetState.phase = "restart";
            fullResetState.timer = 0;

            agent.group.visible = true;
            agent.group.position.set(-10.32, -2.5, 0);
            agent.group.scale.setScalar(0);
            agent.wireMat.opacity = 0;
            agent.coreMat.opacity = 0;
            (agent.labelMat as THREE.SpriteMaterial).opacity = 0;

            agent2.group.visible = false;
            agent2.group.position.set(-10.32, -2.5, 0);
            agent2.group.scale.setScalar(0);
            agent2.wireMat.opacity = 0;
            agent2.coreMat.opacity = 0;
            (agent2.labelMat as THREE.SpriteMaterial).opacity = 0;

            agent3.group.visible = false;
            agent3.group.position.set(-10.32, -2.5, 0);
            agent3.group.scale.setScalar(0);
            agent3.wireMat.opacity = 0;
            agent3.coreMat.opacity = 0;
            (agent3.labelMat as THREE.SpriteMaterial).opacity = 0;

            server.group.position.set(10.32, -2.5, 0);
            server.group.scale.setScalar(0);
            server.mats.forEach((m) => { m.opacity = 0; });
            (server.labelMat as THREE.SpriteMaterial).opacity = 0;

            logo.group.position.set(0, -2.5, 0);
            logo.group.scale.setScalar(0);
            logo.allMats.forEach((m) => {
              if ("opacity" in m) {
                (m as THREE.MeshBasicMaterial).opacity = 0;
              }
            });

            lineMat.opacity = 0;
            lineGeo.setDrawRange(0, 0);
            returnMat.opacity = 0;
            returnGeo.setDrawRange(0, 0);

            directMat.opacity = 0;
            directGeo.setDrawRange(0, 0);
            pingBall.visible = false;
            (pingBall.material as THREE.MeshBasicMaterial).opacity = 0;

            a2DirectMat.opacity = 0;
            a2DirectGeo.setDrawRange(0, 0);
            a2PingBall.visible = false;
            (a2PingBall.material as THREE.MeshBasicMaterial).opacity = 0;

            coin.group.visible = false;
            coin.group.scale.setScalar(0);
            verifiedText.sprite.visible = false;
            verifiedText.mat.opacity = 0;
            payServerText.sprite.visible = false;
            payServerText.mat.opacity = 0;
            keySprite.sprite.visible = false;
            keySprite.mat.opacity = 0;
            ripples.forEach((r) => { r.sprite.visible = false; });

            activeAgent = agent;

            nodes[0].t = 0; nodes[0].done = false;
            nodes[1].t = 0; nodes[1].done = false;
            nodes[2].t = 0; nodes[2].done = false;

            lineState.phase = "wait";
            lineState.timer = 0;
            payServerState.active = false; payServerState.timer = 0; payServerState.done = false;
            coinState.active = false; coinState.timer = 0; coinState.done = false;
            agent1transState.active = false; agent1transState.timer = 0; agent1transState.done = false;
            agent1transScaleState.active = false; agent1transScaleState.timer = 0; agent1transScaleState.done = false;
            agent1transScale2State.active = false; agent1transScale2State.timer = 0; agent1transScale2State.done = false;
            agent1transSprite.sprite.visible = false; agent1transSprite.mat.opacity = 0;
            agent1transSprite.sprite.scale.set(AGENT1TRANS_FULL_W, AGENT1TRANS_FULL_H, 1);
            agent1transSprite.setNormalBg?.();
            agent2transState.active = false; agent2transState.timer = 0; agent2transState.done = false;
            agent2transScaleState.active = false; agent2transScaleState.timer = 0; agent2transScaleState.done = false;
            agent2transSprite.sprite.visible = false; agent2transSprite.mat.opacity = 0;
            agent2transSprite.sprite.scale.set(AGENT2TRANS_FULL_W, AGENT2TRANS_FULL_H, 1);
            agent2transSprite.setNormalBg?.();
            agent3transState.active = false; agent3transState.timer = 0; agent3transState.done = false;
            agent3transSprite.sprite.visible = false; agent3transSprite.mat.opacity = 0;
            textState.active = false; textState.timer = 0; textState.done = false;
            returnLineState.triggered = false; returnLineState.phase = "wait"; returnLineState.timer = 0;
            keyState.active = false; keyState.timer = 0; keyState.done = false;
            keyForwardState.active = false; keyForwardState.timer = 0; keyForwardState.phase = "pause";
            rippleState.active = false; rippleState.timer = 0; rippleState.triggered = false;

            postKeyState.active = false; postKeyState.timer = 0; postKeyState.phase = "idle";
            directLineDrawState.timer = 0; directLineDrawState.done = false;
            pingState.timer = 0; pingState.forward = true;

            agent2PostKeyState.active = false; agent2PostKeyState.timer = 0; agent2PostKeyState.phase = "idle";
            a2DirectLineDrawState.timer = 0; a2DirectLineDrawState.done = false;
            a2PingState.timer = 0;

            agent2SpawnState.active = false; agent2SpawnState.timer = 0; agent2SpawnState.phase = "idle";
            agent3SpawnState.active = false; agent3SpawnState.timer = 0; agent3SpawnState.phase = "idle";

            fullResetState.active = false;
            fullResetState.timer = 0;
            fullResetState.phase = "idle";
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
      ro.disconnect();
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
        width: "100%",
        maxWidth: "1280px",
        aspectRatio: "1280 / 550",
        background: "#E8E8E8",
        overflow: "hidden",
      }}
    />
  );
}
